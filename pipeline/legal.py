"""Garimpo com ou sem autorização: cruza cada detecção com os títulos minerários da
ANM (SIGMINE) e com terras indígenas e unidades de conservação.

Fontes (todas guardadas na branch data; o site não consulta nenhuma na hora da visita):
  - ANM SIGMINE, processos minerários por estado (shapefile, dados abertos);
  - WDPA (Protected Planet, UNEP-WCMC), áreas protegidas do Brasil, inclusive terras
    indígenas; se não estiver disponível, terras indígenas da FUNAI (WFS).

Saída: mining/legal.json com uma linha por detecção:
  [lon*1000, lat*1000, titulo, area, nome]
  titulo: 2 = lavra autorizada (concessão de lavra, lavra garimpeira, licenciamento,
          registro de extração); 1 = só pedido ou pesquisa; 0 = nenhum processo
  area:   1 = terra indígena; 2 = UC de proteção integral; 3 = UC de uso sustentável; 0 = fora
  nome:   índice em "nomes" da área protegida (-1 = nenhuma)

Se uma fonte não responder, mantém o resultado anterior dela (do cache).
"""
from __future__ import annotations

import datetime as dt
import io
import json
import tempfile
import time
import unicodedata
import zipfile
from pathlib import Path

import numpy as np

import common as C

UFS = ["AC", "AM", "AP", "MA", "MT", "PA", "RO", "RR", "TO"]   # bacia amazônica no Brasil
SIGMINE = ["https://app.anm.gov.br/dadosabertos/SIGMINE/PROCESSOS_MINERARIOS/{uf}.zip",
           "http://app.anm.gov.br/dadosabertos/SIGMINE/PROCESSOS_MINERARIOS/{uf}.zip"]
# Serviço ArcGIS público da ANM com a mesma camada (processos ativos), paginado de 2000 em 2000.
SIGMINE_API = "https://geo.anm.gov.br/arcgis/rest/services/SIGMINE/dados_anm/FeatureServer/0/query"
# A ANM recusa conexões de fora do Brasil (os servidores do GitHub ficam nos EUA). Quando
# não der para baixar, vale o que estiver em _cache/sigmine: o zip original da ANM
# ({uf}.zip, posto lá à mão ou por outra máquina) ou a versão enxuta já processada.
WDPA = "https://d1gam3xoknrgr2.cloudfront.net/current/WDPA_WDOECM_{mon}{year}_Public_BRA_shp.zip"
FUNAI_WFS = ("https://geoserver.funai.gov.br/geoserver/Funai/ows?service=WFS&version=1.0.0"
             "&request=GetFeature&typeName=Funai:tis_poligonais&outputFormat=application/json")

LAVRA = {"CONCESSAO DE LAVRA", "LAVRA GARIMPEIRA", "LICENCIAMENTO", "REGISTRO DE EXTRACAO"}
INTEGRAL = ("PARQUE", "ESTACAO ECOLOGICA", "RESERVA BIOLOGICA", "MONUMENTO NATURAL",
            "REFUGIO DE VIDA SILVESTRE")


def norm(s) -> str:
    s = unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode()
    return " ".join(s.upper().split())


def detections():
    doc = C.read_json(C.DATA_DIR / "mining" / "detections.json", {}) or {}
    d = doc.get("data") or []
    xy = np.array(d, dtype=float).reshape(-1, 5)[:, :2] / 1000.0 if d else np.zeros((0, 2))
    return xy, doc.get("updated")


def shapes_in_zip(zbytes: bytes):
    """Lê todos os shapefiles de um zip (inclusive zips dentro do zip)."""
    import shapefile

    z = zipfile.ZipFile(io.BytesIO(zbytes))
    names = z.namelist()
    for n in names:
        if n.lower().endswith(".zip"):
            yield from shapes_in_zip(z.read(n))
    for n in names:
        if not n.lower().endswith(".shp"):
            continue
        stem = n[:-4]
        part = {ext: z.read(stem + ext) for ext in (".shp", ".dbf", ".shx", ".cpg") if stem + ext in names}
        cpg = part.get(".cpg", b"").decode("ascii", "ignore").strip().lower()
        enc = "utf-8" if "utf" in cpg else "latin1"
        r = shapefile.Reader(shp=io.BytesIO(part[".shp"]), dbf=io.BytesIO(part[".dbf"]),
                             shx=io.BytesIO(part[".shx"]) if ".shx" in part else None,
                             encoding=enc, encodingErrors="replace")
        fields = [f[0] for f in r.fields[1:]]
        print(f"    {n}: {len(r)} feições ({enc}); campos {fields}")
        for sr in r.iterShapeRecords():
            yield sr.shape, dict(zip(fields, sr.record))


