"""Desmatamento: alertas GLAD-L (diários) e perda anual de floresta (Hansen/UMD).

Fontes (Universidade de Maryland / Global Land Analysis & Discovery, bucket público
no Google Cloud Storage, sem chave e sem depender de serviços do governo):

- Alertas GLAD-L (Landsat, 30 m, atualização diária):
  https://storage.googleapis.com/earthenginepartners-hansen/GLADalert/C2/current/
  alertYY_<tile>.tif      -> 2 = provável, 3 = confirmado
  alertDateYY_<tile>.tif  -> dia do ano da detecção
- Global Forest Change (Hansen et al., anual, 2001 em diante):
  https://storage.googleapis.com/earthenginepartners-hansen/GFC-<ano>-v1.x/
  lossyear (1..N = 2001..) e treecover2000 (limiar de 30%, como no Global Forest Watch)

Uso:
  python deforestation.py alerts                # ano atual (+ "recentes")
  python deforestation.py alerts --years 2021 2022 2023
  python deforestation.py loss                  # todos os anos da versão mais recente
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import datetime as dt
import math
import re
import shutil
import tempfile
import threading
import time
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.windows import Window

import common as C

BUCKET = "https://storage.googleapis.com/earthenginepartners-hansen"
LIST_API = "https://storage.googleapis.com/storage/v1/b/earthenginepartners-hansen/o"

GSW = "https://storage.googleapis.com/global-surface-water/downloads2021/occurrence"
MASK_VERSION = "jrc-gsw-2021-b3s10-hand8d5"  # muda isto para forçar reprocessamento
WATER_BUFFER_PX = 3   # ~90 m em volta de qualquer água já vista: sempre removido
WATER_SOFT_PX = 10    # ~300 m (várzea): só fica alerta confirmado

# Planície de inundação (várzea e igapó): a floresta alagada some e reaparece na
# imagem com a cheia e a vazante e vira falso alerta. Aqui é o que fica a até
# FP_DIST_KM de um rio largo e a até FP_HAND_M de altura acima da drenagem
# (HAND do Copernicus GLO-30, ASF/AWS Open Data). Medido em 2026: tira 60-70% dos
# alertas no Rio Negro e no Solimões e menos de 1% no arco do desmatamento.
HAND = "https://glo-30-hand.s3.amazonaws.com/v1/2021"
FP_FACTOR = 8         # máscara em 0,002 grau (~220 m)
FP_DIST_KM = 5
FP_HAND_M = 8

RECENT_DAYS = 35
RECENT_CELL = 0.02
YEAR_CELL = 0.1
LOSS_CELL = 0.05
SUMMARY_CELL = 0.25
STRIP = 2000  # linhas lidas por vez (memória)


def list_objects(prefix: str, delimiter: str | None = None):
    import requests

    items, prefixes, token = [], [], None
    while True:
        params = {"prefix": prefix, "maxResults": 1000, "fields": "items(name,size,updated),prefixes,nextPageToken"}
        if delimiter:
            params["delimiter"] = delimiter
        if token:
            params["pageToken"] = token
        r = requests.get(LIST_API, params=params, timeout=60, headers=C.UA)
        r.raise_for_status()
        d = r.json()
        items += d.get("items", [])
        prefixes += d.get("prefixes", [])
        token = d.get("nextPageToken")
        if not token:
            return items, prefixes


def tile_intersects_brasil(w, s, e, n) -> bool:
    b = C.BBOX
    return not (e <= b[0] or w >= b[2] or n <= b[1] or s >= b[3])


def _lonlat(tok: str) -> float:
    v = float(tok[:-1])
    return -v if tok[-1] in "WS" else v


def pixel_area_ha(lat, res_deg):
    m = res_deg * 111_320.0
    return (m * m) * np.cos(np.radians(lat)) / 10_000.0


def water_tile(left: int, top: int, tmp: Path, _cache={}):
    """Tile de ocorrência de água (JRC Global Surface Water 1984-2021) do mesmo
    recorte 10x10 graus dos tiles da UMD. Usado para tirar rios, lagos e áreas
    alagáveis: a água que sobe e desce engana os alertas de desmatamento."""
    lon = f"{abs(left)}{'W' if left < 0 else 'E'}"
    lat = f"{abs(top)}{'S' if top < 0 else 'N'}"
    name = f"occurrence_{lon}_{lat}v1_4_2021.tif"
    if name in _cache and Path(_cache[name]).exists():
        return _cache[name]
    try:
        p = C.download(f"{GSW}/{name}", tmp / name)
    except FileNotFoundError:
        p = None
    _cache[name] = p
    return p


def dilate(mask: np.ndarray, b: int) -> np.ndarray:
    """Dilatação quadrada separável (linhas, depois colunas)."""
    if b <= 0 or not mask.any():
        return mask
    out = mask.copy()
    for d in range(1, b + 1):
        out[d:] |= mask[:-d]
        out[:-d] |= mask[d:]
    rows = out.copy()
    for d in range(1, b + 1):
        out[:, d:] |= rows[:, :-d]
        out[:, :-d] |= rows[:, d:]
    return out


def water_mask(occ: np.ndarray, b: int = WATER_BUFFER_PX) -> np.ndarray:
    """Pixel que já teve água alguma vez (1..100), com margem de b pixels."""
    return dilate((occ > 0) & (occ <= 100), b)


def glad_valid(a: dict) -> np.ndarray:
    ok = (a["a"] >= 2) & (a["d"] > 0)
    if "fp" in a:
        ok &= ~a["fp"]
    if "w" not in a or not ok.any():
        return ok
    water = (a["w"] > 0) & (a["w"] <= 100)
    near = dilate(water, WATER_BUFFER_PX)
    varzea = dilate(water, WATER_SOFT_PX)
    return ok & ~near & ((a["a"] == 3) | ~varzea)


_fp_lock = threading.Lock()
_fp_mem: dict = {}


def floodplain(left: int, top: int, water_path) -> np.ndarray | None:
    """Máscara (5000 x 5000) da planície de inundação do tile 10x10 (canto sup. esquerdo)."""
    key = (left, top)
    with _fp_lock:
        if key in _fp_mem:
            return _fp_mem[key]
        n = 40000 // FP_FACTOR
        cache = C.DATA_DIR / "_cache" / "floodplain" / f"{MASK_VERSION}_{left}_{top}.npz"
        if cache.exists():
            m = np.unpackbits(np.load(cache)["m"])[: n * n].reshape(n, n).astype(bool)
        else:
            m = _build_floodplain(left, top, water_path, n)
            cache.parent.mkdir(parents=True, exist_ok=True)
            np.savez_compressed(cache, m=np.packbits(m))
        _fp_mem[key] = m
        print(f"  várzea {left},{top}: {100 * m.mean():.1f}% do tile")
        return m


def _build_floodplain(left, top, water_path, n):
    from scipy import ndimage as ndi
    f = FP_FACTOR
    frac = np.zeros((n, n), dtype=np.float32)
    if water_path:
        with rasterio.open(water_path) as src:
            for r0 in range(0, 40000, STRIP):
                a = src.read(1, window=Window(0, r0, 40000, STRIP))
                ever = ((a > 0) & (a <= 100)).astype(np.float32)
                frac[r0 // f:(r0 + STRIP) // f] = ever.reshape(STRIP // f, f, n, f).mean((1, 3))
    wide = ndi.binary_opening(frac >= 0.5, iterations=1)  # canais com mais de ~500 m
    if not wide.any():
        return np.zeros((n, n), dtype=bool)
    km = 10 / n * 111.0
    near = ndi.distance_transform_edt(~wide) * km <= FP_DIST_KM
    hand = np.full((n, n), 999, dtype=np.float32)
    per = n // 10
    env = rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif")
    with env:
        for i in range(10):          # linhas de 1 grau, de cima para baixo
            for j in range(10):
                blk = (slice(i * per, (i + 1) * per), slice(j * per, (j + 1) * per))
                if not near[blk].any():
                    continue
                la, lo = top - i - 1, left + j
                name = (f"Copernicus_DSM_COG_10_{'S' if la < 0 else 'N'}{abs(la):02d}_00_"
                        f"{'W' if lo < 0 else 'E'}{abs(lo):03d}_00_HAND.tif")
                for attempt in range(3):
                    try:
                        with rasterio.open(f"/vsicurl/{HAND}/{name}") as h:
                            hand[blk] = h.read(1, out_shape=(per, per), resampling=Resampling.average)
                        break
                    except rasterio.errors.RasterioIOError as e:
                        if "404" in str(e) or "does not exist" in str(e) or attempt == 2:
                            break
                        time.sleep(3 * (attempt + 1))
    return near & (hand <= FP_HAND_M)


def fp_strip(fp, r0: int, nrows: int) -> np.ndarray:
    f = FP_FACTOR
    s = fp[r0 // f:(r0 + nrows + f - 1) // f]
    return np.repeat(np.repeat(s, f, 0), f, 1)[:nrows]


def raster_cells(paths: dict, cell: float, value_fn, time_fn, extra=None):
    """Varre um tile em faixas e devolve linhas (x, y, t, área_ha) agregadas.

    value_fn(arrays) -> máscara booleana dos pixels de interesse
    time_fn(arrays, mask) -> array de tempos para esses pixels
    """
    srcs = {k: rasterio.open(p) for k, p in paths.items()}
    first = next(iter(srcs.values()))
    tr = first.transform
    res = tr.a
    left, top = tr.c, tr.f
    h, w = first.height, first.width
    parts = []
    try:
        for r0 in range(0, h, STRIP):
            nrows = min(STRIP, h - r0)
            win = Window(0, r0, w, nrows)
            arrs = {k: s.read(1, window=win) for k, s in srcs.items()}
            if extra is not None:
                arrs.update(extra(r0, nrows))
            mask = value_fn(arrs)
            if not mask.any():
                continue
            rr, cc = np.nonzero(mask)
            t = time_fn(arrs, (rr, cc))
            lat = top - (r0 + rr + 0.5) * res
            lon = left + (cc + 0.5) * res
            area = pixel_area_ha(lat, res)
            x = np.floor((lon - C.ORIGIN[0]) / cell).astype(np.int64)
            y = np.floor((lat - C.ORIGIN[1]) / cell).astype(np.int64)
            parts.append(C.aggregate_xyt(x, y, t, area))
            del arrs, mask, rr, cc
    finally:
        for s in srcs.values():
            s.close()
    if not parts:
        return np.zeros((0, 4))
    allr = np.vstack(parts)
    return C.aggregate_xyt(allr[:, 0], allr[:, 1], allr[:, 2], allr[:, 3])


def gfc_blocks(paths: dict, cell: float, threshold: int, fp=None):
    """Como raster_cells, mas para o GFC (todos os pixels de floresta), por blocos.

    Os tiles de 10 graus caem exatamente na grade, então cada célula é um bloco
    de n x n pixels; conta por (célula, ano da perda) num bincount só. Ano 0 =
    floresta ainda de pé.
    """
    srcs = {k: rasterio.open(p) for k, p in paths.items()}
    first = next(iter(srcs.values()))
    tr = first.transform
    res = tr.a
    left, top = tr.c, tr.f
    h, w = first.height, first.width
    n = int(round(cell / res))
    strip = n * max(1, STRIP // n)
    x0 = int(round((left - C.ORIGIN[0]) / cell))
    y_top = int(round((top - C.ORIGIN[1]) / cell))
    ncx = w // n
    parts = []
    try:
        for r0 in range(0, h, strip):
            nrows = min(strip, h - r0)
            win = Window(0, r0, w, nrows)
            a = {k: s.read(1, window=win) for k, s in srcs.items()}
            ok = a["t"] >= threshold
            if "w" in a:
                ok &= ~water_mask(a["w"])
            if fp is not None:
                ok &= ~fp_strip(fp, r0, nrows)
            if not ok.any():
                continue
            code = np.where(ok, a["l"].astype(np.int32) + 1, 0)  # 0 = fora; 1 = de pé; k+1 = perda em 2000+k
            ncy = nrows // n
            cy = np.arange(ncy * n, dtype=np.int32)[:, None] // n
            cx = np.arange(ncx * n, dtype=np.int32)[None, :] // n
            key = ((cy * ncx + cx) * 64 + code[: ncy * n, : ncx * n]).ravel()
            cnt = np.bincount(key, minlength=ncy * ncx * 64).reshape(ncy, ncx, 64)
            cnt[:, :, 0] = 0
            iy, ix, ic = np.nonzero(cnt)
            lat = top - (r0 + (iy + 0.5) * n) * res
            area = cnt[iy, ix, ic] * pixel_area_ha(lat, res)
            yrs = np.where(ic == 1, 0, ic - 1 + 2000)
            gy = y_top - 1 - (r0 // n + iy)
            parts.append(np.column_stack([x0 + ix, gy, yrs, area]))
            del a, ok, code, key
    finally:
        for s in srcs.values():
            s.close()
    if not parts:
        return np.zeros((0, 4))
    return np.vstack(parts)


def keep_brasil(rows, cell, _cache={}):
    if rows.size == 0:
        return rows
    if cell not in _cache:
        _cache[cell] = C.cell_mask(cell)[0]
    m = _cache[cell]
    x = rows[:, 0].astype(np.int64)
    y = rows[:, 1].astype(np.int64)
    ok = (x >= 0) & (y >= 0) & (y < m.shape[0]) & (x < m.shape[1])
    ok[ok] = m[y[ok], x[ok]]
    return rows[ok]


# ================================================================ GLAD-L alertas

def glad_tiles(yy: int):
    items, _ = list_objects(f"GLADalert/C2/current/alert{yy:02d}_")
    out = []
    for it in items:
        name = it["name"].split("/")[-1]
        m = re.match(r"alert(\d\d)_(\d{3}[EW])_(\d\d[NS])_(\d{3}[EW])_(\d\d[NS])\.tif$", name)
        if not m:
            continue
        w, s, e, n = _lonlat(m[2]), _lonlat(m[3]), _lonlat(m[4]), _lonlat(m[5])
        if tile_intersects_brasil(w, s, e, n):
            tile = "_".join(m.groups()[1:])
            out.append(tile)
    return sorted(set(out))


def process_glad_tile(year: int, tile: str, tmp: Path):
    yy = year % 100
    base = f"{BUCKET}/GLADalert/C2/current"
    pa = C.download(f"{base}/alert{yy:02d}_{tile}.tif", tmp / f"a{yy}_{tile}.tif")
    pd = C.download(f"{base}/alertDate{yy:02d}_{tile}.tif", tmp / f"d{yy}_{tile}.tif")
    jan1 = C.day_number(dt.date(year, 1, 1))
    m = re.match(r"(\d{3}[EW])_(\d\d[NS])_(\d{3}[EW])_(\d\d[NS])", tile)
    left, top = int(_lonlat(m[1])), int(_lonlat(m[4]))
    wt = water_tile(left, top, tmp)
    fp = floodplain(left, top, wt)
    paths = {"a": pa, "d": pd}
    if wt:
        paths["w"] = wt
    try:
        rows = raster_cells(
            paths,
            RECENT_CELL,
            glad_valid,
            lambda a, idx: a["d"][idx].astype(np.int64) - 1 + jan1,
            extra=lambda r0, n: {"fp": fp_strip(fp, r0, n)},
        )
    finally:
        pa.unlink(missing_ok=True)
        pd.unlink(missing_ok=True)
    print(f"  GLAD {year} {tile}: {len(rows)} células-dia")
    return rows


def glad_year(year: int, workers: int = 3):
    """Linhas (x, y, dia, ha) na grade fina (0,01°) para o ano inteiro."""
    yy = year % 100
    tiles = glad_tiles(yy)
    print(f"GLAD-L {year}: {len(tiles)} tiles sobre o Brasil")
    tmp = Path(tempfile.mkdtemp(prefix="glad"))
    parts = []
    try:
        with cf.ThreadPoolExecutor(workers) as ex:
            futs = [ex.submit(process_glad_tile, year, t, tmp) for t in tiles]
            for f in cf.as_completed(futs):
                parts.append(f.result())
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    parts = [p for p in parts if p.size]
    if not parts:
        return np.zeros((0, 4))
    allr = np.vstack(parts)
    allr = C.aggregate_xyt(allr[:, 0], allr[:, 1], allr[:, 2], allr[:, 3])
    return keep_brasil(allr, RECENT_CELL)


def glad_update_info():
    try:
        txt = C.get_text(f"{BUCKET}/GLADalert/C2/current/0_GLADalert_update_date.txt")
        for line in txt.splitlines():
            if line.startswith("SA"):
                return line.strip()
    except Exception as e:  # noqa: BLE001
        print("  ! sem data de atualização GLAD:", e)
    return None


def run_alerts(years: list[int]):
    out = C.DATA_DIR / "deforestation"
    today = dt.date.today()
    recent_from = C.day_number(today) - RECENT_DAYS
    recent_rows = []
    totals = {}
    for year in years:
        rows = glad_year(year)
        totals[year] = rows[:, 3].sum() if rows.size else 0
        factor = int(round(YEAR_CELL / RECENT_CELL))
        monthly = C.coarsen(rows, factor, C.day_to_month)
        C.write_cells(out / "alerts" / f"{year}.json", layer="deforestation", kind="alertas GLAD-L",
                      source="UMD GLAD Landsat alerts", cell=YEAR_CELL, time_unit="month",
                      value="ha", rows=monthly, value_decimals=1, extra={"year": year})
        if rows.size:
            recent_rows.append(rows[rows[:, 2] >= recent_from])
    # "recentes": também precisa do ano anterior quando a janela cruza a virada de ano
    if dt.date.fromordinal(today.toordinal() - RECENT_DAYS).year < today.year and (today.year - 1) not in years:
        prev = C.read_json(out / "alerts" / "recent.json")
        if prev:
            old = C.rows_from_flat(prev["data"])
            recent_rows.append(old[(old[:, 2] >= recent_from) & (old[:, 2] < C.day_number(dt.date(today.year, 1, 1)))])
    if today.year in years or not (out / "alerts" / "recent.json").exists():
        rr = np.vstack(recent_rows) if recent_rows else np.zeros((0, 4))
        last = int(rr[:, 2].max()) if rr.size else None
        C.write_cells(out / "alerts" / "recent.json", layer="deforestation", kind="alertas GLAD-L (recentes)",
                      source="UMD GLAD Landsat alerts", cell=RECENT_CELL, time_unit="day", value="ha",
                      rows=rr, value_decimals=2,
                      extra={"last_day": last, "upstream": glad_update_info()})
    man = C.read_json(C.DATA_DIR / "manifest.json", {}) or {}
    have = set(man.get("layers", {}).get("deforestation", {}).get("alert_years", []))
    have |= set(years)
    C.update_manifest("deforestation", {"alert_years": sorted(have), "alerts_updated": C.now_iso(),
                                        "alerts_mask": MASK_VERSION})
    C.update_stats("deforestation", "alertas_glad_ha", totals)


# ================================================================ Hansen GFC

def latest_gfc():
    _, prefixes = list_objects("GFC-", delimiter="/")
    best = None
    for p in prefixes:
        m = re.match(r"GFC-(\d{4})-v1\.(\d+)/", p)
        if m:
            k = (int(m[1]), int(m[2]))
            if best is None or k > best[0]:
                best = (k, p.rstrip("/"))
    if not best:
        raise RuntimeError("versão GFC não encontrada")
    return best[1], best[0][0]


def gfc_tiles():
    tiles = []
    for top in range(10, -40, -10):
        for left in range(-80, -30, 10):
            if tile_intersects_brasil(left, top - 10, left + 10, top):
                lat = f"{abs(top):02d}{'N' if top >= 0 else 'S'}"
                lon = f"{abs(left):03d}{'W' if left < 0 else 'E'}"
                tiles.append(f"{lat}_{lon}")
    return tiles


def process_gfc_tile(version: str, tile: str, tmp: Path, threshold: int):
    base = f"{BUCKET}/{version}/Hansen_{version}"
    try:
        pl = C.download(f"{base}_lossyear_{tile}.tif", tmp / f"ly_{tile}.tif")
    except FileNotFoundError:
        print(f"  (sem tile {tile})")
        return np.zeros((0, 4))
    pt = C.download(f"{base}_treecover2000_{tile}.tif", tmp / f"tc_{tile}.tif")
    lat_s, lon_s = tile.split("_")
    left, top = int(_lonlat(lon_s)), int(_lonlat(lat_s))
    wt = water_tile(left, top, tmp)
    fp = floodplain(left, top, wt)
    paths = {"l": pl, "t": pt}
    if wt:
        paths["w"] = wt
    try:
        rows = gfc_blocks(paths, LOSS_CELL, threshold, fp)
    finally:
        pl.unlink(missing_ok=True)
        pt.unlink(missing_ok=True)
    print(f"  GFC {tile}: {len(rows)} células-ano")
    return rows


def run_loss(threshold: int = 30, workers: int = 2):
    version, last_year = latest_gfc()
    man = C.read_json(C.DATA_DIR / "manifest.json", {}) or {}
    dl = man.get("layers", {}).get("deforestation", {})
    if dl.get("loss_version") == version and dl.get("loss_mask") == MASK_VERSION and not FORCE:
        print(f"GFC {version} já processado; nada a fazer (use --force)")
        return
    tiles = gfc_tiles()
    print(f"Hansen {version}: {len(tiles)} tiles")
    tmp = Path(tempfile.mkdtemp(prefix="gfc"))
    parts = []
    try:
        with cf.ThreadPoolExecutor(workers) as ex:
            for r in ex.map(lambda t: process_gfc_tile(version, t, tmp, threshold), tiles):
                if r.size:
                    parts.append(r)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    allr = np.vstack(parts)
    allr = C.aggregate_xyt(allr[:, 0], allr[:, 1], allr[:, 2], allr[:, 3])
    allr = keep_brasil(allr, LOSS_CELL)
    out = C.DATA_DIR / "deforestation" / "loss"
    standing = allr[allr[:, 2] == 0]
    allr = allr[allr[:, 2] > 0]
    standing[:, 2] = last_year
    C.write_cells(C.DATA_DIR / "deforestation" / "forest.json", layer="deforestation",
                  kind="floresta remanescente (cobertura 2000 sem perda)", source=f"UMD Hansen {version}",
                  cell=LOSS_CELL, time_unit="year", value="ha", rows=standing,
                  extra={"year": last_year, "treecover_threshold": threshold})
    years = sorted(int(y) for y in np.unique(allr[:, 2]))
    totals = {}
    for y in years:
        sel = allr[allr[:, 2] == y]
        totals[y] = sel[:, 3].sum()
        C.write_cells(out / f"{y}.json", layer="deforestation", kind="perda de floresta (Hansen GFC)",
                      source=f"UMD Hansen {version}", cell=LOSS_CELL, time_unit="year", value="ha",
                      rows=sel, value_decimals=0, extra={"year": y, "treecover_threshold": threshold})
    summ = C.coarsen(allr, int(round(SUMMARY_CELL / LOSS_CELL)))
    C.write_cells(out / "summary.json", layer="deforestation", kind="perda de floresta (resumo)",
                  source=f"UMD Hansen {version}", cell=SUMMARY_CELL, time_unit="year", value="ha",
                  rows=summ, extra={"treecover_threshold": threshold})
    C.update_manifest("deforestation", {"loss_years": years, "loss_version": version, "loss_mask": MASK_VERSION,
                                       "loss_updated": C.now_iso()})
    C.update_stats("deforestation", "perda_hansen_ha", totals)


FORCE = False

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["alerts", "loss"])
    ap.add_argument("--years", type=int, nargs="*")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--missing", action="store_true", help="ano atual + anos de alerta que faltam (2021+)")
    a = ap.parse_args()
    FORCE = a.force
    if a.what == "alerts":
        today = dt.date.today()
        years = a.years or [today.year]
        if a.missing and not a.years:
            dl = (C.read_json(C.DATA_DIR / "manifest.json", {}) or {}).get("layers", {}).get("deforestation", {})
            have = set(dl.get("alert_years", [])) if dl.get("alerts_mask") == MASK_VERSION else set()
            years = sorted({today.year} | {y for y in range(2021, today.year) if y not in have})
            # em janeiro o ano anterior ainda recebe alertas atrasados
            if today.month == 1:
                years = sorted(set(years) | {today.year - 1})
        print("anos de alertas:", years)
        run_alerts(years)
    else:
        run_loss()
