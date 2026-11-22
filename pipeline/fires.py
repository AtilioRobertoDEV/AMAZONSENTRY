"""Focos de incêndio: NASA FIRMS (MODIS e VIIRS).

Sem depender de serviços brasileiros. Três produtos:

- fires/live.json     pontos brutos dos últimos 7 dias (todos os satélites)
- fires/recent.json   células de 0,02° por dia, últimos 35 dias (VIIRS NOAA-20)
- fires/YYYY.json     células de 0,1° por mês, um arquivo por ano
                      (VIIRS a partir de 2012, MODIS antes disso)

Fontes:
- Arquivos públicos de 7 dias da América do Sul (não precisam de chave):
  https://firms.modaps.eosdis.nasa.gov/data/active_fire/<sensor>/csv/<X>_South_America_7d.csv
- Arquivos anuais por país (histórico, sem chave):
  https://firms.modaps.eosdis.nasa.gov/data/country/<sensor>/<ano>/<sensor>_<ano>_Brazil.csv
- API de área com MAP_KEY (opcional, variável FIRMS_MAP_KEY) para preencher
  lacunas do ano corrente.

Uso:
  python fires.py live                 # atualização frequente (a cada 3 h)
  python fires.py history --years 2012 2013 ...
  python fires.py history --all        # 2000 até o ano passado
"""
from __future__ import annotations

import argparse
import datetime as dt
import io
import os
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd

import common as C

FIRMS = "https://firms.modaps.eosdis.nasa.gov"

LIVE = {
    # código: (pasta, prefixo do arquivo)
    "N20": ("noaa-20-viirs-c2", "J1_VIIRS_C2"),
    "N21": ("noaa-21-viirs-c2", "J2_VIIRS_C2"),
    "NPP": ("suomi-npp-viirs-c2", "SUOMI_VIIRS_C2"),
    "MOD": ("modis-c6.1", "MODIS_C6_1"),
}
SENSOR_CODES = {"N20": 0, "N21": 1, "NPP": 2, "MOD": 3}
# satélite usado nas contagens agregadas (um só, para não contar o mesmo fogo 3x)
AGG_SENSOR = "N20"
AGG_API_SOURCE = "VIIRS_NOAA20_NRT"

RECENT_DAYS = 35
RECENT_CELL = 0.02
YEAR_CELL = 0.1
CACHE_CELL = 0.1