def hit_polygons(xy, tree, shp_iter, classify):
    """Para cada feição cuja caixa envolve alguma detecção, testa ponto no polígono.
    classify(props) -> (valor, nome) ou None. Devolve {indice_detecção: (valor, nome)}
    ficando com o maior valor quando há sobreposição."""
    from shapely import box, contains_xy, make_valid
    from shapely.geometry import shape as to_geom

    out = {}
    n = 0
    for shp, props in shp_iter:
        if not shp.points:
            continue
        x0, y0, x1, y1 = shp.bbox
        cand = tree.query(box(x0, y0, x1, y1))
        if not len(cand):
            continue
        c = classify(props)
        if c is None:
            continue
        try:
            geom = to_geom(shp.__geo_interface__)
            if not geom.is_valid:
                geom = make_valid(geom)
            inside = cand[contains_xy(geom, xy[cand, 0], xy[cand, 1])]
        except Exception as e:  # noqa: BLE001
            print(f"    ! geometria ilegível: {e}")
            continue
        for i in inside:
            if i not in out or c[0] > out[i][0]:
                out[int(i)] = c
        n += 1
    return out, n


def run_sigmine(xy, tree, tmp: Path):
    def classify(p):
        fase = norm(p.get("FASE") or p.get("fase"))
        if not fase:
            return None
        return (2 if fase in LAVRA else 1, fase)

    cdir = C.DATA_DIR / "_cache" / "sigmine"
    cdir.mkdir(parents=True, exist_ok=True)
    hits, ok, when = {}, 0, []
    for uf in UFS:
        z = None
        for url in SIGMINE:
            try:
                z = C.download(url.format(uf=uf), tmp / f"{uf}.zip", timeout=600, retries=2).read_bytes()
                origem = "ANM (download)"
                break
            except Exception as e:  # noqa: BLE001
                print(f"  ! SIGMINE {uf} indisponível em {url.split('/')[2]}: {str(e)[:120]}")
        raw, rawj = cdir / f"{uf}.zip", cdir / f"{uf}.geojson"
        feats = None
        if z is None:
            try:
                api_geojson(uf, rawj)
            except Exception as e:  # noqa: BLE001
                print(f"  ! SIGMINE {uf} indisponível em geo.anm.gov.br: {str(e)[:120]}")
        if z is None and raw.exists():
            z, origem = raw.read_bytes(), "zip guardado"
        if z is not None:
            feats = list(shapes_in_zip(z))
        elif rawj.exists():
            # GeoJSON do serviço ArcGIS da ANM (geo.anm.gov.br), baixado de uma máquina no Brasil
            feats = list(geojson_iter(rawj))
            origem = "GeoJSON"
        if feats is not None:
            shp_iter = iter(feats)
            # guarda só os processos perto de garimpo, simplificados, para as próximas vezes
            keep_compact(cdir / f"{uf}.json", xy, tree, feats)
            raw.unlink(missing_ok=True)
            rawj.unlink(missing_ok=True)
            stamp = C.now_iso()
            C.write_json(cdir / f"{uf}.meta.json", {"em": stamp, "origem": origem})
        elif (cdir / f"{uf}.json").exists():
            shp_iter = compact_iter(cdir / f"{uf}.json")
            origem = "versão guardada"
            stamp = (C.read_json(cdir / f"{uf}.meta.json", {}) or {}).get("em")
        else:
            print(f"  ! SIGMINE {uf}: sem dados")
            continue
        h, n = hit_polygons(xy, tree, shp_iter, classify)
        print(f"  SIGMINE {uf} ({origem}): {n} processos sobre detecções, {len(h)} detecções com processo")
        for i, v in h.items():
            if i not in hits or v[0] > hits[i][0]:
                hits[i] = v
        ok += 1
        if stamp:
            when.append(stamp)
    return hits, ok, (min(when) if when else None)


class _Shp:
    """Imita o shape do pyshp a partir de GeoJSON guardado."""

    def __init__(self, g):
        from shapely.geometry import shape as to_geom
        self.__geo_interface__ = g
        self.bbox = to_geom(g).bounds
        self.points = [0]


