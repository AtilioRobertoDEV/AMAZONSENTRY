"""Pistas de pouso não registradas (suspeitas) na Amazônia Legal.

1. Candidatas, de fontes abertas:
   - OpenStreetMap (aeroway=aerodrome/airstrip/runway), via Overpass;
   - OurAirports (base aberta de aeródromos, inclusive pistas sem código);
   - MapBiomas, pistas não registradas (quando o arquivo público estiver acessível).
   O que tem código de aeródromo (padrão ANAC, como SWXY ou SN3K) no OurAirports
   ou no OSM conta como registrada e sai da camada. O resto é "não registrada" no
   sentido de que não achamos registro: não é prova de ilegalidade.
2. Cada candidata é conferida no Sentinel-2 (10 m, 2017 em diante): o detector
   procura a faixa reta e estreita de solo exposto com vegetação dos dois lados
   e mede o eixo (comprimento e direção). Ano com imagem ruim (nuvem, sombra, sem
   dado) é ignorado.
3. Com o eixo fixo, mede ano a ano quanto da pista está aberta. Daí saem:
   - quando surgiu (entre o último ano fechada e o primeiro aberta; antes de 2017,
     pela perda de floresta Hansen no eixo);
   - situação no último ano com imagem boa: ativa, perdendo uso (mato voltando),
     abandonada (vegetação tomou a pista) ou reaberta;
   - distância até o garimpo mais próximo (Amazon Mining Watch).

Saída: data/airstrips/airstrips.json
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import re
import sys
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402
import sentinel2 as S2  # noqa: E402

VERSION = "v2"          # varredura em volta dos garimpos
RESULTS_VERSION = "v4"  # checagem ano a ano (v4: água por MNDWI, rumo conhecido)
OUT = C.DATA_DIR / "airstrips"
CACHE = C.DATA_DIR / "_cache" / "airstrips"
LEGAL = {"AC", "AM", "AP", "PA", "RO", "RR", "TO", "MT", "MA"}
ANAC_CODE = re.compile(r"^S[A-Z][A-Z0-9]{2}$")
# Pistas de cidade, vila ou aldeia: muitas estão sem registro na ANAC, mas são de uso público.
# Ficam na camada, em categorias à parte da "sem registro (suspeita)".
PRIVATE = re.compile(r"(?i)\b(fazendas?|faz\.?|agro\w*|est[aâ]ncia|s[ií]tio|ch[aá]cara|ltda|s/?a\b|grupo|usina|"
                     r"minera[cç][aã]o|garimpos?|madeireira|pecu[aá]ria|rancho?|serraria|empresa|haras|agr[ií]cola)")
PUBLIC = re.compile(r"(?i)^(aeroporto|aer[oó]dromo)\s+(municipal|regional|estadual|internacional|p[uú]blic[oa]|"
                    r"de|do|da|dos|das)\b")
VILLAGE = re.compile(r"(?i)\baldeia\b|\bmiss[aã]o\b|\bterra ind[ií]gena\b|\bind[ií]gena\b|\bp[oó]lo base\b|"
                     r"\bposto ind|\bposto ind[ií]gena\b|\bPIN\b|\bDSEI\b|\bsesai\b|\bfunai\b")
CATS = {None: 0, "aldeia": 1, "cidade": 2}
UF_NAMES = {"acre": "AC", "amazonas": "AM", "amapa": "AP", "para": "PA", "rondonia": "RO", "roraima": "RR",
            "tocantins": "TO", "mato grosso": "MT", "maranhao": "MA"}


def _fold(s: str) -> str:
    import unicodedata
    return "".join(ch for ch in unicodedata.normalize("NFD", s or "").lower() if unicodedata.category(ch) != "Mn")


TOWNS: set = set()  # nomes de município (sem acento) vistos no OurAirports


def public_kind(name: str, town: str = "") -> str | None:
    """'aldeia' (aldeia, missão, polo base), 'cidade' ('Aeroporto de Pauini', 'Jaru Airport') ou None."""
    n = (name or "").strip()
    if not n:
        return None
    if VILLAGE.search(n):
        return "aldeia"
    return "cidade" if is_public(n, town) else None


def is_public(name: str, town: str = "") -> bool:
    """Nome de pista de cidade ou vila ('Aeroporto de Pauini', 'Jaru Airport')."""
    n = (name or "").strip()
    if not n or PRIVATE.search(n):
        return False
    if PUBLIC.search(n):
        return True
    stem = _fold(re.sub(r"(?i)\s+(airport|airfield|airstrip)$", "", n))
    t = _fold(town)
    if t and len(t) > 2 and (stem == t or stem.startswith(t + " ") or stem.startswith(t + "/")):
        return True
    return stem.split("/")[0].strip() in TOWNS

OURAIRPORTS = "https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/"
OVERPASS = ["https://overpass-api.de/api/interpreter",
            "https://overpass.kumi.systems/api/interpreter",
            "https://maps.mail.ru/osm/tools/overpass/api/interpreter"]
ANAC = ["https://sistemas.anac.gov.br/dadosabertos/Aerodromos/Aer%C3%B3dromos%20P%C3%BAblicos/Lista%20de%20aer%C3%B3dromos%20p%C3%BAblicos/AerodromosPublicos.csv",
        "https://sistemas.anac.gov.br/dadosabertos/Aerodromos/Aer%C3%B3dromos%20Privados/Lista%20de%20aer%C3%B3dromos%20privados/Aerodromos%20Privados/AerodromosPrivados.csv"]
MAPBIOMAS = "https://storage.googleapis.com/mapbiomas-workspace/INFRASTRUCTURE/ORIGINALS/BRAZIL/WORKSPACE/"
HANSEN = "https://storage.googleapis.com/earthenginepartners-hansen"

SRC_BITS = {"osm": 1, "ourairports": 2, "mapbiomas": 4, "detector": 8, "apontada": 16}
STATUS = {"ativa": 1, "perdendo uso": 2, "abandonada": 3, "reaberta": 4, "sem confirmação": 0}

OPEN_T = 0.12       # contraste mínimo (lados - eixo) para o pixel do eixo contar como aberto
MIN_SCORE = 0.27    # contraste mínimo da faixa no melhor ano para confirmar a pista
MIN_SIDE = 0.45     # NDVI mínimo das laterais no melhor ano (vegetação dos dois lados)
MIN_LEN, MAX_LEN = 300, 2600
KNOWN_MIN = 0.06   # contraste mínimo no eixo desenhado para a pista aparecer na imagem


# ------------------------------------------------------------------ área

_legal = None


def legal_amazon():
    """Amazônia Legal: AC AM AP PA RO RR TO MT + Maranhão a oeste de 44°W."""
    global _legal
    if _legal is None:
        from shapely import prepare
        from shapely.geometry import box, shape
        from shapely.ops import unary_union
        doc = json.loads((C.HERE.parent / "site" / "data" / "base" / "estados.geojson").read_text())
        parts = []
        for f in doc["features"]:
            uf = f["properties"]["uf"]
            if uf in LEGAL:
                g = shape(f["geometry"])
                if uf == "MA":
                    g = g.intersection(box(-50, -15, -44, 0))
                parts.append(g)
        _legal = unary_union(parts).buffer(0.02)
        prepare(_legal)
    return _legal


def in_legal(lon, lat):
    import shapely
    lon = np.asarray(lon, float)
    lat = np.asarray(lat, float)
    return shapely.contains_xy(legal_amazon(), lon, lat)


BBOX = (-74.0, -18.1, -43.9, 5.3)   # lon_min, lat_min, lon_max, lat_max


# ------------------------------------------------------------------ fontes

def from_ourairports():
    """Pistas do OurAirports. Registradas: código no padrão ANAC ou código local (CIAD)."""
    txt = C.get_text(OURAIRPORTS + "airports.csv", timeout=300)
    runways = {}
    try:
        for r in csv.DictReader(io.StringIO(C.get_text(OURAIRPORTS + "runways.csv", timeout=300))):
            try:
                a = (float(r["le_longitude_deg"]), float(r["le_latitude_deg"]))
                b = (float(r["he_longitude_deg"]), float(r["he_latitude_deg"]))
            except ValueError:
                continue
            runways.setdefault(r["airport_ident"], (a, b))
    except Exception as e:  # noqa: BLE001
        print("  ! runways.csv:", e)
    cands, reg = [], []
    rows = [r for r in csv.DictReader(io.StringIO(txt)) if r["iso_country"] == "BR"]
    TOWNS.update(t for t in (_fold(r.get("municipality", "")) for r in rows) if len(t) > 2)
    for r in rows:
        lon, lat = float(r["longitude_deg"]), float(r["latitude_deg"])
        if not (BBOX[0] <= lon <= BBOX[2] and BBOX[1] <= lat <= BBOX[3]):
            continue
        codes = [r["ident"], r["gps_code"], r["icao_code"]]
        registered = any(ANAC_CODE.match(c or "") for c in codes) or bool(r["local_code"].strip())
        registered = registered or bool(r.get("iata_code", "").strip()) or r.get("scheduled_service") == "yes" \
            or r["type"] in ("medium_airport", "large_airport")
        kind = public_kind(r["name"], r.get("municipality", ""))
        if r["type"] == "heliport":
            continue
        if registered:  # fechada mas já foi oficial: não é suspeita
            if r["type"] != "closed":
                reg.append((lon, lat))
        elif kind and r["type"] == "closed":
            continue
        elif r["type"] in ("small_airport", "closed"):
            cands.append({"lon": lon, "lat": lat, "src": "ourairports", "name": r["name"], "cat": kind,
                          "ends": runways.get(r["ident"]), "closed": r["type"] == "closed"})
    print(f"  OurAirports: {len(cands)} candidatas, {len(reg)} registradas")
    return cands, reg


RUNWAYS: list = []      # (lon, lat, cabeceiras) de toda pista desenhada no OSM
REGISTERED: list = []   # aeródromos da ANAC na região, para a categoria "registrada"


def from_osm():
    q = f"""[out:json][timeout:600];
