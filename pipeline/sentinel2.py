"""Acesso ao Sentinel-2 L2A (COGs públicos na AWS, sem chave) e o detector de pistas.

As cenas ficam em https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/
organizadas por quadrícula MGRS/ano/mês. Só lemos janelas pequenas (~2 km) de cada
cena, então não é preciso baixar a imagem inteira.

Detector: uma pista de pouso aparece no NDVI como uma faixa reta, estreita
(10-40 m) e longa (300-2000 m) de solo exposto ou capim, com vegetação dos dois
lados. Um filtro de linha orientado mede, para cada ângulo, o contraste entre os
lados (o menor dos dois) e o centro, ao longo de 400 m. Bordas de garimpo e de
pasto têm vegetação de um lado só e ficam de fora; estradas e rios continuam
além da janela ou são água (classe 6 da SCL) e também são descartados.
"""
from __future__ import annotations

import os
import re
import threading

import numpy as np
import requests
from scipy import ndimage as ndi

BUCKET = "https://sentinel-cogs.s3.us-west-2.amazonaws.com"
PREFIX = "sentinel-s2-l2a-cogs"
FIRST_YEAR = 2017

os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif")
os.environ.setdefault("GDAL_HTTP_MULTIRANGE", "YES")
os.environ.setdefault("GDAL_HTTP_MERGE_CONSECUTIVE_RANGES", "YES")
os.environ.setdefault("GDAL_HTTP_MAX_RETRY", "4")
os.environ.setdefault("GDAL_HTTP_RETRY_DELAY", "2")
os.environ.setdefault("VSI_CACHE", "TRUE")

PX = 10.0               # metros por pixel (bandas de 10 m)
HALF = 1000.0           # meia janela em metros (janela de 2 km)
N = int(2 * HALF / PX)  # 200 px
CLOUDY = (0, 1, 3, 8, 9, 10)   # SCL: sem dado, saturado, sombra, nuvem média/alta, cirrus
WATER = 6

L_PX = 40               # comprimento do filtro: 400 m
STEP = 5                # graus

_local = threading.local()


def _session():
    s = getattr(_local, "s", None)
    if s is None:
        s = _local.s = requests.Session()
    return s


def tile_of(lat: float, lon: float) -> str:
    """Quadrícula MGRS da cena (ex.: 20NMH)."""
    import mgrs
    m = getattr(_local, "mgrs", None)
    if m is None:
        m = _local.mgrs = mgrs.MGRS()
    return m.toMGRS(lat, lon, MGRSPrecision=0)


def _s3_list(prefix: str):
    out, token = [], None
    while True:
        p = {"list-type": "2", "prefix": prefix, "delimiter": "/"}
        if token:
            p["continuation-token"] = token
        for i in range(4):
            try:
                r = _session().get(BUCKET + "/", params=p, timeout=60)
                r.raise_for_status()
                break
            except Exception:  # noqa: BLE001
                if i == 3:
                    raise
        t = r.text
        out += [x for x in re.findall(r"<Prefix>([^<]+)</Prefix>", t) if x != prefix]
        m = re.search(r"<NextContinuationToken>([^<]+)<", t)
        if not m:
            return out
        token = m[1]


STAC = "https://earth-search.aws.element84.com/v1/search"


def _stac_scenes(tile: str, year: int):
    """Mesma lista pelo catálogo STAC da Element 84 (uma consulta por quadrícula e ano)."""
    body = {"collections": ["sentinel-2-l2a"], "limit": 200,
            "datetime": f"{year}-01-01T00:00:00Z/{year}-12-31T23:59:59Z",
            "query": {"grid:code": {"eq": f"MGRS-{tile}"}},
            "fields": {"include": ["properties.eo:cloud_cover", "properties.s2:nodata_pixel_percentage",
                                   "properties.datetime", "assets.red.href"], "exclude": ["geometry", "links"]}}
    res, url = [], STAC
    while url:
        r = _session().post(url, json=body, timeout=90)
        r.raise_for_status()
        doc = r.json()
        for it in doc.get("features", []):
            href = (it.get("assets", {}).get("red") or {}).get("href", "")
            m = re.search(r"(sentinel-s2-l2a-cogs/.+/)B04\.tif$", href)
            if not m:
                continue
            p = it["properties"]
            res.append((round(p.get("eo:cloud_cover", 100), 1), round(p.get("s2:nodata_pixel_percentage", 100), 1),
                        p["datetime"][:10], m[1]))
        nxt = next((ln for ln in doc.get("links", []) if ln.get("rel") == "next"), None)
        url = nxt["href"] if nxt else None
        if nxt and nxt.get("body"):
            body = nxt["body"]
    return res


def list_scenes(tile: str, year: int):
    """[(nuvem %, sem dado %, data, prefixo)] das cenas do ano, menos nubladas primeiro.

    Tenta o catálogo STAC (rápido); se falhar, lista o bucket e lê o JSON de cada cena."""
    try:
        res = _stac_scenes(tile, year)
        if res:
            return sorted(set(res))
    except Exception:  # noqa: BLE001
        pass
    z, b, sq = tile[:-3], tile[-3], tile[-2:]
    res = []
    for mon in range(1, 13):
        for pre in _s3_list(f"{PREFIX}/{z}/{b}/{sq}/{year}/{mon}/"):
            sid = pre.rstrip("/").split("/")[-1]
            try:
                p = _session().get(f"{BUCKET}/{pre}{sid}.json", timeout=60).json()["properties"]
            except Exception:  # noqa: BLE001
                continue
            res.append((round(p.get("eo:cloud_cover", 100), 1), round(p.get("s2:nodata_pixel_percentage", 100), 1),
                        p["datetime"][:10], pre))
    return sorted(res)


