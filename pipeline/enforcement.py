"""Fiscalização ambiental na Amazônia Legal (protótipo).

Fontes (dados abertos):
- Ibama, autos de infração (um JSON por ano) e termos de embargo;
- Portal da Transparência, execução da despesa por mês (empenhado, liquidado, pago).

Saídas em DATA_DIR/enforcement/:
- monthly.json: por UF e mês, autos, autos de garimpo, valor das multas, embargos,
  hectares embargados; e por órgão federal, empenhado/pago por mês.
- heat.json: grade de 0,1° com autos e embargos por mês (formato "cells").

Nada de nome ou CPF/CNPJ sai daqui: só contagens agregadas.
"""
from __future__ import annotations

import csv
import io
import json
import os
import re
import sys
import zipfile
from collections import defaultdict
from pathlib import Path

import requests

BLOB = "https://stibamadadosabertosprd.blob.core.windows.net/dados-abertos/dados"
AUTOS_ZIP = f"{BLOB}/SIFISC/auto_infracao/auto_infracao/auto_infracao_json.zip"
EMBARGO_JSON = f"{BLOB}/TERMOS_DE_EMBARGO/TERMO_EMBARGO/termo_de_embargo.json"
CGU = "https://portaldatransparencia.gov.br/download-de-dados/despesas-execucao/{ym}"

UFS = ["AC", "AM", "AP", "MA", "MT", "PA", "RO", "RR", "TO"]
Y0, Y1 = 2019, 2026
CELL = 0.1
ORIGIN = (-75.0, -35.0)
UA = {"User-Agent": "amazon-sentry-pipeline/1.0"}
HERE = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("SENTRY_DATA_DIR", HERE.parent / "data"))
CACHE = Path(os.environ.get("ENF_CACHE", DATA_DIR / "_cache" / "enforcement"))

GARIMPO = re.compile(r"garimp|lavra|extra[çc][ãa]o (de |mineral|ilegal de )?(ouro|min[ée]rio|cassiterita)|"
                     r"min[ée]rio|minera[çc][ãa]o|ouro|cassiterita|draga|balsa|pista de pouso", re.I)

# órgãos federais que fiscalizam (nome do órgão subordinado no Portal da Transparência)
ORGAOS = {
    "ibama": re.compile(r"Instituto Brasileiro do Meio Ambiente", re.I),
    "icmbio": re.compile(r"Chico Mendes", re.I),
    "pf": re.compile(r"Pol[íi]cia Federal", re.I),
    "funai": re.compile(r"Funda[çc][ãa]o Nacional (do [íÍ]ndio|dos Povos Ind)", re.I),
}
FISC = re.compile(r"fiscaliza|controle ambiental|preven[çc][ãa]o e controle|combate", re.I)