(nwr["aeroway"~"^(aerodrome|airstrip)$"]({BBOX[1]},{BBOX[0]},{BBOX[3]},{BBOX[2]}););
out tags center;
way["aeroway"="runway"]({BBOX[1]},{BBOX[0]},{BBOX[3]},{BBOX[2]});
out tags geom;"""
    cache = CACHE / "osm.json"
    doc = None
    for url in OVERPASS:
        try:
            import requests
            r = requests.post(url, data={"data": q}, timeout=900, headers=C.UA)
            r.raise_for_status()
            doc = r.json()
            C.write_json(cache, doc)
            break
        except Exception as e:  # noqa: BLE001
            print(f"  ! Overpass {url}: {e}")
    if doc is None:
        doc = C.read_json(cache)
        if doc is None:
            print("  OSM indisponível e sem cache")
            return [], []
        print("  OSM: usando o cache")
    cands, reg = [], []
    for el in doc.get("elements", []):
        t = el.get("tags", {})
        codes = [t.get("icao", ""), t.get("ref", ""), t.get("gps_code", "")]
        registered = any(ANAC_CODE.match(c.strip().upper()) for c in codes if c)
        registered = registered or bool(t.get("iata")) \
            or t.get("aerodrome:type") in ("public", "regional", "international", "military")
        if t.get("aeroway") == "runway" and el.get("geometry"):
            g = el["geometry"]
            a, b = (g[0]["lon"], g[0]["lat"]), (g[-1]["lon"], g[-1]["lat"])
            lon, lat = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
            ends = (a, b)
        else:
            c = el.get("center") or el
            if "lon" not in c:
                continue
            lon, lat, ends = c["lon"], c["lat"], None
        if t.get("aeroway") not in ("runway",) and t.get("surface") in ("water",):
            continue
        if ends:
            RUNWAYS.append((lon, lat, ends))
        if registered:
            reg.append((lon, lat))
        else:
            cands.append({"lon": lon, "lat": lat, "src": "osm", "name": t.get("name", ""), "ends": ends,
                          "cat": public_kind(t.get("name", ""), t.get("addr:city", "")),
                          "closed": t.get("disused") == "yes" or "abandoned:aeroway" in t})
    print(f"  OSM: {len(cands)} candidatas, {len(reg)} registradas")
    return cands, reg


def _coord(v: str):
    """'10°55'48''S', '-10,93' ou '10 55 48 S' -> graus decimais."""
    v = (v or "").strip().upper().replace(",", ".")
    if not v:
        return None
    try:
        return float(v)
    except ValueError:
        pass
    nums = [float(x) for x in re.findall(r"\d+(?:\.\d+)?", v)]
    if not nums:
        return None
    g = nums[0] + (nums[1] / 60 if len(nums) > 1 else 0) + (nums[2] / 3600 if len(nums) > 2 else 0)
    return -g if re.search(r"[SWO]", v) or v.startswith("-") else g


def from_anac():
    """Cadastro de aeródromos da ANAC (públicos e privados), só como referência de
    pista registrada. Fica guardado em cache; o mapa nunca consulta a ANAC."""
    reg = []
    for i, url in enumerate(ANAC):
        cache = CACHE / f"anac_{i}.csv"
        txt = None
        try:
            import requests
            r = requests.get(url, timeout=180, headers=C.UA)
            r.raise_for_status()
            raw = r.content
            try:
                txt = raw.decode("utf-8-sig")
            except UnicodeDecodeError:
                txt = raw.decode("latin-1")
            if "LATITUDE" in txt.upper():
                cache.parent.mkdir(parents=True, exist_ok=True)
                cache.write_text(txt)
            else:
                txt = None
        except Exception as e:  # noqa: BLE001
            print(f"  ! ANAC {i}: {e}")
        if txt is None and cache.exists():
            txt = cache.read_text()
            print(f"  ANAC {i}: usando o cache")
        if not txt:
            continue
        lines = txt.splitlines()
        h = next((k for k, ln in enumerate(lines) if "LATITUDE" in ln.upper()), None)
        if h is None:
            continue
        sep = ";" if lines[h].count(";") >= lines[h].count(",") else ","
        rows = csv.reader(lines[h:], delimiter=sep)
        head = [x.strip().upper() for x in next(rows)]
        ila = next(k for k, x in enumerate(head) if x.startswith("LATITUDE"))
        ilo = next(k for k, x in enumerate(head) if x.startswith("LONGITUDE"))
        col = lambda pre: next((k for k, x in enumerate(head) if x.startswith(pre)), None)  # noqa: E731
        inome, icod, iciad, imun, iuf = col("NOME"), col("CÓDIGO"), col("CIAD"), col("MUNIC"), col("UF")
        for row in rows:
            if len(row) <= max(ila, ilo):
                continue
            la, lo = _coord(row[ila]), _coord(row[ilo])
            if la is None or lo is None:
                continue
            if lo > 0:
                lo = -lo      # Brasil: longitude sempre oeste
            if BBOX[0] <= lo <= BBOX[2] and BBOX[1] <= la <= BBOX[3]:
                reg.append((lo, la))
                get = lambda k: (row[k].strip() if k is not None and k < len(row) else "")  # noqa: E731
                nome = get(inome)
                if re.search(r"(?i)helipont|heliporto", nome):
                    continue
                REGISTERED.append({"lon": lo, "lat": la, "pub": i == 0, "name": nome,
                                   "code": get(icod) or get(iciad), "town": get(imun).title(), "uf": get(iuf)})
    print(f"  ANAC: {len(reg)} aeródromos registrados na região")
    return [], reg