def read_firms_csv(text: str) -> pd.DataFrame:
    df = pd.read_csv(io.StringIO(text), low_memory=False)
    df.columns = [c.strip().lower() for c in df.columns]
    if df.empty:
        return df
    df = df[C.inside_brasil(df["longitude"].values, df["latitude"].values)].copy()
    t = df["acq_time"].astype(int)
    df["ts"] = pd.to_datetime(df["acq_date"]) + pd.to_timedelta(t // 100, unit="h") + pd.to_timedelta(t % 100, unit="m")
    df["day"] = (pd.to_datetime(df["acq_date"]) - pd.Timestamp("1970-01-01")).dt.days.astype(int)
    return df


def conf_code(df: pd.DataFrame) -> np.ndarray:
    """0 = baixa, 1 = nominal, 2 = alta (MODIS: <30, 30-79, >=80)."""
    c = df["confidence"]
    if pd.api.types.is_numeric_dtype(c):
        v = c.astype(float).values
        return np.where(v >= 80, 2, np.where(v >= 30, 1, 0))
    m = {"l": 0, "low": 0, "n": 1, "nominal": 1, "h": 2, "high": 2}
    return c.astype(str).str.lower().map(m).fillna(1).astype(int).values


def fetch_live(window: str = "7d") -> dict[str, pd.DataFrame]:
    out = {}
    for code, (folder, prefix) in LIVE.items():
        url = f"{FIRMS}/data/active_fire/{folder}/csv/{prefix}_South_America_{window}.csv"
        try:
            df = read_firms_csv(C.get_text(url, timeout=180))
            print(f"  {code}: {len(df)} focos no Brasil ({window})")
            out[code] = df
        except Exception as e:  # noqa: BLE001
            print(f"  ! {code} indisponível: {e}")
    return out


def fetch_api(source: str, start: dt.date, days: int, key: str) -> pd.DataFrame:
    """API de área (bbox do Brasil), no máximo 5 dias por chamada."""
    b = C.BBOX
    frames = []
    d = start
    end = start + dt.timedelta(days=days)
    while d < end:
        n = min(5, (end - d).days)
        url = f"{FIRMS}/api/area/csv/{key}/{source}/{b[0]},{b[1]},{b[2]},{b[3]}/{n}/{d.isoformat()}"
        txt = C.get_text(url, timeout=300)
        if txt.lower().startswith("invalid"):
            raise RuntimeError(txt[:200])
        frames.append(read_firms_csv(txt))
        d += dt.timedelta(days=n)
    frames = [f for f in frames if len(f)]
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


# --------------------------------------------------------------- produtos

def write_live(dfs: dict[str, pd.DataFrame]):
    rows = []
    for code, df in dfs.items():
        if df.empty:
            continue
        mins = (df["ts"] - pd.Timestamp("1970-01-01")).dt.total_seconds().astype(np.int64) // 60
        frp = df["frp"].fillna(0).round(1).values if "frp" in df else np.zeros(len(df))
        arr = np.column_stack([
            np.round(df["longitude"].values * 1000).astype(np.int64),
            np.round(df["latitude"].values * 1000).astype(np.int64),
            mins.values,
            np.round(frp).astype(np.int64),
            np.full(len(df), SENSOR_CODES[code]),
            conf_code(df),
        ])
        rows.append(arr)
    arr = np.vstack(rows) if rows else np.zeros((0, 6), dtype=np.int64)
    if arr.size:
        arr = arr[np.argsort(arr[:, 2])]
    t0 = int(arr[:, 2].min()) if arr.size else 0
    if arr.size:
        arr[:, 2] -= t0
    doc = {
        "v": 1,
        "layer": "fires",
        "kind": "focos ativos (pontos, 7 dias)",
        "source": "NASA FIRMS (VIIRS NOAA-20/NOAA-21/S-NPP, MODIS)",
        "fields": ["lon*1000", "lat*1000", "min_desde_t0", "frp_MW", "sensor", "confianca"],
        "sensors": list(SENSOR_CODES),
        "t0_minutes": t0,
        "last_minutes": t0 + int(arr[:, 2].max()) if arr.size else None,
        "updated": C.now_iso(),
        "data": arr.ravel().tolist(),
    }
    C.write_json(C.DATA_DIR / "fires" / "live.json", doc)
    return doc


def merge_days(old_rows: np.ndarray, new_rows: np.ndarray, replace_days: set[int]) -> np.ndarray:
    if old_rows.size:
        keep = ~np.isin(old_rows[:, 2].astype(int), list(replace_days))
        old_rows = old_rows[keep]
    parts = [r for r in (old_rows, new_rows) if r.size]
    return np.vstack(parts) if parts else np.zeros((0, 4))


def update_aggregates(df: pd.DataFrame, source_label: str):
    """Atualiza recent.json e o cache diário do ano a partir de um lote de focos."""
    if df is None or df.empty:
        print("  (sem dados para agregar)")
        return
    days = sorted(set(df["day"].tolist()))
    # o primeiro dia da janela de 7 dias costuma estar incompleto: não substitui
    replace = set(days[1:]) if len(days) > 1 else set(days)
    df = df[df["day"].isin(replace)]
    today = C.day_number(dt.date.today())

    # --- recentes (0,02° por dia)
    path = C.DATA_DIR / "fires" / "recent.json"
    old = C.read_json(path)
    old_rows = C.rows_from_flat(old["data"]) if old else np.zeros((0, 4))
    new = C.cells_from_points(df["longitude"], df["latitude"], df["day"], np.ones(len(df)), RECENT_CELL)
    rows = merge_days(old_rows, np.asarray(new), replace)
    rows = rows[rows[:, 2] >= today - RECENT_DAYS] if rows.size else rows
    C.write_cells(path, layer="fires", kind="focos por célula/dia (recentes)", source=source_label,
                  cell=RECENT_CELL, time_unit="day", value="count", rows=rows,
                  extra={"last_day": int(rows[:, 2].max()) if rows.size else None})

    # --- cache diário por ano (0,1°) -> arquivo anual mensal
    df = df.assign(year=pd.to_datetime(df["acq_date"]).dt.year)
    for year, sub in df.groupby("year"):
        cache_path = C.DATA_DIR / "fires" / "_cache" / f"{year}_days.json"
        old = C.read_json(cache_path)
        old_rows = C.rows_from_flat(old["data"]) if old else np.zeros((0, 4))
        new = C.cells_from_points(sub["longitude"], sub["latitude"], sub["day"], np.ones(len(sub)), CACHE_CELL)
        rows = merge_days(old_rows, np.asarray(new), set(sub["day"].unique().tolist()))
        C.write_cells(cache_path, layer="fires", kind="cache diário", source=source_label, cell=CACHE_CELL,
                      time_unit="day", value="count", rows=rows)
        write_year(int(year), rows, source_label, partial=(int(year) == dt.date.today().year))


def write_year(year: int, day_rows: np.ndarray, source_label: str, partial=False):
    factor = int(round(YEAR_CELL / CACHE_CELL))
    monthly = C.coarsen(day_rows, factor, C.day_to_month) if day_rows.size else day_rows
    C.write_cells(C.DATA_DIR / "fires" / f"{year}.json", layer="fires", kind="focos por célula/mês",
                  source=source_label, cell=YEAR_CELL, time_unit="month", value="count", rows=monthly,
                  extra={"year": year, "partial": partial})
    man = C.read_json(C.DATA_DIR / "manifest.json", {}) or {}
    fl = man.get("layers", {}).get("fires", {})
    have = set(fl.get("years", []))
    have.add(year)
    part = set(fl.get("partial_years", []))
    (part.add if partial else part.discard)(year)
    C.update_manifest("fires", {"years": sorted(have), "partial_years": sorted(part)})
    total = float(day_rows[:, 3].sum()) if day_rows.size else 0
    series = "focos_modis" if "MODIS" in source_label else "focos_viirs"
    C.update_stats("fires", series, {year: total})


def run_live():
    dfs = fetch_live("7d")
    if not dfs:
        raise SystemExit("nenhum arquivo FIRMS disponível agora")
    write_live(dfs)
    agg = dfs.get(AGG_SENSOR)
    if agg is None or agg.empty:
        # se o NOAA-20 falhar, usa o S-NPP para não deixar buraco
        agg = dfs.get("NPP")
    update_aggregates(agg, "NASA FIRMS VIIRS (NOAA-20)")
    C.update_manifest("fires", {"live_updated": C.now_iso()})


# --------------------------------------------------------------- histórico

COUNTRY_SENSORS = {
    "MODIS": ["modis"],
    "VIIRS_SNPP": ["viirs-snpp"],
    "VIIRS_N20": ["viirs-jpss1", "viirs-noaa20"],
}


def country_year(sensor_dirs: list[str], year: int) -> pd.DataFrame | None:
    for d in sensor_dirs:
        url = f"{FIRMS}/data/country/{d}/{year}/{d}_{year}_Brazil.csv"
        try:
            tmp = Path(tempfile.mkdtemp()) / "f.csv"
            C.download(url, tmp, timeout=600)
            df = read_firms_csv(tmp.read_text())
            print(f"  {url}: {len(df)} focos")
            return df
        except FileNotFoundError:
            print(f"  (não existe: {url})")
        except Exception as e:  # noqa: BLE001
            print(f"  ! {url}: {e}")
    return None


def history_source(year: int):
    """Sensor usado no mapa: MODIS até 2011, S-NPP 2012-2017, NOAA-20 desde 2018."""
    if year < 2012:
        return "MODIS", "NASA FIRMS MODIS", "MODIS_SP"
    if year < 2018:
        return "VIIRS_SNPP", "NASA FIRMS VIIRS (S-NPP)", "VIIRS_SNPP_SP"
    return "VIIRS_N20", "NASA FIRMS VIIRS (NOAA-20)", "VIIRS_NOAA20_SP"


def missing_years(first=2000, retry_days=2):
    """Anos sem arquivo, ou ainda parciais depois que o ano acabou, ou o ano
    corrente sem cache desde janeiro. Não tenta de novo o mesmo ano em menos de
    `retry_days` dias (evita repetir a cada 3 horas quando a fonte não existe)."""
    today = dt.date.today()
    fl = (C.read_json(C.DATA_DIR / "manifest.json", {}) or {}).get("layers", {}).get("fires", {})
    have, part = set(fl.get("years", [])), set(fl.get("partial_years", []))
    attempts = fl.get("history_attempts", {})
    out = []
    for y in range(first, today.year + 1):
        if y == today.year:
            cache = C.read_json(C.DATA_DIR / "fires" / "_cache" / f"{y}_days.json")
            rows = C.rows_from_flat(cache["data"]) if cache else np.zeros((0, 4))
            need = not rows.size or rows[:, 2].min() > C.day_number(dt.date(y, 1, 3))
        else:
            need = y not in have or y in part
        last = attempts.get(str(y))
        if need and last and (dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(last.replace("Z", "+00:00"))).days < retry_days:
            continue
        if need:
            out.append(y)
    return out


def note_attempt(year: int):
    fl = (C.read_json(C.DATA_DIR / "manifest.json", {}) or {}).get("layers", {}).get("fires", {})
    att = fl.get("history_attempts", {})
    att[str(year)] = C.now_iso()
    C.update_manifest("fires", {"history_attempts": att})


def run_history(years: list[int], with_modis_series=True):
    key = os.environ.get("FIRMS_MAP_KEY", "").strip()
    for year in years:
        print(f"== focos {year}")
        note_attempt(year)
        sensor, label, api_src = history_source(year)
        df = country_year(COUNTRY_SENSORS[sensor], year)
        if (df is None or df.empty) and key:
            start = dt.date(year, 1, 1)
            end = min(dt.date(year + 1, 1, 1), dt.date.today())
            print(f"  usando API FIRMS ({api_src}) {start}..{end}")
            try:
                df = fetch_api(api_src, start, (end - start).days, key)
            except Exception as e:  # noqa: BLE001
                print("  ! API SP falhou, tentando NRT:", e)
                df = fetch_api(api_src.replace("_SP", "_NRT"), start, (end - start).days, key)
        if df is None or df.empty:
            print(f"  ! sem dados de focos para {year}")
            continue
        rows = np.asarray(C.cells_from_points(df["longitude"], df["latitude"], df["day"], np.ones(len(df)), CACHE_CELL))
        if year == dt.date.today().year:
            # junta com o que o modo "live" já acumulou (dias mais recentes)
            old = C.read_json(C.DATA_DIR / "fires" / "_cache" / f"{year}_days.json")
            if old:
                o = C.rows_from_flat(old["data"])
                o = o[o[:, 2] > rows[:, 2].max()] if rows.size else o
                rows = np.vstack([rows, o]) if o.size else rows
            C.write_cells(C.DATA_DIR / "fires" / "_cache" / f"{year}_days.json", layer="fires", kind="cache diário",
                          source=label, cell=CACHE_CELL, time_unit="day", value="count", rows=rows)
        write_year(year, rows, label, partial=(year == dt.date.today().year))
        if with_modis_series and sensor != "MODIS":
            m = country_year(COUNTRY_SENSORS["MODIS"], year)
            if m is not None and len(m):
                C.update_stats("fires", "focos_modis", {year: len(m)})


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["live", "history"])
    ap.add_argument("--years", type=int, nargs="*")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--missing", action="store_true")
    a = ap.parse_args()
    if a.what == "live":
        run_live()
    else:
        ys = a.years or []
        if a.all:
            ys = list(range(2000, dt.date.today().year + 1))
        if a.missing:
            ys = missing_years()
            print("anos a preencher:", ys)
        run_history(ys)
