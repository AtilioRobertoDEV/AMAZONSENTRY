"""Utilitários compartilhados pelo pipeline de dados do AMAZON SENTRY.

Formato "cells" (usado por todas as camadas agregadas):

    {
      "v": 1,
      "layer": "fires" | "deforestation" | "mining",
      "kind": "...",                  # descrição curta do produto
      "source": "...",                # fonte original
      "cell": 0.05,                   # tamanho da célula em graus
      "origin": [-75, -35],           # canto sudoeste da grade (lon, lat)
      "time": "day" | "month" | "year",
      "value": "count" | "ha",
      "updated": "2026-11-22T21:00:00Z",
      "data": [x0, y0, t0, v0, x1, y1, t1, v1, ...]
    }

- x, y: índice inteiro da célula (lon = origin[0] + (x + .5) * cell)
- t: "day"   -> dias desde 1970-01-01
     "month" -> ano * 100 + mês
     "year"  -> ano
- v: contagem (focos) ou área em hectares
"""
from __future__ import annotations

import datetime as dt
import json
import os
import time
from pathlib import Path

import numpy as np
import requests

ORIGIN = (-75.0, -35.0)
BBOX = (-74.1, -33.8, -28.8, 5.3)  # Brasil (lon_min, lat_min, lon_max, lat_max)
HERE = Path(__file__).resolve().parent
BRASIL_GEOJSON = HERE / "brasil.geojson"

DATA_DIR = Path(os.environ.get("SENTRY_DATA_DIR", HERE.parent / "data"))
EPOCH = dt.date(1970, 1, 1)

UA = {"User-Agent": "amazon-sentry-pipeline/1.0 (+https://github.com)"}


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def day_number(d: dt.date) -> int:
    return (d - EPOCH).days


def from_day_number(n: int) -> dt.date:
    return EPOCH + dt.timedelta(days=int(n))


# ---------------------------------------------------------------- geometria

_brasil = None


def brasil_geometry():
    global _brasil
    if _brasil is None:
        from shapely.geometry import shape
        from shapely import prepare

        g = shape(json.loads(BRASIL_GEOJSON.read_text())["geometry"])
        # pequena margem para não perder focos no litoral/fronteira
        g = g.buffer(0.02)
        prepare(g)
        _brasil = g
    return _brasil