def _read_shp_points(blob: bytes):
    import shapefile  # pyshp
    z = zipfile.ZipFile(io.BytesIO(blob))
    names = z.namelist()
    shp = next(n for n in names if n.lower().endswith(".shp"))
    base = shp[:-4]
    r = shapefile.Reader(shp=io.BytesIO(z.read(shp)), dbf=io.BytesIO(z.read(base + ".dbf")),
                         shx=io.BytesIO(z.read(base + ".shx")) if base + ".shx" in names else None)
    out = []
    for s in r.shapes():
        pts = s.points
        if not pts:
            continue
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        ends = (tuple(pts[0]), tuple(pts[-1])) if s.shapeType in (3, 13, 23) and len(pts) >= 2 else None
        out.append((sum(xs) / len(xs), sum(ys) / len(ys), ends))
    return out


REPORTS = Path(__file__).resolve().parent / "airstrip_reports.json"


def from_reports():
    """Pistas apontadas por quem usa o site (coordenadas copiadas do popup). Passam pela
    mesma conferência no Sentinel-2 que as outras."""
    doc = json.loads(REPORTS.read_text()) if REPORTS.exists() else {}
    cands = [{"lon": float(r["lon"]), "lat": float(r["lat"]), "src": "apontada", "name": r.get("nome", ""),
              "ends": None, "closed": False} for r in doc.get("items", [])]
    print(f"  Apontadas: {len(cands)}")
    return cands, []


def from_mapbiomas():
    """Pistas do MapBiomas (registradas e não registradas). Hoje o link público
    responde 'acesso negado'; fica tentando e usa o que tiver em cache."""
    cands, reg = [], []
    for name, is_reg in (("PISTAS_NAO_REGISTRADAS", False), ("PISTAS_REGISTRADAS", True)):
        cache = CACHE / f"mapbiomas_{name.lower()}.zip"
        blob = None
        try:
            import requests
            r = requests.get(MAPBIOMAS + name + ".zip", timeout=300, headers=C.UA)
            if r.ok and r.content[:2] == b"PK":
                blob = r.content
                cache.parent.mkdir(parents=True, exist_ok=True)
                cache.write_bytes(blob)
            else:
                print(f"  MapBiomas {name}: HTTP {r.status_code}")
        except Exception as e:  # noqa: BLE001
            print(f"  ! MapBiomas {name}: {e}")
        if blob is None and cache.exists():
            blob = cache.read_bytes()
        if blob is None:
            continue
        try:
            pts = _read_shp_points(blob)
        except Exception as e:  # noqa: BLE001
            print(f"  ! MapBiomas {name} ilegível: {e}")
            continue
        for lon, lat, ends in pts:
            if is_reg:
                reg.append((lon, lat))
            else:
                cands.append({"lon": lon, "lat": lat, "src": "mapbiomas", "name": "", "ends": ends, "closed": False})
    print(f"  MapBiomas: {len(cands)} candidatas, {len(reg)} registradas")
    return cands, reg


def merge(cands, reg, radius_m=900, reg_m=1500):
    """Junta candidatas a menos de `radius_m` e tira as que têm registro por perto."""
    from scipy.spatial import cKDTree

    if not cands:
        return []
    lon = np.array([c["lon"] for c in cands])
    lat = np.array([c["lat"] for c in cands])
    keep = in_legal(lon, lat)
    cands = [c for c, k in zip(cands, keep) if k]
    lon, lat = lon[keep], lat[keep]
    k = np.cos(np.radians(-5))
    xy = np.column_stack([lon * 111.32 * k, lat * 110.57]) * 1000  # metros (aprox.)
    tree = cKDTree(xy)
    # prioridade: quem tem o eixo da pista (ends) primeiro
    order = sorted(range(len(cands)), key=lambda i: (cands[i]["ends"] is None, cands[i]["src"] != "mapbiomas"))
    used = np.zeros(len(cands), bool)
    out = []
    for i in order:
        if used[i]:
            continue
        group = [j for j in tree.query_ball_point(xy[i], radius_m) if not used[j]]
        used[group] = True
        c = dict(cands[i])
        c["srcs"] = sorted({cands[j]["src"] for j in group})
        c["names"] = sorted({cands[j]["name"] for j in group if cands[j]["name"]})[:2]
        c["closed"] = any(cands[j]["closed"] for j in group)
        cats = {cands[j].get("cat") for j in group}
        c["cat"] = "aldeia" if "aldeia" in cats else "cidade" if "cidade" in cats else None
        out.append(c)
    if reg:
        rxy = np.array([(a * 111.32 * k * 1000, b * 110.57 * 1000) for a, b in reg])
        d, _ = cKDTree(rxy).query(np.array([(c["lon"] * 111.32 * k * 1000, c["lat"] * 110.57 * 1000) for c in out]))
        out = [c for c, dd in zip(out, d) if dd > reg_m]
    return out


# ------------------------------------------------------------------ análise na imagem

SCENES_LOCK = __import__("threading").Lock()
_scene_cache: dict = {}


def scenes(tile, year):
    key = f"{tile}_{year}"
    with SCENES_LOCK:
        if key in _scene_cache:
            return _scene_cache[key]
    p = CACHE / "scenes" / f"{key}.json"
    this_year = dt.date.today().year
    doc = C.read_json(p) if p.exists() else None
    stale = doc is None or (year >= this_year - 1 and doc.get("checked", "") < (dt.date.today() - dt.timedelta(days=20)).isoformat())
    if stale:
        try:
            sc = S2.list_scenes(tile, year)
            doc = {"checked": dt.date.today().isoformat(), "scenes": sc}
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(json.dumps(doc, separators=(",", ":")))
        except Exception as e:  # noqa: BLE001
            print(f"  ! cenas {key}: {e}")
            doc = doc or {"scenes": []}
    res = [s for s in doc["scenes"] if s[1] <= 50 and s[0] <= 70]
    with SCENES_LOCK:
        _scene_cache[key] = res
    return res


def year_image(tile, year, x0, y1, tries=6):
    """NDVI de uma cena limpa do ano (a menos nublada que passa na checagem), ou None."""
    for cc, nod, date, pre in scenes(tile, year)[:tries]:
        try:
            r = S2.scene_ndvi(pre, x0, y1)
        except Exception:  # noqa: BLE001
            continue
        if r is not None:
            return r[0], r[1], date
    return None