def utm_xy(tile: str, lon: float, lat: float):
    from pyproj import Transformer
    zone = int(tile[:-3])
    north = tile[-3] >= "N"
    epsg = (32600 if north else 32700) + zone
    key = f"tr{epsg}"
    tr = getattr(_local, key, None)
    if tr is None:
        tr = Transformer.from_crs("EPSG:4326", f"EPSG:{epsg}", always_xy=True)
        setattr(_local, key, tr)
    x, y = tr.transform(lon, lat)
    return epsg, x, y


def to_lonlat(epsg: int, x, y):
    from pyproj import Transformer
    tr = Transformer.from_crs(f"EPSG:{epsg}", "EPSG:4326", always_xy=True)
    return tr.transform(x, y)


def window_origin(tile, lon, lat):
    """Canto superior esquerdo (UTM) da janela, alinhado à grade de 20 m da cena."""
    epsg, x, y = utm_xy(tile, lon, lat)
    x0 = round((x - HALF) / 20) * 20
    y1 = round((y + HALF) / 20) * 20
    return epsg, x0, y1


def read_band(pre, band, x0, y1, res=PX):
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.windows import from_bounds
    with rasterio.open(f"/vsicurl/{BUCKET}/{pre}{band}.tif") as ds:
        win = from_bounds(x0, y1 - 2 * HALF, x0 + 2 * HALF, y1, ds.transform)
        return ds.read(1, window=win, boundless=True, fill_value=0, out_shape=(N, N),
                       resampling=Resampling.nearest)


def scene_ndvi(pre, x0, y1, max_bad=0.15, core=None):
    """NDVI da janela numa cena, ou None se a imagem estiver ruim (nuvem, sombra, sem dado).

    `core` (máscara booleana) restringe a checagem de nuvem à área que interessa
    (o eixo da pista e as laterais)."""
    scl = read_band(pre, "SCL", x0, y1)
    bad = np.isin(scl, CLOUDY)
    frac = bad[core].mean() if core is not None else bad.mean()
    if frac > max_bad:
        return None
    r = read_band(pre, "B04", x0, y1).astype("f4")
    n = read_band(pre, "B08", x0, y1).astype("f4")
    v = (n - r) / np.maximum(n + r, 1)
    v[bad | (n + r == 0)] = np.nan
    return v, scl == WATER


# ------------------------------------------------------------------ geometria do filtro

def _rot(a, th, order=1):
    return ndi.rotate(a, th, reshape=False, order=order, mode="nearest")


SCALES = ((0, 2, 4), (1, 3, 5), (2, 4, 7), (3, 5, 9))   # (meia largura do eixo, início e fim da lateral), em px


def _contrast(m, hw, s0, s1):
    """min(lateral de cima, lateral de baixo) - eixo, para cada linha da imagem girada."""
    c = ndi.uniform_filter1d(m, 2 * hw + 1, axis=0)
    sb = ndi.uniform_filter1d(m, s1 - s0 + 1, axis=0)
    off = (s0 + s1) // 2
    return np.minimum(np.roll(sb, off, 0), np.roll(sb, -off, 0)) - c


def line_response(v, search=None):
    """Melhor faixa reta: (contraste, ângulo, linha, coluna, escala) no espaço girado."""
    fill = np.nanmedian(v)
    vf = np.where(np.isnan(v), fill, v)
    h, w = vf.shape
    cy, cx = h // 2, w // 2
    r = search or (h // 2 - 12)
    best = (-9.0, 0, 0, 0, 0)
    for th in range(0, 180, STEP):
        m = ndi.uniform_filter1d(_rot(vf, th), L_PX, axis=1)
        for k, sc in enumerate(SCALES):
            con = _contrast(m, *sc)
            sub = con[cy - r:cy + r, cx - r:cx + r]
            i = np.unravel_index(np.argmax(sub), sub.shape)
            if sub[i] > best[0]:
                best = (float(sub[i]), th, int(i[0] + cy - r), int(i[1] + cx - r), k)
    return best


def axis_profile(v, th, y, k=1, sm=5):
    """Contraste, NDVI no eixo e NDVI nas laterais, pixel a pixel ao longo do eixo."""
    fill = np.nanmedian(v)
    vf = np.where(np.isnan(v), fill, v)
    m = ndi.uniform_filter1d(_rot(vf, th), sm, axis=1)
    hw, s0, s1 = SCALES[k]
    c = m[y - hw:y + hw + 1].mean(0)
    s = np.minimum(m[y - s1:y - s0 + 1].mean(0), m[y + s0:y + s1 + 1].mean(0))
    return s - c, c, s


def extent(con, x, thr=0.12, gap=3):
    """Trecho contínuo (com falhas de até `gap` px) em volta de x onde o contraste passa de thr."""
    n = len(con)
    a = b = x
    g = 0
    while a > 0 and g <= gap:
        a -= 1
        g = g + 1 if con[a] < thr else 0
    a += g
    g = 0
    while b < n - 1 and g <= gap:
        b += 1
        g = g + 1 if con[b] < thr else 0
    b -= g
    return a, b


def unrotate(th, y, x, n=N):
    """Ponto do espaço girado -> pixel (coluna, linha) da janela original."""
    c = (n - 1) / 2
    t = np.radians(th)
    dx, dy = x - c, y - c
    return c + dx * np.cos(t) - dy * np.sin(t), c + dx * np.sin(t) + dy * np.cos(t)


def footprint(th, y, a, b, pad=10, n=N):
    """Máscara (na janela original) do eixo da pista com as laterais."""
    m = np.zeros((n, n), bool)
    m[max(0, y - pad):y + pad + 1, max(0, a):b + 1] = True
    return _rot(m.astype("f4"), -th, order=0) > 0.5