def api_geojson(uf: str, dest: Path):
    import requests

    feats, off = [], 0
    while True:
        r = requests.get(SIGMINE_API, timeout=120, headers=C.UA, params={
            "where": f"UF='{uf}'", "outFields": "OBJECTID,PROCESSO,FASE,UF,SUBS", "returnGeometry": "true",
            "outSR": 4326, "maxAllowableOffset": 0.0002, "geometryPrecision": 5, "f": "geojson",
            "orderByFields": "OBJECTID", "resultOffset": off, "resultRecordCount": 2000})
        r.raise_for_status()
        page = r.json().get("features") or []
        feats += page
        if len(page) < 2000:
            break
        off += len(page)
        time.sleep(0.5)
    if not feats:
        raise RuntimeError("resposta vazia")
    C.write_json(dest, {"type": "FeatureCollection", "features": feats})
    print(f"  SIGMINE {uf}: {len(feats)} processos baixados de geo.anm.gov.br")


def geojson_iter(path: Path):
    for f in (C.read_json(path, {}) or {}).get("features", []):
        g = f.get("geometry")
        if not g or not g.get("coordinates"):
            continue
        try:
            shp = _Shp(g)
        except Exception:  # noqa: BLE001
            continue
        yield shp, {str(k).upper(): v for k, v in (f.get("properties") or {}).items()}


def compact_iter(path: Path):
    for f in (C.read_json(path, {}) or {}).get("f", []):
        yield _Shp(f["g"]), {"FASE": f["fase"]}


def keep_compact(path: Path, xy, tree, feats):
    from shapely import box
    from shapely.geometry import mapping, shape as to_geom

    out = []
    for shp, props in feats:
        if not shp.points:
            continue
        x0, y0, x1, y1 = shp.bbox
        if not len(tree.query(box(x0 - 0.1, y0 - 0.1, x1 + 0.1, y1 + 0.1))):
            continue
        try:
            g = to_geom(shp.__geo_interface__).simplify(0.0002)
        except Exception:  # noqa: BLE001
            continue
        out.append({"fase": norm(props.get("FASE") or props.get("fase")), "g": mapping(g)})
    C.write_json(path, {"f": out})
    print(f"    guardados {len(out)} processos perto de garimpo")


def wdpa_bytes(tmp: Path):
    today = dt.date.today().replace(day=1)
    for k in range(4):
        m = (today - dt.timedelta(days=28 * k))
        url = WDPA.format(mon=m.strftime("%b"), year=m.year)
        try:
            return C.download(url, tmp / "wdpa.zip", timeout=900, retries=2).read_bytes()
        except Exception as e:  # noqa: BLE001
            print(f"  ! WDPA {m:%b%Y} indisponível: {e}")
    return None


def run_protected(xy, tree, tmp: Path):
    names: list[str] = []

    def name_idx(s):
        if s not in names:
            names.append(s)
        return names.index(s)

    def classify_wdpa(p):
        desig = norm(p.get("DESIG")) + " " + norm(p.get("DESIG_ENG"))
        status = norm(p.get("STATUS"))
        if status and status not in ("DESIGNATED", "INSCRIBED", "ESTABLISHED"):
            return None
        nome = str(p.get("NAME") or p.get("ORIG_NAME") or "").strip()
        tipo = str(p.get("DESIG") or "").strip()
        if tipo and norm(tipo) not in norm(nome):
            nome = f"{tipo} {nome}".strip()
        if "INDIGEN" in desig:
            return (3, ("TI", nome))
        if any(k in desig for k in INTEGRAL) or norm(p.get("IUCN_CAT")) in ("IA", "IB", "II", "III"):
            return (2, ("PI", nome))
        return (1, ("US", nome))

    z = wdpa_bytes(tmp)
    hits, fonte = {}, None
    if z:
        hits, n = hit_polygons(xy, tree, shapes_in_zip(z), classify_wdpa)
        fonte = "WDPA (Protected Planet, UNEP-WCMC)"
        print(f"  WDPA: {n} áreas sobre detecções, {len(hits)} detecções dentro")
    has_ti = any(v[1][0] == "TI" for v in hits.values())
    if not z or not has_ti:
        # sem WDPA (ou WDPA sem terras indígenas): terras indígenas da FUNAI
        try:
            gj = json.loads(C.get_text(FUNAI_WFS, timeout=300))
            from shapely.geometry import shape as to_geom
            from shapely import contains_xy
            from shapely import box as sbox
            n = 0
            for f in gj.get("features", []):
                g = to_geom(f["geometry"])
                cand = tree.query(sbox(*g.bounds))
                inside = cand[contains_xy(g, xy[cand, 0], xy[cand, 1])] if len(cand) else []
                nome = "Terra Indígena " + str((f.get("properties") or {}).get("terrai_nom") or "").strip().title()
                for i in inside:
                    hits[int(i)] = (3, ("TI", nome))
                n += bool(len(inside))
            fonte = (fonte + " e " if fonte else "") + "FUNAI (terras indígenas)"
            print(f"  FUNAI: {n} terras indígenas com detecções")
        except Exception as e:  # noqa: BLE001
            print(f"  ! FUNAI indisponível: {e}")
    code = {"TI": 1, "PI": 2, "US": 3}
    out = {i: (code[v[1][0]], name_idx(v[1][1])) for i, v in hits.items()}
    return out, names, fonte