def hansen_years(epsg, pts_xy):
    """Ano de perda Hansen (mediana) e cobertura de 2000 nos pontos do eixo."""
    lon, lat = S2.to_lonlat(epsg, pts_xy[:, 0], pts_xy[:, 1])
    lon = np.asarray(lon)
    lat = np.asarray(lat)
    import deforestation as D
    import rasterio
    try:
        version, _ = D.latest_gfc()
    except Exception:  # noqa: BLE001
        return None, None
    left = int(np.floor(lon.mean() / 10) * 10)
    top = int(np.floor(lat.mean() / 10) * 10) + 10
    name = f"{abs(top):02d}{'S' if top < 0 else 'N'}_{abs(left):03d}{'W' if left < 0 else 'E'}"
    out = {}
    for prod in ("lossyear", "treecover2000"):
        url = f"/vsicurl/{HANSEN}/{version}/Hansen_{version}_{prod}_{name}.tif"
        try:
            with rasterio.open(url) as ds:
                out[prod] = np.array([v[0] for v in ds.sample(list(zip(lon, lat)))])
        except Exception:  # noqa: BLE001
            return None, None
    ly = out["lossyear"]
    loss = ly[ly > 0]
    year = int(2000 + np.median(loss)) if loss.size >= max(3, 0.3 * ly.size) else None
    cover = float(np.median(out["treecover2000"]))
    return year, cover


def analyze(c, years):
    tile = S2.tile_of(c["lat"], c["lon"])
    epsg, x0, y1 = S2.window_origin(tile, c["lon"], c["lat"])
    imgs, skipped = {}, []

    def load(ys):
        for y in ys:
            if y in imgs or y in skipped:
                continue
            r = year_image(tile, y, x0, y1)
            if r is None:
                skipped.append(y)
            else:
                imgs[y] = r

    resp = {}
    # pista já desenhada (OSM) ou com cabeceiras (OurAirports): o eixo é esse, com um
    # ajuste fino. A imagem só serve para datar e ver a situação. Sem isso, o filtro
    # procura a faixa reta mais forte perto do ponto (e às vezes pega rio ou estrada).
    known = None
    if c.get("ends"):
        (lo1, la1), (lo2, la2) = c["ends"]
        _, xa, ya = S2.utm_xy(tile, lo1, la1)
        _, xb, yb = S2.utm_xy(tile, lo2, la2)
        if 200 <= np.hypot(xb - xa, yb - ya) <= 3500:
            known = (((xa - x0) / S2.PX - .5, (y1 - ya) / S2.PX - .5),
                     ((xb - x0) / S2.PX - .5, (y1 - yb) / S2.PX - .5))
    floor = KNOWN_MIN if known else MIN_SCORE * 0.8

    def best_of():
        best = None
        for y, (v, water, date) in imgs.items():
            if y not in resp:
                resp[y] = S2.fit_axis(v, *known) if known else S2.line_response(v, search=50)
            r = resp[y]
            if r is not None and (best is None or r[0] > best[0][0]):
                best = (r, y)
        return best

    res = {"tile": tile, "checked": dt.date.today().isoformat()}
    if known:
        res["axis"] = "conhecido"
    # primeiro uns poucos anos espalhados: se não houver pista em nenhum, para aqui
    probe = [y for y in (years[-1], years[-2], years[-4], years[2]) if y in years]
    load(probe)
    best = best_of()
    if best is None or best[0][0] < floor:
        load([y for y in years if y not in probe][-3:])
        best = best_of()
    if best is None or best[0][0] < floor:
        res["status"] = "sem confirmação"
        res["why"] = "sem imagem boa" if best is None else "fraca"
        res["skipped"] = sorted(skipped)
        return res
    load(years)
    # imagem com névoa ou nuvem fina que a máscara não pegou: a vegetação da janela
    # fica bem mais apagada que nos outros anos. Esse ano também é ignorado.
    q = {y: float(np.nanpercentile(v, 90)) for y, (v, w, d) in imgs.items()}
    med = float(np.median(list(q.values())))
    for y in [y for y in imgs if q[y] < med - 0.1]:
        imgs.pop(y)
        resp.pop(y, None)
        skipped.append(y)
    best = best_of()
    res["skipped"] = sorted(skipped)
    if best is None:
        res["status"] = "sem confirmação"
        res["why"] = "sem imagem boa"
        return res
    if known:
        (score, th, ry, a, b, k), yref = best
        con, cen, side = S2.axis_profile(imgs[yref][0], th, ry, k)
    else:
        (score, th, ry, rx, k), yref = best
        con, cen, side = S2.axis_profile(imgs[yref][0], th, ry, k)
        a, b = S2.extent(con, rx, OPEN_T)
    length = (b - a + 1) * S2.PX
    (ax_, ay_), (bx_, by_) = S2.unrotate(th, ry, a), S2.unrotate(th, ry, b)
    # pixel -> UTM -> lon/lat
    pts = np.array([[x0 + (ax_ + .5) * S2.PX, y1 - (ay_ + .5) * S2.PX],
                    [x0 + (bx_ + .5) * S2.PX, y1 - (by_ + .5) * S2.PX]])
    lo, la = S2.to_lonlat(epsg, pts[:, 0], pts[:, 1])
    res.update(score=round(score, 3), ref_year=yref, length=int(length),
               ends=[[round(lo[0], 5), round(la[0], 5)], [round(lo[1], 5), round(la[1], 5)]])
    # água no eixo (rio) e pista encostada na borda da janela (estrada/rio longo)
    fp = S2.footprint(th, ry, a, b, pad=1)
    wat = float(imgs[yref][1][fp].mean()) if fp.any() else 0.0
    r_edge = max(np.hypot(ax_ - S2.N / 2, ay_ - S2.N / 2), np.hypot(bx_ - S2.N / 2, by_ - S2.N / 2))
    side_ndvi = float(np.median(side[a:b + 1]))
    res["side"] = round(side_ndvi, 2)
    ok = side_ndvi >= MIN_SIDE and score >= MIN_SCORE and MIN_LEN <= length <= MAX_LEN and wat < 0.3 and r_edge < S2.N / 2 - 4
    if known:
        ok = wat < 0.3   # o desenho já diz que é pista; só não pode ser rio
    if not ok:
        res["status"] = "sem confirmação"
        res["why"] = ("água" if wat >= 0.3 else "fraca" if score < MIN_SCORE else "sem vegetação em volta" if side_ndvi < MIN_SIDE else
                      "longa demais" if length > MAX_LEN or r_edge >= S2.N / 2 - 4 else "curta")
        return res
    # achada só pelo detector: estrada, rio e canal de rejeito também são faixas retas.
    # Pista acaba no mato numa ponta e, na outra, dá num acesso só ou numa clareira.
    if c.get("srcs") == ["detector"] and not (SHOW_DETECTOR and model_ready()):
        ends = sorted(S2.end_branches(imgs[yref][0], th, ry, a, b, side_ndvi - OPEN_T), key=lambda e: e[1])
        res["branches"] = [[round(f, 2), n] for f, n in ends]
        if ends[0][1] > 0 or not (ends[1][1] <= 1 or ends[1][0] >= 0.4):
            res["status"] = "sem confirmação"
            res["why"] = "estrada ou rio"
            return res
    # série anual no eixo fixo
    series = {}
    for y, (v, water, date) in sorted(imgs.items()):
        cy, cc, ss = S2.axis_profile(v, th, ry, k)
        seg = cy[a:b + 1]
        series[y] = {"open": round(float((seg > OPEN_T).mean()), 2), "con": round(float(np.median(seg)), 3),
                     "date": date}
    res["series"] = series
    ys = sorted(series)
    peak = max(series[y]["con"] for y in ys)
    is_open = {y: series[y]["open"] >= 0.5 and series[y]["con"] >= max(0.1, 0.4 * peak) for y in ys}
    is_closed = {y: series[y]["open"] < 0.3 for y in ys}
    # um ano isolado não muda a história: aberta = dois anos bons seguidos abertos
    # (ou o último ano, se bem nítida)
    def opened(i):
        if not is_open[ys[i]]:
            return False
        if i + 1 < len(ys):
            return is_open[ys[i + 1]]
        return series[ys[i]]["open"] >= 0.8 and series[ys[i]]["con"] >= 0.3
    first_open = next((ys[i] for i in range(len(ys)) if opened(i)), None)
    if first_open is None:
        if "apontada" in (c.get("srcs") or [c.get("src")]):
            # quem apontou viu a pista no satélite; mato tomando a faixa = perdendo uso
            res["status"] = "perdendo uso"
            res["why"] = "apontada, faixa tomada pelo mato"
            return res
        res["status"] = "sem confirmação"
        res["why"] = "não abre"
        return res
    before = [y for y in ys if y < first_open]
    if before and is_closed[before[-1]]:
        res["born"] = [before[-1], first_open]       # fechada em A, aberta em B
    elif before:
        res["born"] = [None, first_open]
    else:
        # já aberta na primeira imagem boa: olha a perda de floresta Hansen no eixo
        n = max(5, int(length / 30))
        t = np.linspace(0, 1, n)
        axy = np.column_stack([pts[0, 0] + (pts[1, 0] - pts[0, 0]) * t, pts[0, 1] + (pts[1, 1] - pts[0, 1]) * t])
        hy, cover = hansen_years(epsg, axy)
        if hy is not None and hy < first_open:
            res["born"] = [hy, hy]
            res["born_src"] = "hansen"
        elif cover is not None and cover < 30:
            res["born"] = [None, 2000]
            res["born_src"] = "hansen2000"
        else:
            res["born"] = [None, first_open]
    # situação: média dos dois últimos anos com imagem boa
    last = ys[-1]
    tail = [series[y]["open"] for y in ys[-2:]]
    recent = float(np.mean(tail))
    after = [y for y in ys if y > first_open]
    shut_pair = any(is_closed[after[i]] and is_closed[after[i + 1]] for i in range(len(after) - 1))
    if recent >= 0.6:
        res["status"] = "reaberta" if shut_pair and is_open[last] else "ativa"
    elif recent < 0.3 and max(tail) < 0.4:
        res["status"] = "abandonada"
        res["closed_since"] = next((y for y in after if all(series[z]["open"] < 0.4 for z in ys if z >= y)), last)
    else:
        res["status"] = "perdendo uso"
    res["last"] = last
    return res


