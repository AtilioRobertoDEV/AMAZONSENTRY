"""Modelo próprio que separa pista de pouso de estrada, asfalto, rio e canal de garimpo.

O filtro de linha (sentinel2.line_response / fit_axis) acha faixas retas de solo exposto
com vegetação dos lados. Estrada de terra, rua asfaltada, rio barrento e canal de rejeito
também são assim. Este módulo mede cada faixa em várias bandas do Sentinel-2 (cor da
superfície, largura, se continua além das pontas, o que sai das cabeceiras, entorno) e
um conjunto de árvores (gradient boosting) dá a chance de ser pista.

Exemplos de treino:
  pista    pistas desenhadas no OpenStreetMap (aeroway=runway) na Amazônia Legal
  não      trechos retos de estradas (terra e asfalto), ruas e rios/canais do OSM,
           buscados em volta das pistas (mesma paisagem)

Uso:
  python airstrip_model.py fetch      # OSM em volta das pistas -> _cache/airstrips/train_osm.json
  python airstrip_model.py features   # mede os exemplos no Sentinel-2 -> _cache/airstrips/train_features.json
  python airstrip_model.py train      # treina e grava airstrip_model.json (ao lado deste arquivo)

O modelo é gravado como árvores em JSON e avaliado só com numpy (predict), então o
pipeline diário não depende do scikit-learn.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import random
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np
from scipy import ndimage as ndi

sys.path.insert(0, str(Path(__file__).parent))
import common as C  # noqa: E402
import sentinel2 as S2  # noqa: E402

CACHE = C.DATA_DIR / "_cache" / "airstrips"
MODEL = Path(__file__).parent / "airstrip_model.json"
BANDS = ("B02", "B03", "B04", "B08", "B11", "B12")
ROADS = "trunk|primary|secondary|tertiary|unclassified|residential|track|service"
WATERS = "river|canal|stream|ditch|drain"
PAVED = {"asphalt", "paved", "concrete", "paving_stones", "sett", "chipseal"}


# ------------------------------------------------------------------ exemplos do OSM

def _overpass(q):
    import requests
    from airstrips import OVERPASS
    for url in OVERPASS:
        for attempt in range(3):
            try:
                r = requests.post(url, data={"data": q}, timeout=900, headers=C.UA)
                if r.status_code in (429, 504):
                    time.sleep(30 * (attempt + 1))
                    continue
                r.raise_for_status()
                return r.json().get("elements", [])
            except Exception as e:  # noqa: BLE001
                print(f"  ! Overpass {url}: {e}")
                time.sleep(10)
    return None


def fetch(n_sites=900, half=0.025, chunk=30):
    """Estradas e rios do OSM em quadros de ~5 km em volta de pistas conhecidas."""
    osm = C.read_json(CACHE / "osm.json") or {}
    pts = []
    for el in osm.get("elements", []):
        if el.get("tags", {}).get("aeroway") == "runway" and el.get("geometry"):
            g = el["geometry"]
            pts.append(((g[0]["lon"] + g[-1]["lon"]) / 2, (g[0]["lat"] + g[-1]["lat"]) / 2))
    res = (C.read_json(CACHE / "results.json") or {}).get("items", {})
    for r in res.values():
        if r.get("ends"):
            (a, b), (c, d) = r["ends"]
            pts.append(((a + c) / 2, (b + d) / 2))
    from airstrips import in_legal
    lon = np.array([p[0] for p in pts])
    lat = np.array([p[1] for p in pts])
    keep = in_legal(lon, lat)
    pts = [p for p, k in zip(pts, keep) if k]
    random.Random(7).shuffle(pts)
    pts = pts[:n_sites]
    print(f"Buscando estradas e rios do OSM em {len(pts)} quadros")
    ways, seen = [], set()
    for i in range(0, len(pts), chunk):
        boxes = [f"({la - half},{lo - half},{la + half},{lo + half})" for lo, la in pts[i:i + chunk]]
        body = "".join(f'way["highway"~"^({ROADS})$"]{b};way["waterway"~"^({WATERS})$"]{b};' for b in boxes)
        els = _overpass(f"[out:json][timeout:600];({body});out tags geom;")
        if els is None:
            print(f"  ! lote {i // chunk} falhou")
            continue
        for el in els:
            if el["id"] in seen or not el.get("geometry"):
                continue
            seen.add(el["id"])
            t = el.get("tags", {})
            ways.append({"id": el["id"], "kind": "water" if "waterway" in t else "road",
                         "cls": t.get("waterway") or t.get("highway"), "surface": t.get("surface", ""),
                         "g": [[round(p["lon"], 6), round(p["lat"], 6)] for p in el["geometry"]]})
        print(f"  lote {i // chunk + 1}/{(len(pts) + chunk - 1) // chunk}: {len(ways)} vias")
        time.sleep(2)
    C.write_json(CACHE / "train_osm.json", {"checked": dt.date.today().isoformat(), "ways": ways})


def straight_pieces(g, lo=350, hi=1900, tol=12):
    """Trechos retos (desvio < tol m) de lo a hi metros de uma linha (lon/lat)."""
    g = np.asarray(g, float)
    if len(g) < 2:
        return []
    k = np.cos(np.radians(g[:, 1].mean()))
    xy = np.column_stack([g[:, 0] * 111320 * k, g[:, 1] * 110570])
    seg = np.r_[0, np.cumsum(np.hypot(*np.diff(xy, axis=0).T))]
    if seg[-1] < lo:
        return []
    # reamostra a cada 20 m
    t = np.arange(0, seg[-1], 20.0)
    p = np.column_stack([np.interp(t, seg, xy[:, 0]), np.interp(t, seg, xy[:, 1])])
    out, i = [], 0
    step = int(lo / 20)
    while i + step < len(p):
        j = i + step
        best = None
        while j < len(p) and (j - i) * 20 <= hi:
            a, b = p[i], p[j]
            d = b - a
            L = np.hypot(*d)
            dev = np.abs(np.cross(d, p[i:j + 1] - a)) / max(L, 1)
            if dev.max() > tol:
                break
            best = j
            j += 1
        if best is not None:
            a, b = p[i], p[best]
            out.append(((a[0] / (111320 * k), a[1] / 110570), (b[0] / (111320 * k), b[1] / 110570)))
            i = best + step // 2
        else:
            i += 3
    return out


def examples(max_neg_per_kind=900, seed=3):
    """(lista de exemplos, cada um {ends, label, kind})."""
    rnd = random.Random(seed)
    osm = C.read_json(CACHE / "osm.json") or {}
    from airstrips import in_legal
    pos = []
    for el in osm.get("elements", []):
        t = el.get("tags", {})
        if t.get("aeroway") != "runway" or not el.get("geometry") or t.get("surface") == "water":
            continue
        g = el["geometry"]
        a, b = (g[0]["lon"], g[0]["lat"]), (g[-1]["lon"], g[-1]["lat"])
        pos.append({"ends": [a, b], "label": 1, "kind": "pista_" + ("asfalto" if t.get("surface") in PAVED else "terra"),
                    "id": f"r{el['id']}"})
    keep = in_legal(np.array([(p["ends"][0][0] + p["ends"][1][0]) / 2 for p in pos]),
                    np.array([(p["ends"][0][1] + p["ends"][1][1]) / 2 for p in pos])) if pos else []
    pos = [p for p, k in zip(pos, keep) if k]
    # trechos negativos cortados com o mesmo comprimento das pistas, para o tamanho
    # sozinho não separar as classes
    def mlen(e):
        (x1, y1_), (x2, y2_) = e["ends"]
        return np.hypot((x2 - x1) * 111320 * np.cos(np.radians(y1_)), (y2_ - y1_) * 110570)
    plen = [L for L in map(mlen, pos) if 300 <= L <= 1900] or [800.0]

    def trim(a, b):
        L = mlen({"ends": [a, b]})
        want = rnd.choice(plen)
        if L <= want:
            return a, b
        f0 = rnd.uniform(0, 1 - want / L)
        f1 = f0 + want / L
        return ((a[0] + (b[0] - a[0]) * f0, a[1] + (b[1] - a[1]) * f0), (a[0] + (b[0] - a[0]) * f1, a[1] + (b[1] - a[1]) * f1))
    neg = {"estrada_terra": [], "asfalto": [], "rua": [], "rio": []}
    for w in (C.read_json(CACHE / "train_osm.json") or {}).get("ways", []):
        if w["kind"] == "water":
            kind = "rio"
        elif w["cls"] in ("residential", "service"):
            kind = "rua"
        elif w["surface"] in PAVED or (w["cls"] in ("trunk", "primary") and not w["surface"]):
            kind = "asfalto"
        else:
            kind = "estrada_terra"
        for a, b in straight_pieces(w["g"])[:2]:
            a, b = trim(a, b)
            neg[kind].append({"ends": [a, b], "label": 0, "kind": kind, "id": f"w{w['id']}_{len(neg[kind])}"})
    out = list(pos)
    for kind, lst in neg.items():
        rnd.shuffle(lst)
        out += lst[:max_neg_per_kind]
    print("exemplos:", {k: sum(1 for e in out if e["kind"] == k) for k in sorted({e["kind"] for e in out})})
    return out


# ------------------------------------------------------------------ medidas

FEATURES = ["len_m", "width_k", "con_med", "con_iqr", "open_frac", "ext_lo", "ext_hi", "ext_mean",
            "br0_open", "br0_sect", "br1_open", "br1_sect",
            *[f"{b}_axis" for b in BANDS], *[f"{b}_dif" for b in BANDS],
            "ndvi_axis", "ndvi_side", "nbr_axis", "ndbi_axis", "mndwi_axis", "bright_axis",
            "win_open", "win_ndvi_p10", "win_ndvi_p90", "lines_par"]


def measure(bands, v, th, y, a, b, k):
    """Vetor de medidas de uma faixa (no espaço girado do filtro de linha)."""
    hw, s0, s1 = S2.SCALES[k]
    fill = np.nanmedian(v)
    vf = np.where(np.isnan(v), fill, v)
    m = ndi.uniform_filter1d(S2._rot(vf, th), 5, axis=1)
    con = S2._contrast(m, hw, s0, s1)[y]
    seg = con[a:b + 1]
    L = len(con)
    ext = lambda lo_, hi_: float(np.median(con[max(0, lo_):max(1, min(L, hi_))])) if min(L, hi_) - max(0, lo_) >= 5 else 0.0  # noqa: E731
    e_lo, e_hi = ext(a - 35, a - 5), ext(b + 5, b + 35)
    side_ndvi = float(np.median(np.minimum(m[y - s1:y - s0 + 1].mean(0), m[y + s0:y + s1 + 1].mean(0))[a:b + 1]))
    br = sorted(S2.end_branches(v, th, y, a, b, side_ndvi - 0.12), key=lambda e: e[1])
    f = {"len_m": (b - a + 1) * S2.PX, "width_k": k, "con_med": float(np.median(seg)),
         "con_iqr": float(np.subtract(*np.percentile(seg, [75, 25]))), "open_frac": float((seg > 0.12).mean()),
         "ext_lo": min(e_lo, e_hi), "ext_hi": max(e_lo, e_hi), "ext_mean": (e_lo + e_hi) / 2,
         "br0_open": br[0][0], "br0_sect": br[0][1], "br1_open": br[1][0], "br1_sect": br[1][1]}
    rot = {}
    for name in BANDS:
        r = S2._rot(bands[name].astype("f4"), th)
        ax = float(np.median(r[y - hw:y + hw + 1, a:b + 1]))
        sd = float(np.median(np.r_[r[y - s1:y - s0 + 1, a:b + 1].ravel(), r[y + s0:y + s1 + 1, a:b + 1].ravel()]))
        rot[name] = ax
        f[f"{name}_axis"] = ax / 10000
        f[f"{name}_dif"] = (ax - sd) / 10000
    g, r_, n, s1b, s2b = rot["B03"], rot["B04"], rot["B08"], rot["B11"], rot["B12"]
    nd = lambda p, q: (p - q) / max(p + q, 1)  # noqa: E731
    f.update(ndvi_axis=nd(n, r_), ndvi_side=side_ndvi, nbr_axis=nd(n, s2b), ndbi_axis=nd(s1b, n),
             mndwi_axis=nd(g, s1b), bright_axis=(rot["B02"] + g + r_) / 30000)
    f["win_open"] = float(np.nanmean(v < side_ndvi - 0.15)) if np.isfinite(v).any() else 0.0
    f["win_ndvi_p10"] = float(np.nanpercentile(v, 10))
    f["win_ndvi_p90"] = float(np.nanpercentile(v, 90))
    # outras faixas paralelas (ruas de cidade, talhões): picos de contraste na mesma direção
    allc = S2._contrast(m, hw, s0, s1)[:, max(a, 0):b + 1]
    rows = np.median(allc, axis=1)
    rows[max(0, y - 6):y + 7] = -1
    f["lines_par"] = int((rows > 0.5 * max(f["con_med"], 0.05)).sum())
    return [float(f[k_]) for k_ in FEATURES]


def read_bands(pre, x0, y1):
    return {b: S2.read_band(pre, b, x0, y1) for b in BANDS}


def measure_example(ex, years=None):
    """Mede um exemplo (cabeceiras conhecidas) na cena boa mais recente."""
    from airstrips import scenes
    (lo1, la1), (lo2, la2) = ex["ends"]
    lon, lat = (lo1 + lo2) / 2, (la1 + la2) / 2
    tile = S2.tile_of(lat, lon)
    epsg, x0, y1 = S2.window_origin(tile, lon, lat)
    _, xa, ya = S2.utm_xy(tile, lo1, la1)
    _, xb, yb = S2.utm_xy(tile, lo2, la2)
    if not 300 <= np.hypot(xb - xa, yb - ya) <= 1900:
        return None
    pa = ((xa - x0) / S2.PX - .5, (y1 - ya) / S2.PX - .5)
    pb = ((xb - x0) / S2.PX - .5, (y1 - yb) / S2.PX - .5)
    this = dt.date.today().year
    for year in years or (this - 1, this - 2, this):
        for cc, nod, date, pre in scenes(tile, year)[:4]:
            try:
                r = S2.scene_ndvi(pre, x0, y1)
            except Exception:  # noqa: BLE001
                continue
            if r is None:
                continue
            v, water = r
            fit = S2.fit_axis(v, pa, pb)
            if fit is None:
                return None
            _, th, yy, a, b, k = fit
            return measure(read_bands(pre, x0, y1), v, th, yy, a, b, k), date
    return None


def features(workers=16, budget_min=120):
    p = CACHE / "train_features.json"
    doc = C.read_json(p, {}) or {}
    if doc.get("features") != FEATURES:
        doc = {"features": FEATURES, "rows": {}}
    rows = doc["rows"]
    todo = [e for e in examples() if e["id"] not in rows]
    print(f"Medindo {len(todo)} exemplos ({len(rows)} já medidos)")
    t0 = time.time()
    n = 0
    with ThreadPoolExecutor(workers) as ex:
        futs = {ex.submit(measure_example, e): e for e in todo}
        for f in as_completed(futs):
            e = futs[f]
            try:
                r = f.result()
            except Exception as err:  # noqa: BLE001
                r = None
                print(f"  ! {e['id']}: {err}")
            rows[e["id"]] = {"label": e["label"], "kind": e["kind"], "ends": e["ends"],
                             "x": r[0] if r else None, "date": r[1] if r else None}
            n += 1
            if n % 100 == 0:
                print(f"  {n}/{len(todo)} ({(time.time() - t0) / 60:.0f} min)")
                C.write_json(p, doc)
            if time.time() - t0 > budget_min * 60:
                for g in futs:
                    g.cancel()
                break
    C.write_json(p, doc)


# ------------------------------------------------------------------ treino e uso

def train(path=None):
    from sklearn.ensemble import GradientBoostingClassifier
    from sklearn.model_selection import GroupKFold
    doc = C.read_json(path or CACHE / "train_features.json")
    rows = [r for r in doc["rows"].values() if r["x"] is not None]
    X = np.array([r["x"] for r in rows])
    y = np.array([r["label"] for r in rows])
    kinds = np.array([r["kind"] for r in rows])
    # validação por região (quadros de 1°) para não medir acerto com vizinhos do treino
    grp = np.array([int(np.floor((r["ends"][0][0]) / 1.0)) * 1000 + int(np.floor(r["ends"][0][1] / 1.0)) for r in rows])
    params = dict(n_estimators=250, max_depth=3, learning_rate=0.06, subsample=0.8, random_state=0)
    prob = np.zeros(len(y))
    for tr, te in GroupKFold(5).split(X, y, grp):
        m = GradientBoostingClassifier(**params).fit(X[tr], y[tr])
        prob[te] = m.predict_proba(X[te])[:, 1]
    report = {"n": len(y), "by_kind": {}}
    for t in (0.5, 0.7):
        tp = ((prob >= t) & (y == 1)).sum()
        report[f"t{t}"] = {"precisao": round(tp / max(1, (prob >= t).sum()), 3), "recall": round(tp / max(1, (y == 1).sum()), 3)}
    for kd in sorted(set(kinds)):
        sel = kinds == kd
        report["by_kind"][kd] = {"n": int(sel.sum()), "chamadas_de_pista": round(float((prob[sel] >= 0.5).mean()), 3)}
    print(json.dumps(report, indent=1, ensure_ascii=False))
    m = GradientBoostingClassifier(**params).fit(X, y)
    imp = sorted(zip(FEATURES, m.feature_importances_), key=lambda t: -t[1])[:12]
    print("medidas mais usadas:", ", ".join(f"{n} {v:.2f}" for n, v in imp))
    trees = []
    for est in m.estimators_[:, 0]:
        t = est.tree_
        trees.append([t.children_left.tolist(), t.children_right.tolist(), t.feature.tolist(),
                      [round(float(v), 6) for v in t.threshold], [round(float(v), 6) for v in t.value[:, 0, 0]]])
    init = float(np.log(y.mean() / (1 - y.mean())))
    MODEL.write_text(json.dumps({"trained": dt.date.today().isoformat(), "features": FEATURES, "init": init,
                                 "lr": params["learning_rate"], "trees": trees, "report": report},
                                separators=(",", ":")))
    print(f"modelo gravado em {MODEL}")
    return report


_model = None


def predict(x):
    """Chance (0-1) de a faixa medida ser pista. None se não houver modelo."""
    global _model
    if _model is None:
        _model = json.loads(MODEL.read_text()) if MODEL.exists() else False
    if not _model or x is None:
        return None
    s = _model["init"]
    for left, right, feat, thr, val in _model["trees"]:
        i = 0
        while left[i] != -1:
            i = left[i] if x[feat[i]] <= thr[i] else right[i]
        s += _model["lr"] * val[i]
    return float(1 / (1 + np.exp(-s)))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("step", choices=["fetch", "features", "train"])
    ap.add_argument("--workers", type=int, default=16)
    ap.add_argument("--budget", type=float, default=120)
    a = ap.parse_args()
    if a.step == "fetch":
        fetch()
    elif a.step == "features":
        features(a.workers, a.budget)
    else:
        train()