def run():
    from shapely import STRtree, points

    xy, det_updated = detections()
    if not len(xy):
        raise SystemExit("sem detecções de garimpo")
    tree = STRtree(points(xy[:, 0], xy[:, 1]))
    print(f"{len(xy)} detecções para conferir")
    cache_p = C.DATA_DIR / "_cache" / "legal_cache.json"
    cache = C.read_json(cache_p, {}) or {}
    if cache.get("v") != 2:      # v1 gravou títulos vazios quando a ANM não respondeu
        cache = {"v": 2}
    tmp = Path(tempfile.mkdtemp(prefix="legal"))

    key = lambda i: f"{round(xy[i, 0] * 1000)},{round(xy[i, 1] * 1000)}"  # noqa: E731

    titles, n_uf, stamp = run_sigmine(xy, tree, tmp)
    if n_uf == len(UFS):
        cache["titulo"] = {key(i): v[0] for i, v in titles.items()}
        cache["titulo_fases"] = {key(i): v[1] for i, v in titles.items()}
        cache["titulo_em"] = stamp
    elif n_uf:
        print(f"  SIGMINE só de {n_uf} estados: mantendo a checagem anterior")
    else:
        print("  SIGMINE indisponível: sem checagem de títulos")

    prot, names, fonte = run_protected(xy, tree, tmp)
    if fonte:
        cache["area"] = {key(i): [v[0], names[v[1]]] for i, v in prot.items()}
        cache["area_fonte"] = fonte
        cache["area_em"] = C.now_iso()
    C.write_json(cache_p, cache)

    nomes: list[str] = []
    rows = []
    cnt = {"lavra": 0, "pedido": 0, "sem_titulo": 0, "ti": 0, "uc_pi": 0, "uc_us": 0}
    for i in range(len(xy)):
        k = key(i)
        t = cache["titulo"].get(k, 0) if "titulo" in cache else -1
        a, nome = cache.get("area", {}).get(k, [0, None])
        ni = -1
        if nome:
            if nome not in nomes:
                nomes.append(nome)
            ni = nomes.index(nome)
        x, y = map(int, k.split(","))
        rows.extend((x, y, t, a, ni))
        if t >= 0:
            cnt[["sem_titulo", "pedido", "lavra"][t]] += 1
        if a:
            cnt[["", "ti", "uc_pi", "uc_us"][a]] += 1
    print(f"  resultado: {cnt}")
    C.write_json(C.DATA_DIR / "mining" / "legal.json", {
        "v": 1,
        "kind": "garimpo x títulos minerários e áreas protegidas",
        "titulos_ok": "titulo" in cache,
        "fields": ["lon*1000", "lat*1000", "titulo(2=lavra autorizada,1=pedido/pesquisa,0=nenhum,-1=sem dado)",
                   "area(1=terra indigena,2=UC protecao integral,3=UC uso sustentavel)", "nome"],
        "fontes": {"titulos": "ANM SIGMINE (processos minerários)", "areas": cache.get("area_fonte")},
        "titulos_em": cache.get("titulo_em"), "areas_em": cache.get("area_em"),
        "deteccoes": det_updated,
        "nomes": nomes,
        "contagem": cnt,
        "updated": C.now_iso(),
        "data": rows,
    })
    C.update_manifest("legal", {"updated": C.now_iso(), "contagem": cnt,
                                "titulos_em": cache.get("titulo_em"), "areas_em": cache.get("area_em"),
                                "fonte_areas": cache.get("area_fonte")})


if __name__ == "__main__":
    run()