# ------------------------------------------------------------------ busca de pistas novas
# Além das candidatas conhecidas, o detector varre a imagem mais recente em volta
# dos garimpos (janelas de 2 km em cada quadro de ~2 km com garimpo). O que ele
# acha entra como candidata e passa pela mesma checagem ano a ano.
SCAN_G = 0.018
# Pistas achadas só pelo detector: na conferência por amostra (nov/2026) só 1 em cada 4
# era pista; o resto era estrada, rio ou canal de garimpo. O modelo próprio
# (airstrip_model.py) já tira bem rio, rua e asfalto, mas ainda aprova estrada de terra
# larga e fileira de cavas de garimpo, que não estão nos exemplos de treino. Fica
# desligado até o treino ganhar esses exemplos.
SHOW_DETECTOR = False
P_KEEP = 0.3       # chance mínima (modelo) para uma pista indicada por OSM/OurAirports/MapBiomas ficar no mapa
P_DETECTOR = 0.8   # chance mínima para uma pista achada só pelo detector


def model_ready():
    import airstrip_model as AM
    return AM.MODEL.exists()


def pista_chance(r):
    import airstrip_model as AM
    p = AM.predict(r.get("x")) if r.get("x") and r.get("x_v") == AM.FEAT_V else None
    return None if p is None else round(p, 2)


def classify(sites, items, workers, budget_min):
    """Medidas do modelo próprio para cada pista confirmada na imagem (a chance sai na hora de gravar)."""
    import airstrip_model as AM
    if not model_ready():
        return
    mid = AM.FEAT_V
    todo = [(c, items[key_of(c)]) for c in sites if key_of(c) in items and items[key_of(c)].get("ends")
            and items[key_of(c)].get("status") not in (None, "sem confirmação") and items[key_of(c)].get("x_v") != mid]
    print(f"Modelo de pistas: {len(todo)} para medir")
    deadline = time.time() + budget_min * 60
    with ThreadPoolExecutor(workers) as ex:
        futs = {ex.submit(AM.measure_example, {"ends": r["ends"]}): r for c, r in todo}
        for f in as_completed(futs):
            r = futs[f]
            try:
                m = f.result()
            except Exception as e:  # noqa: BLE001
                print(f"  ! modelo: {e}")
                continue
            r["x"] = [round(v, 4) for v in m[0]] if m else None
            r["x_v"] = mid
            if time.time() > deadline:
                for g in futs:
                    g.cancel()
                break
SCAN_SCORE = 0.3


def scan_cells():
    doc = C.read_json(C.DATA_DIR / "mining" / "detections.json")
    if not doc:
        return []
    d = np.asarray(doc["data"], float).reshape(-1, 5)
    cells = {}
    for lon, lat, per in zip(d[:, 0] / 1000, d[:, 1] / 1000, d[:, 2]):
        k = (int(np.floor(lon / SCAN_G)), int(np.floor(lat / SCAN_G)))
        cells[k] = max(cells.get(k, 0), per)
    # garimpo mais recente primeiro
    return [k for k, _ in sorted(cells.items(), key=lambda t: -t[1])]


def scan_one(cell, years):
    lon, lat = (cell[0] + 0.5) * SCAN_G, (cell[1] + 0.5) * SCAN_G
    if not in_legal([lon], [lat])[0]:
        return None
    tile = S2.tile_of(lat, lon)
    epsg, x0, y1 = S2.window_origin(tile, lon, lat)
    for y in (years[-1], years[-2]):
        r = year_image(tile, y, x0, y1, tries=4)
        if r is not None:
            break
    else:
        return None
    v, water, date = r
    score, th, ry, rx, k = S2.line_response(v)
    if score < SCAN_SCORE:
        return None
    con, cen, side = S2.axis_profile(v, th, ry, k)
    a, b = S2.extent(con, rx, OPEN_T)
    length = (b - a + 1) * S2.PX
    (ax_, ay_), (bx_, by_) = S2.unrotate(th, ry, a), S2.unrotate(th, ry, b)
    edge = max(np.hypot(ax_ - S2.N / 2, ay_ - S2.N / 2), np.hypot(bx_ - S2.N / 2, by_ - S2.N / 2))
    fp = S2.footprint(th, ry, a, b, pad=1)
    wat = float(water[fp].mean()) if fp.any() else 0.0
    if not (400 <= length <= 1800) or edge >= S2.N / 2 - 4 or wat >= 0.2 or k > 2:
        return None
    mx, my = (ax_ + bx_) / 2, (ay_ + by_) / 2
    lo, la = S2.to_lonlat(epsg, [x0 + (mx + .5) * S2.PX], [y1 - (my + .5) * S2.PX])
    return [round(lo[0], 5), round(la[0], 5)]


