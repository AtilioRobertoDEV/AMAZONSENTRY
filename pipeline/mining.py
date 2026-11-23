"""Garimpo: detecções do Amazon Mining Watch (Earth Genome / Pulitzer Center / ACA).

Fonte: https://data.source.coop/earthgenome/amazon-mining-watch/amazon_basin_detections.geojson
(CC BY 4.0). Uma linha por local, com o período em que o garimpo foi confirmado
("onset": ano, ou ano*10+trimestre para o período provisório mais recente) e o
status (confirmado / provisório). Cobertura: bacia amazônica, de 2018 em diante.

Saída: mining/detections.json com um ponto por detecção:
  [lon*1000, lat*1000, periodo, status, area_ha]
  periodo = ano*10 + trimestre (0 = ano inteiro)
  status  = 1 confirmado, 0 provisório
"""
from __future__ import annotations

import datetime as dt
import json
import re
import shutil
import tempfile
from collections import Counter
from pathlib import Path

import numpy as np

import common as C

URL = "https://data.source.coop/earthgenome/amazon-mining-watch/amazon_basin_detections.geojson"


def parse_period(v):
    """Converte o valor de onset em ano*10+trimestre."""
    if v is None:
        return None
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    if isinstance(v, int):
        if 2000 <= v <= 2100:
            return v * 10
        if 20000 <= v <= 21004:
            return v
        return None
    s = str(v).strip()
    m = re.fullmatch(r"(?:Q|q)([1-4])(\d\d)", s)  # Q125
    if m:
        return (2000 + int(m[2])) * 10 + int(m[1])
    m = re.fullmatch(r"(\d{4})[-_ ]?Q([1-4])", s, re.I)  # 2025Q1
    if m:
        return int(m[1]) * 10 + int(m[2])
    m = re.fullmatch(r"(\d{4})([1-4])", s)  # 20251
    if m:
        return int(m[1]) * 10 + int(m[2])
    m = re.match(r"(\d{4})", s)
    if m and 2000 <= int(m[1]) <= 2100:
        return int(m[1]) * 10
    return None


def pick_key(props_list, candidates):
    keys = Counter(k for p in props_list for k in p)
    for c in candidates:
        for k in keys:
            if k.lower() == c:
                return k
    for c in candidates:
        for k in keys:
            if c in k.lower():
                return k
    return None


# ------------------------------------------------------------------ checagem no chão
# O detector do Amazon Mining Watch às vezes marca banco de areia e praia de rio
# como garimpo. Cada detecção é conferida com dados independentes: só fica se,
# FORA do leito do rio (água vista pelo JRC 1984-2021, com 30 m de margem),
# houver floresta perdida (Hansen), alerta GLAD recente ou terra aberta.
CHECK_VERSION = "v3-loss3-glad3-open5-rio20"
MIN_LOSS = 0.03
MIN_GLAD = 0.03
MIN_OPEN = 0.05
MIN_OPEN_RIO = 0.20


def _tile_of(lon, lat):
    left = int(np.floor(lon / 10) * 10)
    top = int(np.floor(lat / 10) * 10) + 10
    return left, top


def ground_check(geoms, idx, tmp: Path):
    """Devolve {i: (fica, motivo)} para as detecções idx (índices em geoms)."""
    import rasterio
    from rasterio.features import geometry_mask
    from rasterio.windows import from_bounds
    from scipy import ndimage as ndi
    import deforestation as D

    version, _ = D.latest_gfc()
    year = dt.date.today().year
    by_tile: dict = {}
    for i in idx:
        c = geoms[i].centroid
        by_tile.setdefault(_tile_of(c.x, c.y), []).append(i)
    out = {}
    for (left, top), items in sorted(by_tile.items()):
        lon_s = f"{abs(left):03d}{'W' if left < 0 else 'E'}"
        lat_s = f"{abs(top):02d}{'S' if top < 0 else 'N'}"
        base = f"{D.BUCKET}/{version}/Hansen_{version}"
        try:
            pl = C.download(f"{base}_lossyear_{lat_s}_{lon_s}.tif", tmp / "ly.tif")
            pt = C.download(f"{base}_treecover2000_{lat_s}_{lon_s}.tif", tmp / "tc.tif")
        except FileNotFoundError:
            for i in items:
                out[i] = (True, "sem dados")
            continue
        pw = D.water_tile(left, top, tmp)
        glad = []
        gname = (f"{abs(left):03d}{'W' if left < 0 else 'E'}_{abs(top - 10):02d}{'S' if top - 10 < 0 else 'N'}_"
                 f"{abs(left + 10):03d}{'W' if left + 10 < 0 else 'E'}_{abs(top):02d}{'S' if top < 0 else 'N'}")
        for y in (year - 1, year):
            try:
                glad.append(C.download(f"{D.BUCKET}/GLADalert/C2/current/alert{y % 100:02d}_{gname}.tif",
                                       tmp / f"g{y}.tif"))
            except FileNotFoundError:
                pass
        srcs = {"l": rasterio.open(pl), "t": rasterio.open(pt)}
        if pw:
            srcs["w"] = rasterio.open(pw)
        for k, g in enumerate(glad):
            srcs[f"g{k}"] = rasterio.open(g)
        kept = 0
        for i in items:
            g = geoms[i]
            win = from_bounds(*g.bounds, srcs["l"].transform).round_offsets().round_lengths()
            if win.width < 1 or win.height < 1:
                out[i] = (True, "pequena")
                continue
            a = {k: s.read(1, window=win, boundless=True, fill_value=0) for k, s in srcs.items()}
            inside = ~geometry_mask([g], a["l"].shape, srcs["l"].window_transform(win))
            if not inside.any():
                inside[:] = True
            water = (a["w"] > 0) & (a["w"] <= 100) if "w" in a else np.zeros_like(inside)
            if water.any():
                water = ndi.binary_dilation(water, iterations=1)
            dry = inside & ~water
            n = inside.sum()
            loss = (dry & (a["l"] > 0)).sum() / n
            alert = 0.0
            for k in range(len(glad)):
                alert = max(alert, (dry & (a[f"g{k}"] >= 2)).sum() / n)
            opened = (dry & (a["t"] < 30)).sum() / n
            riverside = (water & inside).sum() / n >= 0.05
            # na beira do rio, um pouco de terra aberta pode ser só praia: aí exige mais
            ok = loss >= MIN_LOSS or alert >= MIN_GLAD or opened >= (MIN_OPEN_RIO if riverside else MIN_OPEN)
            why = "ok" if ok else ("leito de rio" if riverside else "sem sinal de abertura")
            out[i] = (ok, why)
            kept += ok
        for s_ in srcs.values():
            s_.close()
        for f_ in [pl, pt, *glad]:
            f_.unlink(missing_ok=True)
        print(f"  checagem {lat_s}_{lon_s}: {kept}/{len(items)} confirmadas no chão")
    return out


