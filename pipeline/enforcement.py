"""Fiscalização ambiental (protótipo): autos de infração e embargos do Ibama.

Modo "probe": lista os recursos dos conjuntos de dados abertos e mostra o
cabeçalho de cada arquivo, para conferir colunas antes de agregar.
"""
from __future__ import annotations

import csv
import io
import json
import sys
import zipfile

import requests

CKAN = "https://dadosabertos.ibama.gov.br/api/3/action/package_show?id="
DATASETS = ["fiscalizacao-auto-de-infracao", "fiscalizacao-termo-de-embargo"]
UA = {"User-Agent": "amazon-sentry-pipeline/1.0"}
HIDE = ("NOME", "CPF", "CNPJ")


def show_csv(head: bytes) -> None:
    text = head.decode("utf-8", "replace")
    if text.startswith("﻿"):
        text = text[1:]
    sample = text.splitlines()[:4]
    try:
        dialect = csv.Sniffer().sniff(sample[0], delimiters=";,|\t")
    except Exception:
        dialect = csv.excel
    rows = list(csv.reader(sample, dialect))
    if not rows:
        return
    cols = rows[0]
    print("   colunas:", cols)
    for r in rows[1:3]:
        print("   ex:", {c: ("***" if any(h in c.upper() for h in HIDE) else v[:60])
                          for c, v in zip(cols, r)})


def probe_url(url: str) -> None:
    try:
        r = requests.get(url, headers=UA, stream=True, timeout=120)
        print(f"   HTTP {r.status_code} {r.headers.get('content-type')} "
              f"len={r.headers.get('content-length')}")
        if r.status_code != 200:
            return
        if url.lower().endswith(".zip"):
            data = r.content
            z = zipfile.ZipFile(io.BytesIO(data))
            names = z.namelist()
            print(f"   zip com {len(names)} arquivos: {names[:40]}")
            for n in names[:1] + names[-1:]:
                with z.open(n) as f:
                    print("   ->", n)
                    show_csv(f.read(20000))
            return
        head = b""
        for chunk in r.iter_content(65536):
            head += chunk
            if len(head) > 20000:
                break
        r.close()
        if url.lower().endswith(".json"):
            print("   json início:", head[:1500].decode("utf-8", "replace"))
        else:
            show_csv(head)
    except Exception as e:  # noqa: BLE001
        print("   erro:", repr(e))


def probe() -> None:
    for ds in DATASETS:
        print("==", ds)
        try:
            pkg = requests.get(CKAN + ds, headers=UA, timeout=60).json()["result"]
        except Exception as e:  # noqa: BLE001
            print("  erro CKAN:", repr(e))
            continue
        for res in pkg["resources"]:
            print(f" - {res.get('name')} | {res.get('format')} | {res.get('url')}"
                  f" | mod={res.get('last_modified') or res.get('metadata_modified')}")
            probe_url(res["url"])
    print("== portal da transparência")
    for u in ["https://portaldatransparencia.gov.br/download-de-dados/despesas-execucao/202401",
              "https://portaldatransparencia.gov.br/download-de-dados/despesas/20240115"]:
        try:
            r = requests.get(u, headers=UA, timeout=120, stream=True, allow_redirects=True)
            print(u, r.status_code, r.url, r.headers.get("content-type"),
                  r.headers.get("content-length"))
            r.close()
        except Exception as e:  # noqa: BLE001
            print(u, "erro", repr(e))


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "probe"
    if mode == "probe":
        probe()