def run_scan(budget_min, workers, years):
    p = CACHE / "scan.json"
    doc = C.read_json(p, {}) or {}
    if doc.get("version") != VERSION:
        doc = {"version": VERSION, "cells": {}}
    done = doc["cells"]
    todo = [c for c in scan_cells() if f"{c[0]},{c[1]}" not in done]
    print(f"Busca de pistas novas em volta de garimpos: {len(todo)} quadros a varrer ({len(done)} já varridos)")
    deadline = time.time() + budget_min * 60
    n = found = 0
    with ThreadPoolExecutor(workers) as ex:
        it = iter(todo)
        futs = {}
        for _ in range(workers * 2):
            c = next(it, None)
            if c is not None:
                futs[ex.submit(scan_one, c, years)] = c
        while futs:
            f = next(as_completed(list(futs)))
            c = futs.pop(f)
            try:
                r = f.result()
                done[f"{c[0]},{c[1]}"] = r or 0
                found += bool(r)
            except Exception as e:  # noqa: BLE001
                print(f"  ! busca {c}: {e}")
            n += 1
            if n % 200 == 0:
                print(f"  {n}/{len(todo)} quadros, {found} pistas possíveis")
                C.write_json(p, doc)
            if time.time() < deadline:
                c = next(it, None)
                if c is not None:
                    futs[ex.submit(scan_one, c, years)] = c
    C.write_json(p, doc)
    print(f"  varridos nesta rodada: {n}; pistas possíveis: {found}")
    return [{"lon": v[0], "lat": v[1], "src": "detector", "name": "", "ends": None, "closed": False}
            for v in done.values() if v]


# ------------------------------------------------------------------ garimpo

def mining_points():
    doc = C.read_json(C.DATA_DIR / "mining" / "detections.json")
    if not doc:
        return None
    d = np.asarray(doc["data"], float).reshape(-1, 5)
    return d[:, 0] / 1000, d[:, 1] / 1000


def nearest_km(lon, lat, mp):
    from scipy.spatial import cKDTree
    if mp is None or not len(lon):
        return [None] * len(lon)
    k = np.cos(np.radians(-5))
    tree = cKDTree(np.column_stack([mp[0] * 111.32 * k, mp[1] * 110.57]))
    d, _ = tree.query(np.column_stack([np.asarray(lon) * 111.32 * k, np.asarray(lat) * 110.57]))
    return [round(float(x), 1) for x in d]


# ------------------------------------------------------------------ principal

def key_of(c):
    return f"{c['lon']:.4f},{c['lat']:.4f}"


def run(budget_min: float, workers: int, limit: int | None, scan_share: float):
    t0 = time.time()
    CACHE.mkdir(parents=True, exist_ok=True)
    this_year = dt.date.today().year
    years = list(range(S2.FIRST_YEAR, this_year + 1))
    found = run_scan(budget_min * scan_share, workers, years) if scan_share > 0 else []
    print("Fontes de pistas")
    cands, reg = [], []
    for fn in (from_ourairports, from_osm, from_mapbiomas, from_anac, from_reports):  # OurAirports antes: dá os nomes de cidade
        try:
            c, r = fn()
        except Exception as e:  # noqa: BLE001
            print(f"  ! {fn.__name__}: {e}")
            continue
        cands += c
        reg += r
    sites = merge(cands + found, reg)
    print(f"  {len(sites)} candidatas sem registro na Amazônia Legal ({len(reg)} pistas registradas como referência)")
    if not sites:
        raise SystemExit("nenhuma candidata")

    results_p = CACHE / "results.json"
    store = C.read_json(results_p, {}) or {}
    if store.get("version") != RESULTS_VERSION:
        store = {"version": RESULTS_VERSION, "items": {}}
    items = store["items"]
    stale_before = (dt.date.today() - dt.timedelta(days=45)).isoformat()
    fo = in_forest([c["lon"] for c in sites], [c["lat"] for c in sites])
    if SHOW_DETECTOR and model_ready():
        for k_ in [k_ for k_, v_ in items.items() if v_.get("why") == "estrada ou rio"]:
            items.pop(k_)
    todo = [c for c, f in sorted(zip(sites, fo), key=lambda t: not t[1]) if key_of(c) not in items]   # floresta primeiro
    todo += sorted((c for c in sites if key_of(c) in items and items[key_of(c)].get("checked", "") < stale_before),
                   key=lambda c: items[key_of(c)].get("checked", ""))
    if limit:
        todo = todo[:limit]
    print(f"Conferindo no Sentinel-2: {len(todo)} pistas (orçamento {budget_min:.0f} min, {workers} em paralelo)")
    deadline = t0 + budget_min * 60   # o que sobrou depois da busca
    done = 0
    with ThreadPoolExecutor(workers) as ex:
        futs = {}
        it = iter(todo)

        def submit_next():
            if time.time() > deadline:
                return False
            c = next(it, None)
            if c is None:
                return False
            futs[ex.submit(analyze, c, years)] = c
            return True

        for _ in range(workers * 2):
            if not submit_next():
                break
        while futs:
            for f in as_completed(list(futs)):
                c = futs.pop(f)
                try:
                    items[key_of(c)] = f.result()
                except Exception as e:  # noqa: BLE001
                    print(f"  ! {key_of(c)}: {e}")
                done += 1
                if done % 50 == 0:
                    print(f"  {done}/{len(todo)} ({(time.time() - t0) / 60:.0f} min)")
                    C.write_json(results_p, store)
                submit_next()
                break
    C.write_json(results_p, store)
    print(f"  conferidas nesta rodada: {done}; faltam {max(0, len(todo) - done)}")
    classify(sites, items, workers, max(5.0, (deadline - time.time()) / 60 + 20))
    C.write_json(results_p, store)
    write_output(sites, items, this_year)


FUNAI_TI = ("https://geoserver.funai.gov.br/geoserver/Funai/ows?service=WFS&version=1.0.0&request=GetFeature"
            "&typeName=Funai%3Atis_poligonais&outputFormat=application%2Fjson")


def indigenous_lands():
    """Terras indígenas (FUNAI), simplificadas e guardadas em cache. Só contexto no popup:
    pista dentro de TI não vira 'aldeia' por isso (garimpo em TI também tem pista)."""
    from shapely.geometry import shape
    cache = CACHE / "ti.json"
    doc = None
    try:
        import requests
        r = requests.get(FUNAI_TI, timeout=600, headers=C.UA)
        r.raise_for_status()
        raw = r.json()
        feats = []
        for f in raw.get("features", []):
            p = f.get("properties") or {}
            name = next((p[k] for k in ("terrai_nom", "terra_indigena", "nome", "ti_nome") if p.get(k)), "")
            try:
                g = shape(f["geometry"]).simplify(0.002, preserve_topology=True)
            except Exception:  # noqa: BLE001
                continue
            if g.is_empty:
                continue
            b = g.bounds
            if b[2] < BBOX[0] or b[0] > BBOX[2] or b[3] < BBOX[1] or b[1] > BBOX[3]:
                continue
            feats.append({"name": str(name).strip(), "geometry": g.__geo_interface__})
        if feats:
            doc = {"checked": dt.date.today().isoformat(), "features": feats}
            C.write_json(cache, doc)
    except Exception as e:  # noqa: BLE001
        print(f"  ! FUNAI terras indígenas: {e}")
    if doc is None:
        doc = lands_from_osm()
        if doc:
            C.write_json(cache, doc)
    if doc is None:
        doc = C.read_json(cache) if cache.exists() else None
        if doc:
            print("  Terras indígenas: usando o cache")
    if not doc:
        return None
    print(f"  Terras indígenas: {len(doc['features'])}")
    return [(f["name"], shape(f["geometry"])) for f in doc["features"]]