def run():
    import shapely
    from shapely.geometry import shape

    tmp = Path(tempfile.mkdtemp()) / "amw.geojson"
    C.download(URL, tmp, timeout=900)
    doc = json.loads(tmp.read_text())
    feats = doc.get("features", [])
    print(f"Amazon Mining Watch: {len(feats)} detecções na bacia")
    sample = [f.get("properties") or {} for f in feats[:2000]]
    if sample:
        print("  propriedades:", sorted(sample[0].keys()))
    k_onset = pick_key(sample, ["onset", "onset_period", "period", "first_period", "year", "first_year"])
    k_status = pick_key(sample, ["status"])
    k_conf = pick_key(sample, ["confidence", "conf", "mean_confidence", "score"])
    k_area = pick_key(sample, ["area_ha", "area", "hectares"])
    print(f"  campos usados: onset={k_onset} status={k_status} conf={k_conf} area={k_area}")
    if not k_onset:
        raise SystemExit("não encontrei o campo de período (onset) no GeoJSON")

    geoms = [shape(f["geometry"]) for f in feats]
    cents = shapely.centroid(np.array(geoms, dtype=object))
    lon = shapely.get_x(cents)
    lat = shapely.get_y(cents)
    inside = C.inside_brasil(lon, lat)
    # área geodésica aproximada (graus² -> ha) quando não vier no arquivo
    deg_area = shapely.area(np.array(geoms, dtype=object))
    approx_ha = deg_area * (111_320.0 ** 2) * np.cos(np.radians(lat)) / 10_000.0

    # checagem no chão, com cache para só conferir o que é novo
    cache_p = C.DATA_DIR / "_cache" / "mining_check.json"
    cache = C.read_json(cache_p, {}) or {}
    if cache.get("version") != CHECK_VERSION:
        cache = {"version": CHECK_VERSION, "items": {}}
    keyof = lambda i: f"{lon[i]:.4f},{lat[i]:.4f},{approx_ha[i]:.1f}"  # noqa: E731
    todo = [i for i in range(len(feats)) if inside[i] and keyof(i) not in cache["items"]]
    print(f"  checagem no chão: {len(todo)} detecções novas para conferir")
    if todo:
        ck_tmp = Path(tempfile.mkdtemp(prefix="amwck"))
        try:
            res = ground_check(geoms, todo, ck_tmp)
        finally:
            shutil.rmtree(ck_tmp, ignore_errors=True)
        for i, (ok, why) in res.items():
            cache["items"][keyof(i)] = why
        C.write_json(cache_p, cache)
    dropped = Counter()

    out = []
    per_year = Counter()
    statuses = Counter()
    for i, f in enumerate(feats):
        if not inside[i]:
            continue
        why = cache["items"].get(keyof(i), "ok")
        if why in ("leito de rio", "sem sinal de abertura"):
            dropped[why] += 1
            continue
        p = f.get("properties") or {}
        per = parse_period(p.get(k_onset))
        if per is None:
            continue
        st_raw = str(p.get(k_status, "confirmed")).lower() if k_status else "confirmed"
        statuses[st_raw] += 1
        st = 0 if st_raw.startswith("prov") else 1
        if k_area and isinstance(p.get(k_area), (int, float)):
            area = float(p[k_area])
        else:
            area = float(approx_ha[i])
        out.extend((int(round(lon[i] * 1000)), int(round(lat[i] * 1000)), per, st, round(area, 1)))
        per_year[per // 10] += area
    print(f"  {len(out) // 5} detecções no Brasil; status: {dict(statuses)}; descartadas: {dict(dropped)}")
    periods = sorted(set(out[2::5]))
    C.write_json(C.DATA_DIR / "mining" / "detections.json", {
        "v": 1,
        "layer": "mining",
        "kind": "garimpo detectado (início confirmado)",
        "source": "Amazon Mining Watch (Earth Genome, Pulitzer Center RIN, Amazon Conservation) — CC BY 4.0",
        "fields": ["lon*1000", "lat*1000", "periodo(ano*10+tri)", "status(1=confirmado)", "area_ha"],
        "periods": periods,
        "updated": C.now_iso(),
        "data": out,
    })
    years = sorted({p // 10 for p in periods})
    C.update_manifest("mining", {"years": years, "periods": periods, "updated": C.now_iso(),
                                 "descartadas": dict(dropped), "checagem": CHECK_VERSION})
    C.update_stats("mining", "area_nova_ha", dict(per_year))


if __name__ == "__main__":
    run()
