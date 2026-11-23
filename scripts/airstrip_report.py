"""Grava uma pista apontada (ou um "não é pista") vinda de uma issue aberta pelo botão do mapa.

Título: "Pista apontada: lat, lon" ou "Não é pista: lat, lon". No "não é pista" o corpo traz
a linha "eixo: [[lon, lat], [lon, lat]]" com as cabeceiras que o mapa desenhou."""
import json
import math
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPORTS = ROOT / "pipeline" / "airstrip_reports.json"
LABELS = ROOT / "pipeline" / "airstrip_labels.json"
title, body = os.environ.get("TITLE", ""), os.environ.get("BODY", "") or ""
num = os.environ.get("NUM", "")
nums = re.findall(r"-?\d+(?:\.\d+)?", title)
if len(nums) < 2:
    sys.exit("título sem latitude e longitude")
lat, lon = float(nums[0]), float(nums[1])
if not (-19 <= lat <= 6 and -75 <= lon <= -43):
    sys.exit(f"fora da Amazônia: {lat}, {lon}")
km = lambda a, b, c, d: math.hypot((b - d) * 111.32 * math.cos(math.radians(a)), (a - c) * 110.57)  # noqa: E731
doc = json.loads(REPORTS.read_text())
day = os.environ.get("DAY", "")
if title.lower().startswith("pista apontada"):
    if any(km(lat, lon, r["lat"], r["lon"]) < 0.3 for r in doc["items"]):
        print("já apontada")
    else:
        doc["items"].append({"lat": round(lat, 5), "lon": round(lon, 5), "nome": "", "em": day, "issue": num})
else:
    doc.setdefault("nao", [])
    if not any(km(lat, lon, r["lat"], r["lon"]) < 0.3 for r in doc["nao"]):
        doc["nao"].append({"lat": round(lat, 5), "lon": round(lon, 5), "em": day, "issue": num})
    m = re.search(r"eixo:\s*(\[\s*\[.*?\]\s*\])", body, re.S)
    if m:
        ends = [[round(float(v), 5) for v in p] for p in json.loads(m.group(1))]
        lab = json.loads(LABELS.read_text())
        mid = f"{(ends[0][0] + ends[1][0]) / 2:.4f},{(ends[0][1] + ends[1][1]) / 2:.4f}"
        if not any(i["id"] == f"lab_{mid}" for i in lab["items"]):
            lab["items"].append({"ends": ends, "label": 0, "kind": "nao_pista_apontada", "id": f"lab_{mid}",
                                 "fonte": f"marcada no site como não pista {day}"})
            LABELS.write_text(json.dumps(lab, ensure_ascii=False, indent=1) + "\n")
REPORTS.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n")
print("ok", lat, lon)