def lands_from_osm():
    """Terras indígenas mapeadas no OSM (boundary=aboriginal_lands ou área protegida classe 24)."""
    from shapely.geometry import LineString
    from shapely.ops import polygonize, unary_union
    q = f"""[out:json][timeout:900];
(relation["boundary"="aboriginal_lands"]({BBOX[1]},{BBOX[0]},{BBOX[3]},{BBOX[2]});
 relation["boundary"="protected_area"]["protect_class"="24"]({BBOX[1]},{BBOX[0]},{BBOX[3]},{BBOX[2]}););
out geom;"""
    import requests
    for url in OVERPASS:
        try:
            r = requests.post(url, data={"data": q}, timeout=1200, headers=C.UA)
            r.raise_for_status()
            els = r.json().get("elements", [])
            break
        except Exception as e:  # noqa: BLE001
            print(f"  ! Overpass (terras indígenas) {url}: {e}")
    else:
        return None
    feats = []
    for el in els:
        lines = [LineString([(p["lon"], p["lat"]) for p in m["geometry"]]) for m in el.get("members", [])
                 if m.get("type") == "way" and m.get("role") in ("outer", "") and len(m.get("geometry") or []) >= 2]
        if not lines:
            continue
        g = unary_union(list(polygonize(unary_union(lines))))
        if g.is_empty:
            continue
        g = g.simplify(0.002, preserve_topology=True)
        name = re.sub(r"(?i)^terra ind[ií]gena\s+", "", el.get("tags", {}).get("name", "")).strip()
        feats.append({"name": name, "geometry": g.__geo_interface__})
    print(f"  Terras indígenas (OSM): {len(feats)}")
    return {"checked": dt.date.today().isoformat(), "source": "osm", "features": feats} if feats else None


# Ecorregiões RESOLVE 2017 (CC-BY 4.0): separa a floresta amazônica do Cerrado, Pantanal e da faixa de transição
# do Mato Grosso, onde quase toda pista sem registro é de fazenda.
ECOREGIONS = "https://storage.googleapis.com/teow2016/Ecoregions2017.zip"
FOREST_BIOMES = {1, 14}   # florestas úmidas tropicais e mangues
NOT_AMAZON = {481, 439, 443, 485, 444, 457, 477, 493, 504}   # transição do MT, Mata Atlântica e Andes
NEAR_MINING_KM = 20


def amazon_forest():
    """Polígono simplificado da floresta amazônica, guardado em cache (o zip original tem 150 MB)."""
    from shapely.geometry import shape
    from shapely.ops import unary_union
    cache = CACHE / "bioma.json"
    if cache.exists():
        doc = C.read_json(cache)
        return shape(doc["geometry"]) if doc else None
    try:
        import shapefile
        import requests
        r = requests.get(ECOREGIONS, timeout=900, headers=C.UA)
        r.raise_for_status()
        z = zipfile.ZipFile(io.BytesIO(r.content))
        part = {e: io.BytesIO(z.read(n)) for n in z.namelist() for e in ("shp", "shx", "dbf") if n.lower().endswith("." + e)}
        sf = shapefile.Reader(shp=part["shp"], shx=part["shx"], dbf=part["dbf"], encoding="latin1")
        keep = []
        for i, rec in enumerate(sf.iterRecords(fields=["ECO_ID", "BIOME_NUM"])):
            if int(rec["BIOME_NUM"]) not in FOREST_BIOMES or int(rec["ECO_ID"]) in NOT_AMAZON:
                continue
            shp = sf.shape(i)
            b = shp.bbox
            if b[2] < BBOX[0] or b[0] > BBOX[2] or b[3] < BBOX[1] or b[1] > BBOX[3]:
                continue
            keep.append(shape(shp.__geo_interface__).buffer(0))
        g = unary_union(keep).simplify(0.01, preserve_topology=True)
    except Exception as e:  # noqa: BLE001
        print(f"  ! ecorregiões: {e}")
        return None
    C.write_json(cache, {"source": "RESOLVE Ecoregions 2017", "checked": dt.date.today().isoformat(),
                         "geometry": g.__geo_interface__})
    return g


def in_forest(lons, lats):
    import shapely
    g = amazon_forest()
    if g is None:
        return np.ones(len(lons), bool)
    return shapely.contains_xy(g, np.asarray(lons), np.asarray(lats))


# Sedes de município (código IBGE, nome, lat/lon), CSV público no GitHub (kelvins/municipios-brasileiros, MIT),
# guardado em cache. Serve para conferir se uma pista "de cidade" tem mesmo cidade perto.
MUNICIPIOS = "https://raw.githubusercontent.com/kelvins/municipios-brasileiros/main/csv/municipios.csv"
SEAT_KM = 6          # sede a até 6 km: pista de cidade
SEAT_NAME_KM = 25    # ou o nome da pista é o da sede mais perto, a até 25 km (aeroporto longe do centro)
_seats = None


def town_seats():
    global _seats
    if _seats is None:
        cache = CACHE / "municipios.csv"
        try:
            txt = C.get_text(MUNICIPIOS, timeout=120)
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_text(txt)
        except Exception as e:  # noqa: BLE001
            print(f"  ! municípios: {e}")
            txt = cache.read_text() if cache.exists() else ""
        rows = list(csv.DictReader(io.StringIO(txt)))
        _seats = [(float(r["longitude"]), float(r["latitude"]), _fold(r["nome"])) for r in rows] if rows else []
    return _seats


def real_town(lon, lat, name):
    """A pista 'de cidade ou vila' tem mesmo uma sede de município perto?"""
    seats = town_seats()
    if not seats:
        return True
    k = np.cos(np.radians(lat))
    best = min(seats, key=lambda t: ((t[0] - lon) * k) ** 2 + (t[1] - lat) ** 2)
    km = np.hypot((best[0] - lon) * k, best[1] - lat) * 111
    stem = _fold(re.sub(r"(?i)^(aeroporto|aerodromo|aeródromo|pista)( municipal)?( de| do| da)?\s+|\s+(airport|airfield|airstrip)$", "", name or ""))
    return km <= SEAT_KM or (km <= SEAT_NAME_KM and bool(stem) and (stem == best[2] or best[2].startswith(stem) or stem.startswith(best[2])))


def ti_names(lons, lats, lands):
    if not lands:
        return [""] * len(lons)
    from shapely import STRtree
    from shapely.geometry import Point
    geoms = [g for _, g in lands]
    tree = STRtree(geoms)
    out = []
    for lo, la in zip(lons, lats):
        pt = Point(lo, la)
        hit = [i for i in tree.query(pt) if geoms[i].contains(pt)]
        out.append(re.sub(r"(?i)^terra ind[ií]gena\s+", "", lands[hit[0]][0]).strip().title()[:50] if hit else "")
    return out