def get(url: str, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    with requests.get(url, headers=UA, stream=True, timeout=600) as r:
        r.raise_for_status()
        tmp = dest.with_suffix(".part")
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
        tmp.rename(dest)
    print(f"  baixado {dest.name} ({dest.stat().st_size / 1e6:.1f} MB)")
    return dest


def num(v) -> float | None:
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().lstrip("'")
    if "," in s and "." in s:
        s = s.replace(".", "").replace(",", ".")
    else:
        s = s.replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def ym(v) -> int | None:
    """'2024-03-05 10:00', '05/03/2024 10:00' ou '2024-03-05T..' -> 202403."""
    if not v:
        return None
    s = str(v).strip().lstrip("'")
    m = re.match(r"(\d{4})-(\d{2})", s)
    if m:
        y, mo = int(m[1]), int(m[2])
    else:
        m = re.match(r"(\d{2})/(\d{2})/(\d{4})", s)
        if not m:
            return None
        y, mo = int(m[3]), int(m[2])
    if not (Y0 <= y <= Y1 and 1 <= mo <= 12):
        return None
    return y * 100 + mo


def pick(rec: dict, *names):
    for n in names:
        if n in rec and rec[n] not in (None, ""):
            return rec[n]
    return None


def cell_of(lon, lat):
    lon, lat = num(lon), num(lat)
    if lon is None or lat is None or not (-75 < lon < -40 and -19 < lat < 6):
        return None
    return int((lon - ORIGIN[0]) // CELL), int((lat - ORIGIN[1]) // CELL)


def blank():
    return defaultdict(lambda: defaultdict(float))


# ------------------------------------------------------------------ autos

def autos(uf_m, heat):
    z = zipfile.ZipFile(get(AUTOS_ZIP, CACHE / "auto_infracao_json.zip"))
    shown = False
    tipos = defaultdict(int)
    for name in sorted(z.namelist()):
        m = re.search(r"(\d{4})", name)
        if not m or not (Y0 <= int(m[1]) <= Y1):
            continue
        with z.open(name) as f:
            rows = json.load(f)
        if not shown and rows:
            print("  campos dos autos:", sorted(rows[0].keys()))
            shown = True
        n = 0
        for r in rows:
            uf = pick(r, "UF")
            if uf not in UFS:
                continue
            if str(pick(r, "SIT_CANCELADO") or "N").upper().startswith("S"):
                continue
            t = ym(pick(r, "DAT_HORA_AUTO_INFRACAO", "DT_FATO_INFRACIONAL", "DAT_LANCAMENTO", "DT_LANCAMENTO"))
            if t is None:
                continue
            texto = " ".join(str(pick(r, k) or "") for k in
                             ("DES_AUTO_INFRACAO", "DES_INFRACAO", "DES_LOCAL_INFRACAO", "TIPO_INFRACAO"))
            gar = bool(GARIMPO.search(texto))
            tipos[str(pick(r, "TIPO_INFRACAO") or "?")] += 1
            d = uf_m[uf][t]
            d["autos"] += 1
            d["garimpo"] += gar
            d["multa"] += num(pick(r, "VAL_AUTO_INFRACAO")) or 0
            c = cell_of(pick(r, "NUM_LONGITUDE_AUTO", "LONGITUDE"), pick(r, "NUM_LATITUDE_AUTO", "LATITUDE"))
            if c:
                h = heat[(c[0], c[1], t)]
                h[0] += 1
                h[2] += gar
            n += 1
        print(f"  {name}: {len(rows)} autos, {n} na Amazônia Legal")
    print("  tipos de infração:", dict(sorted(tipos.items(), key=lambda kv: -kv[1])[:15]))


# ------------------------------------------------------------------ embargos

def embargos(uf_m, heat):
    p = get(EMBARGO_JSON, CACHE / "termo_de_embargo.json")
    rows = json.loads(p.read_text(encoding="utf-8"))
    n = 0
    for r in rows:
        uf = r.get("UF")
        if uf not in UFS or str(r.get("SIT_CANCELADO") or "N").upper().startswith("S"):
            continue
        t = ym(r.get("DAT_EMBARGO"))
        if t is None:
            continue
        gar = bool(GARIMPO.search(str(r.get("DES_TAD") or "")))
        d = uf_m[uf][t]
        d["embargos"] += 1
        d["ha"] += num(r.get("QTD_AREA_EMBARGADA")) or 0
        d["emb_garimpo"] += gar
        c = cell_of(r.get("NUM_LONGITUDE_TAD"), r.get("NUM_LATITUDE_TAD"))
        if c:
            h = heat[(c[0], c[1], t)]
            h[1] += 1
            h[2] += gar
        n += 1
    print(f"  {n} embargos na Amazônia Legal {Y0}-{Y1}")


# ------------------------------------------------------------------ gastos

def gastos(months):
    out = {k: {"empenhado": {}, "pago": {}, "fisc_empenhado": {}, "fisc_pago": {}} for k in ORGAOS}
    acoes = defaultdict(float)
    shown = False
    for t in months:
        if t < 202301:
            continue
        try:
            z = zipfile.ZipFile(get(CGU.format(ym=t), CACHE / "cgu" / f"{t}.zip"))
        except Exception as e:  # noqa: BLE001
            print(f"  {t}: sem arquivo ({e})")
            continue
        for name in z.namelist():
            with z.open(name) as f:
                rd = csv.DictReader(io.TextIOWrapper(f, encoding="latin-1"), delimiter=";")
                if not shown:
                    print("  colunas CGU:", rd.fieldnames)
                    shown = True
                for r in rd:
                    org = r.get("Nome Órgão Subordinado") or r.get("Nome Órgão") or ""
                    key = next((k for k, rx in ORGAOS.items() if rx.search(org)), None)
                    if not key:
                        continue
                    emp = num(r.get("Valor Empenhado (R$)")) or 0
                    pago = (num(r.get("Valor Pago (R$)")) or 0) + (num(r.get("Valor Restos a Pagar Pagos (R$)")) or 0)
                    acao = r.get("Nome Ação") or ""
                    o = out[key]
                    o["empenhado"][t] = o["empenhado"].get(t, 0) + emp
                    o["pago"][t] = o["pago"].get(t, 0) + pago
                    if FISC.search(acao):
                        o["fisc_empenhado"][t] = o["fisc_empenhado"].get(t, 0) + emp
                        o["fisc_pago"][t] = o["fisc_pago"].get(t, 0) + pago
                    acoes[(key, acao)] += emp
        print(f"  {t}: ok")
    top = sorted(acoes.items(), key=lambda kv: -kv[1])
    for (k, a), v in top[:40]:
        print(f"    {k:6s} R$ {v / 1e6:10.1f} mi  {a}")
    return out


def main() -> None:
    months = [y * 100 + m for y in range(Y0, Y1 + 1) for m in range(1, 13)]
    uf_m = defaultdict(blank)
    heat = defaultdict(lambda: [0, 0, 0])
    print("autos de infração")
    autos(uf_m, heat)
    print("embargos")
    embargos(uf_m, heat)
    last = max((t for d in uf_m.values() for t in d), default=months[-1])
    months = [t for t in months if t <= last]
    print("gastos federais")
    try:
        spend = gastos(months)
    except Exception as e:  # noqa: BLE001
        print("  falhou:", repr(e))
        spend = {}

    keys = ["autos", "garimpo", "multa", "embargos", "ha", "emb_garimpo"]
    out = {
        "v": 1,
        "months": months,
        "source": "Ibama (autos de infração e termos de embargo, dados abertos); "
                  "Portal da Transparência (execução da despesa)",
        "uf": {uf: {k: [round(uf_m[uf][t][k], 1) if t in uf_m[uf] else 0 for t in months] for k in keys}
               for uf in UFS},
        "spend": {org: {k: [round(v.get(t, 0)) for t in months] for k, v in d.items()} for org, d in spend.items()},
    }
    dest = DATA_DIR / "enforcement"
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "monthly.json").write_text(json.dumps(out, separators=(",", ":")))
    flat = []
    for (x, y, t), (a, e, g) in sorted(heat.items(), key=lambda kv: kv[0][2]):
        flat += [x, y, t, a, e, g]
    (dest / "heat.json").write_text(json.dumps({
        "v": 1, "layer": "enforcement", "cell": CELL, "origin": list(ORIGIN), "time": "month",
        "fields": ["x", "y", "t", "autos", "embargos", "garimpo"], "data": flat,
    }, separators=(",", ":")))
    for uf in UFS:
        tot = {k: sum(out["uf"][uf][k]) for k in keys}
        print(f"  {uf}: " + ", ".join(f"{k}={v:,.0f}" for k, v in tot.items()))
    print(f"  células x mês: {len(heat)}")


if __name__ == "__main__":
    main()