def inside_brasil(lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    import shapely

    lon = np.asarray(lon, dtype=float)
    lat = np.asarray(lat, dtype=float)
    out = np.zeros(lon.shape, dtype=bool)
    box = (lon >= BBOX[0]) & (lon <= BBOX[2]) & (lat >= BBOX[1]) & (lat <= BBOX[3])
    if box.any():
        out[box] = shapely.contains_xy(brasil_geometry(), lon[box], lat[box])
    return out


def cell_mask(cell: float) -> tuple[np.ndarray, int, int]:
    """Máscara booleana (ny, nx) das células da grade cujo centro cai no Brasil.

    Linha 0 = sul (lat = ORIGIN[1]).
    """
    nx = int(round((BBOX[2] - ORIGIN[0]) / cell)) + 2
    ny = int(round((BBOX[3] - ORIGIN[1]) / cell)) + 2
    xs = ORIGIN[0] + (np.arange(nx) + 0.5) * cell
    ys = ORIGIN[1] + (np.arange(ny) + 0.5) * cell
    gx, gy = np.meshgrid(xs, ys)
    m = inside_brasil(gx.ravel(), gy.ravel()).reshape(ny, nx)
    return m, nx, ny


# ---------------------------------------------------------------- agregação

def cells_from_points(lon, lat, t, v, cell: float):
    """Agrega pontos em (x, y, t) somando v. Retorna lista plana."""
    lon = np.asarray(lon, dtype=float)
    lat = np.asarray(lat, dtype=float)
    t = np.asarray(t, dtype=np.int64)
    v = np.asarray(v, dtype=float)
    if lon.size == 0:
        return []
    x = np.floor((lon - ORIGIN[0]) / cell).astype(np.int64)
    y = np.floor((lat - ORIGIN[1]) / cell).astype(np.int64)
    return aggregate_xyt(x, y, t, v)


def aggregate_xyt(x, y, t, v):
    x = np.asarray(x, dtype=np.int64)
    y = np.asarray(y, dtype=np.int64)
    t = np.asarray(t, dtype=np.int64)
    v = np.asarray(v, dtype=float)
    if x.size == 0:
        return np.zeros((0, 4))
    tmin = int(t.min())
    tt = t - tmin
    tspan = int(tt.max()) + 1
    key = (x * 10000 + y) * tspan + tt
    uk, inv = np.unique(key, return_inverse=True)
    sums = np.bincount(inv, weights=v)
    tt_u = uk % tspan
    xy = uk // tspan
    return np.column_stack([xy // 10000, xy % 10000, tt_u + tmin, sums])


def to_flat(rows, value_decimals: int = 0) -> list:
    rows = np.asarray(rows)
    if rows.size == 0:
        return []
    order = np.lexsort((rows[:, 1], rows[:, 0], rows[:, 2]))  # ordena por t, x, y
    rows = rows[order]
    out = []
    for x, y, t, v in rows:
        vv = round(float(v), value_decimals)
        if value_decimals == 0:
            vv = int(vv)
        if vv <= 0:
            continue
        out.extend((int(x), int(y), int(t), vv))
    return out


def rows_from_flat(flat) -> np.ndarray:
    if not flat:
        return np.zeros((0, 4))
    return np.asarray(flat, dtype=float).reshape(-1, 4)


def write_cells(path: Path, *, layer, kind, source, cell, time_unit, value, rows,
                value_decimals=0, extra=None):
    doc = {
        "v": 1,
        "layer": layer,
        "kind": kind,
        "source": source,
        "cell": cell,
        "origin": list(ORIGIN),
        "time": time_unit,
        "value": value,
        "updated": now_iso(),
    }
    if extra:
        doc.update(extra)
    doc["data"] = to_flat(rows, value_decimals)
    write_json(path, doc)
    return doc


def read_json(path: Path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(path: Path, doc):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(doc, separators=(",", ":"), ensure_ascii=False))
    tmp.replace(path)
    print(f"  -> {path} ({path.stat().st_size / 1e6:.2f} MB)")


def coarsen(rows, factor: int, time_fn=None):
    """Reagrega linhas (x, y, t, v) para uma grade `factor` vezes maior."""
    rows = np.asarray(rows)
    if rows.size == 0:
        return rows
    x = rows[:, 0].astype(np.int64) // factor
    y = rows[:, 1].astype(np.int64) // factor
    t = rows[:, 2].astype(np.int64)
    if time_fn is not None:
        t = np.asarray([time_fn(int(v)) for v in t], dtype=np.int64) if t.size < 1000 else np.vectorize(time_fn)(t)
    return aggregate_xyt(x, y, t, rows[:, 3])


def day_to_month(n: int) -> int:
    d = from_day_number(n)
    return d.year * 100 + d.month


# ---------------------------------------------------------------- rede

def download(url: str, dest: Path, *, retries: int = 4, timeout: int = 300, params=None) -> Path:
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    last = None
    for i in range(retries):
        try:
            with requests.get(url, stream=True, timeout=timeout, headers=UA, params=params) as r:
                if r.status_code == 404:
                    raise FileNotFoundError(url)
                r.raise_for_status()
                tmp = dest.with_suffix(dest.suffix + ".part")
                with open(tmp, "wb") as f:
                    for chunk in r.iter_content(1 << 20):
                        f.write(chunk)
                tmp.replace(dest)
                return dest
        except FileNotFoundError:
            raise
        except Exception as e:  # noqa: BLE001
            last = e
            wait = 5 * 2 ** i
            print(f"  ! falha baixando {url}: {e} (nova tentativa em {wait}s)")
            time.sleep(wait)
    raise RuntimeError(f"não foi possível baixar {url}: {last}")


def get_text(url: str, *, retries: int = 4, timeout: int = 120, params=None) -> str:
    last = None
    for i in range(retries):
        try:
            r = requests.get(url, timeout=timeout, headers=UA, params=params)
            if r.status_code == 404:
                raise FileNotFoundError(url)
            r.raise_for_status()
            return r.text
        except FileNotFoundError:
            raise
        except Exception as e:  # noqa: BLE001
            last = e
            wait = 5 * 2 ** i
            print(f"  ! falha em {url}: {e} (nova tentativa em {wait}s)")
            time.sleep(wait)
    raise RuntimeError(f"falha em {url}: {last}")


# ---------------------------------------------------------------- manifesto

def update_manifest(layer: str, info: dict):
    """Registra no manifest.json o que existe de cada camada."""
    path = DATA_DIR / "manifest.json"
    doc = read_json(path, {}) or {}
    doc.setdefault("layers", {})
    cur = doc["layers"].get(layer, {})
    cur.update(info)
    doc["layers"][layer] = cur
    doc["updated"] = now_iso()
    write_json(path, doc)


def update_stats(layer: str, series_name: str, values: dict):
    """Totais anuais por camada (para o gráfico de série histórica)."""
    path = DATA_DIR / "stats.json"
    doc = read_json(path, {}) or {}
    s = doc.setdefault(layer, {}).setdefault(series_name, {})
    for k, v in values.items():
        s[str(k)] = round(float(v), 1)
    doc[layer][series_name] = dict(sorted(s.items()))
    write_json(path, doc)
