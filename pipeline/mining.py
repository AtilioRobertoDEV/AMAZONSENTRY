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

import json
import re
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

    out = []
    per_year = Counter()
    statuses = Counter()
    for i, f in enumerate(feats):
        if not inside[i]:
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
    print(f"  {len(out) // 5} detecções no Brasil; status: {dict(statuses)}")
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
    C.update_manifest("mining", {"years": years, "periods": periods, "updated": C.now_iso()})
    C.update_stats("mining", "area_nova_ha", dict(per_year))


if __name__ == "__main__":
    run()