def registered_rows():
    """Aeródromos da ANAC na Amazônia Legal, com o traçado do OSM quando há pista desenhada perto."""
    from scipy.spatial import cKDTree
    regs = [r for r in REGISTERED if in_legal([r["lon"]], [r["lat"]])[0]]
    if not regs:
        return []
    k = np.cos(np.radians(-5))
    xy = lambda lo, la: (lo * 111.32 * k * 1000, la * 110.57 * 1000)  # noqa: E731
    tree = cKDTree(np.array([xy(lo, la) for lo, la, _ in RUNWAYS])) if RUNWAYS else None
    out, seen = [], set()
    for r in regs:
        key = (round(r["lon"], 3), round(r["lat"], 3))
        if key in seen:
            continue
        seen.add(key)
        ends = None
        if tree is not None:
            d, j = tree.query(xy(r["lon"], r["lat"]))
            if d <= 1500:
                ends = RUNWAYS[j][2]
        e = [round(v, 5) for p in ends for v in p] if ends else [None] * 4
        uf = r["uf"].strip()
        uf = uf.upper() if len(uf) == 2 else UF_NAMES.get(_fold(uf), "")
        place = f"{r['town']}/{uf}" if r["town"] and uf else r["town"]
        out.append([round(r["lon"], 5), round(r["lat"], 5), *e, 1 if r["pub"] else 0,
                    r["name"][:60], r["code"][:8], place[:40]])
    return out


def write_output(sites, items, this_year):
    mp = mining_points()
    rows = []
    counts = {}
    for c in sites:
        r = items.get(key_of(c))
        if not r:
            continue
        det = c["srcs"] == ["detector"]
        if det and not SHOW_DETECTOR:
            continue
        p = pista_chance(r)
        told = "apontada" in c["srcs"]   # vista por quem usa o site: o modelo não tira
        if not told and (det and (p is None or p < P_DETECTOR) or p is not None and p < P_KEEP):
            if r.get("status") not in (None, "sem confirmação"):
                counts["parece estrada ou rio"] = counts.get("parece estrada ou rio", 0) + 1
            continue
        st = r.get("status", "sem confirmação")
        counts[st] = counts.get(st, 0) + 1
        if st == "sem confirmação":
            continue
        rows.append((c, r))
    lon = [((r["ends"][0][0] + r["ends"][1][0]) / 2) for c, r in rows]
    lat = [((r["ends"][0][1] + r["ends"][1][1]) / 2) for c, r in rows]
    dist = nearest_km(lon, lat, mp)
    lands = indigenous_lands()
    tis = ti_names(lon, lat, lands)
    forest = in_forest(lon, lat)
    data = []
    for (c, r), x, y, km, ti, fo in zip(rows, lon, lat, dist, tis, forest):
        # 1 perto de garimpo ou em terra indígena, 2 floresta amazônica, 3 Cerrado/Pantanal/transição (fazendas)
        prio = 1 if ti or (km is not None and km <= NEAR_MINING_KM) else 2 if fo else 3
        cat = CATS[c.get("cat")]
        # "vila" sem sede de município perto e colada a garimpo é vila garimpeira: conta como sem registro
        if cat == 2 and km is not None and km <= NEAR_MINING_KM and not real_town(x, y, c["names"][0] if c.get("names") else ""):
            cat = 0
        ser = r.get("series", {})
        yrs = range(S2.FIRST_YEAR, this_year + 1)
        # 0-9 = fração da pista aberta naquele ano; "-" = imagem ruim, ano ignorado
        s = "".join(str(min(9, int(ser[str(y)]["open"] * 10))) if str(y) in ser else
                    (str(min(9, int(ser[y]["open"] * 10))) if y in ser else "-") for y in yrs)
        born = r.get("born") or [None, None]
        src = sum(SRC_BITS[s_] for s_ in c["srcs"])
        data.append([
            round(x, 5), round(y, 5),
            r["ends"][0][0], r["ends"][0][1], r["ends"][1][0], r["ends"][1][1],
            r["length"], born[0], born[1], STATUS[r["status"]], r.get("last"), r.get("closed_since"),
            km, src, s, (c["names"][0] if c.get("names") else "")[:60], cat, ti, prio, pista_chance(r),
        ])
    by_year = {}
    for row in data:
        if row[8] and row[16] == 0:
            by_year[row[8]] = by_year.get(row[8], 0) + 1
    cats = {k: sum(1 for row in data if row[16] == v) for k, v in (("sem registro", 0), ("aldeia", 1), ("cidade", 2))}
    reg = registered_rows()
    cats["registrada"] = len(reg)
    cats["em terra indígena"] = sum(1 for row in data if row[17] and row[16] == 0)
    prios = {k: sum(1 for row in data if row[18] == v and row[16] == 0)
             for k, v in (("perto de garimpo ou em TI", 1), ("floresta", 2), ("fora da floresta", 3))}
    C.write_json(OUT / "airstrips.json", {
        "v": 1,
        "layer": "airstrips",
        "kind": "pistas de pouso sem registro encontrado (suspeitas), conferidas no Sentinel-2",
        "source": "OpenStreetMap (ODbL), OurAirports (domínio público), MapBiomas; imagens Copernicus Sentinel-2 L2A; "
                  "perda de floresta Hansen/UMD; garimpo Amazon Mining Watch; cadastro de aeródromos ANAC; terras indígenas FUNAI ou OpenStreetMap; "
                  "ecorregiões RESOLVE 2017",
        "first_year": S2.FIRST_YEAR,
        "fields": ["lon", "lat", "lon1", "lat1", "lon2", "lat2", "comprimento_m", "surgiu_depois_de", "surgiu_ate",
                   "situacao(1 ativa,2 perdendo uso,3 abandonada,4 reaberta)", "ultimo_ano_visto", "fechada_desde",
                   "garimpo_km", "fontes(1 osm,2 ourairports,4 mapbiomas,8 detector,16 apontada)", "aberta_por_ano", "nome",
                   "categoria(0 sem registro,1 aldeia,2 cidade ou vila)", "terra_indigena",
                   f"prioridade(1 garimpo a {NEAR_MINING_KM} km ou TI,2 floresta amazônica,3 Cerrado/Pantanal/transição)",
                   "chance_de_ser_pista(modelo)"],
        "reg_fields": ["lon", "lat", "lon1", "lat1", "lon2", "lat2", "publico", "nome", "codigo", "municipio_uf"],
        "counts": counts,
        "cats": cats,
        "prios": prios,
        "updated": C.now_iso(),
        "data": data,
        "reg": reg,
    })
    C.update_manifest("airstrips", {"count": prios["perto de garimpo ou em TI"] + prios["floresta"], "updated": C.now_iso(), "counts": counts,
                                    "cats": cats,
                                    "years": sorted(by_year)})
    C.update_stats("airstrips", "novas_por_ano", by_year)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--budget", type=float, default=200, help="minutos de análise de imagem nesta rodada")
    ap.add_argument("--workers", type=int, default=16)
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--scan-share", type=float, default=0.35, help="fração do orçamento para buscar pistas novas")
    a = ap.parse_args()
    run(a.budget, a.workers, a.limit, a.scan_share)
