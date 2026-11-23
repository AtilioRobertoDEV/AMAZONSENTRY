"""Radar IA: onde o próximo desmatamento e o próximo garimpo devem aparecer.

Aprende com o próprio histórico do site, célula a célula (0,1 grau, ~11 km):
perda de floresta anual (Hansen), alertas GLAD e garimpo
(Amazon Mining Watch). Para cada ano T, as variáveis usam só o que se sabia até
T-1, e o alvo é o que aconteceu em T. Um gradient boosting por tema
(desmatamento e garimpo) é treinado nos anos passados, validado no último ano
fechado e então aplicado ao ano seguinte.

Saída: data/radar/radar.json
  - grid: células com risco (x, y, risco desmatamento 0-100, risco garimpo 0-100)
  - points: pontos prioritários (as células mais críticas) com os motivos
  - fronts: alertas dos últimos dias classificados pela vizinhança
            (expansão de garimpo, avanço de frente, abertura isolada)
  - model: anos de treino, validação fora do tempo e importância das variáveis

É uma ferramenta de priorização, não uma confirmação em campo.
"""
from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.inspection import permutation_importance
from sklearn.metrics import roc_auc_score

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402

G = 0.1                 # grade do modelo
DEF_MIN_HA = 50         # alvo: >= 50 ha de perda na célula no ano
MIN_MIN_HA = 1          # alvo: qualquer garimpo novo na célula no ano
FRONT_DAYS = 35
FRONT_MIN_HA = 4
N_POINTS = 400
GRID_DEF = 40          # chance mínima (%) para desenhar a célula
GRID_MIN = 15
NMS = 4                 # células (~45 km) entre pontos do mesmo grupo
N_FRONTS = 2500
SEED = 7

DEF = C.DATA_DIR / "deforestation"


# ------------------------------------------------------------------ leitura

def read_cells(path: Path):
    doc = C.read_json(path)
    if not doc:
        return None, None
    return doc, C.rows_from_flat(doc["data"])


def to_grid(rows, cell, shape, tfilter=None):
    """Soma linhas (x, y, t, v) de uma grade `cell` na grade G."""
    out = np.zeros(shape)
    if rows is None or rows.size == 0:
        return out
    if tfilter is not None:
        rows = rows[tfilter(rows[:, 2])]
    f = int(round(G / cell))
    x = rows[:, 0].astype(np.int64) // f
    y = rows[:, 1].astype(np.int64) // f
    ok = (x >= 0) & (y >= 0) & (y < shape[0]) & (x < shape[1])
    np.add.at(out, (y[ok], x[ok]), rows[ok, 3])
    return out


def box(a, r):
    """Soma numa janela (2r+1)^2 — 'o que acontece em volta'."""
    if r <= 0:
        return a.copy()
    p = np.pad(a, r)
    cs = p.cumsum(0).cumsum(1)
    cs = np.pad(cs, ((1, 0), (1, 0)))
    n = 2 * r + 1
    return cs[n:, n:] - cs[:-n, n:] - cs[n:, :-n] + cs[:-n, :-n]


def dist_cells(mask, cap=40):
    """Distância (em células, xadrez) até a célula mais próxima com mask=True."""
    d = np.full(mask.shape, cap, dtype=np.float32)
    cur = mask.copy()
    d[cur] = 0
    for k in range(1, cap):
        nxt = cur.copy()
        nxt[1:] |= cur[:-1]
        nxt[:-1] |= cur[1:]
        nxt[:, 1:] |= nxt[:, :-1].copy()
        nxt[:, :-1] |= nxt[:, 1:].copy()
        new = nxt & ~cur
        if not new.any():
            break
        d[new] = k
        cur = nxt
    return d


class Data:
    def __init__(self):
        self.mask, self.nx, self.ny = C.cell_mask(G)
        sh = self.shape = (self.ny, self.nx)
        man = C.read_json(C.DATA_DIR / "manifest.json", {}) or {}
        dl = man.get("layers", {}).get("deforestation", {})
        self.loss_years = sorted(dl.get("loss_years", []))
        self.last_loss = self.loss_years[-1]
        self.loss = {}
        for y in self.loss_years:
            _, r = read_cells(DEF / "loss" / f"{y}.json")
            self.loss[y] = to_grid(r, 0.05, sh)
        doc, r = read_cells(DEF / "forest.json")
        if doc is None:
            raise SystemExit("falta deforestation/forest.json (rode: deforestation.py loss --force)")
        standing = to_grid(r, doc["cell"], sh)
        # floresta de pé no fim de cada ano = de pé hoje + tudo que foi perdido depois
        self.forest = {}
        acc = standing.copy()
        for y in sorted(self.loss_years, reverse=True):
            self.forest[y] = acc.copy()
            acc += self.loss[y]
        self.forest[self.loss_years[0] - 1] = acc

        self.alerts, self.alert_last_month = {}, {}
        for y in dl.get("alert_years", []):
            d, r = read_cells(DEF / "alerts" / f"{y}.json")
            if d:
                self.alerts[y] = to_grid(r, d["cell"], sh)
                self.alert_last_month[y] = int(r[:, 2].max()) if r.size else 0

        md = C.read_json(C.DATA_DIR / "mining" / "detections.json", {}) or {}
        pts = np.asarray(md.get("data", []), dtype=float).reshape(-1, 5)
        self.mine_pts = pts
        self.mining = {}
        if pts.size:
            yrs = (pts[:, 2] // 10).astype(int)
            x = np.floor((pts[:, 0] / 1000 - C.ORIGIN[0]) / G).astype(int)
            yy = np.floor((pts[:, 1] / 1000 - C.ORIGIN[1]) / G).astype(int)
            ok = (x >= 0) & (yy >= 0) & (x < self.nx) & (yy < self.ny)
            for y in np.unique(yrs):
                g = np.zeros(sh)
                s = ok & (yrs == y)
                np.add.at(g, (yy[s], x[s]), pts[s, 4])
                self.mining[int(y)] = g
        self.mine_years = sorted(self.mining)

        # área da célula (ha), para frações
        lat = C.ORIGIN[1] + (np.arange(self.ny) + 0.5) * G
        self.cell_ha = (np.cos(np.radians(lat)) * (G * 111_320) ** 2 / 10_000)[:, None] * np.ones((1, self.nx))
        self.lon = C.ORIGIN[0] + (np.arange(self.nx) + 0.5) * G
        self.lat = lat

    # perda do ano y; para anos ainda sem Hansen usa os alertas GLAD calibrados
    def loss_of(self, y):
        if y in self.loss:
            return self.loss[y]
        if y in self.alerts:
            return self.alerts[y] * self.glad_to_loss
        return np.zeros(self.shape)

    @property
    def glad_to_loss(self):
        if not hasattr(self, "_g2l"):
            ys = [y for y in self.alerts if y in self.loss]
            a = sum(self.alerts[y].sum() for y in ys)
            l_ = sum(self.loss[y].sum() for y in ys)
            self._g2l = float(l_ / a) if a else 1.0
        return self._g2l

    def forest_end(self, y):
        if y in self.forest:
            return self.forest[y]
        # anos depois do último Hansen: tira a perda estimada
        f = self.forest[self.last_loss].copy()
        for k in range(self.last_loss + 1, y + 1):
            f = np.maximum(f - self.loss_of(k), 0)
        return f

    def mine_cum(self, y):
        g = np.zeros(self.shape)
        for k in self.mine_years:
            if k <= y:
                g += self.mining[k]
        return g

    def mine_new(self, y):
        if y <= self.mine_years[0]:  # 2018 é a linha de base (garimpo que já existia)
            return np.zeros(self.shape)
        return self.mining.get(y, np.zeros(self.shape))


# ------------------------------------------------------------------ variáveis

FEATURES = [
    ("floresta_ha", "floresta de pé na célula"),
    ("floresta_frac", "fração de floresta"),
    ("perda_1", "perda no último ano"),
    ("perda_2_3", "perda 2-3 anos atrás"),
    ("perda_4_10", "perda 4-10 anos atrás"),
    ("perda_1_viz10", "perda no último ano a ~10 km"),
    ("perda_1_viz30", "perda no último ano a ~30 km"),
    ("perda_23_viz30", "perda 2-3 anos atrás a ~30 km"),
    ("aceleracao", "aceleração da perda em volta"),
    ("dist_frente", "distância da frente ativa"),
    ("garimpo_cel", "garimpo na célula"),
    ("garimpo_viz30", "garimpo a ~30 km"),
    ("garimpo_novo_viz30", "garimpo novo a ~30 km"),
    ("dist_garimpo", "distância do garimpo"),
    ("lon", "longitude"),
    ("lat", "latitude"),
]


def features(D: Data, T: int):
    """Variáveis para prever o ano T usando só informação até T-1."""
    l1 = D.loss_of(T - 1)
    l23 = D.loss_of(T - 2) + D.loss_of(T - 3)
    l410 = sum(D.loss_of(k) for k in range(T - 10, T - 3))
    fr = D.forest_end(T - 1)
    v1_10, v1_30 = box(l1, 1), box(l1, 3)
    v23_30 = box(l23, 3)
    acc = np.log1p(v1_30) - np.log1p(v23_30 / 2)
    front = dist_cells(l1 >= 10)
    mc = D.mine_cum(T - 1)
    mn = D.mine_new(T - 1)
    dm = dist_cells(mc > 0)
    lon = np.broadcast_to(D.lon[None, :], D.shape)
    lat = np.broadcast_to(D.lat[:, None], D.shape)
    cols = [
        np.log1p(fr), fr / D.cell_ha,
        np.log1p(l1), np.log1p(l23), np.log1p(l410),
        np.log1p(v1_10), np.log1p(v1_30), np.log1p(v23_30), acc, front,
        np.log1p(mc), np.log1p(box(mc, 3)), np.log1p(box(mn, 3)), dm,
        lon, lat,
    ]
    X = np.stack([c[D.mask] for c in cols], axis=1).astype(np.float32)
    raw = {
        "forest": fr[D.mask], "l1": l1[D.mask], "v1_30": v1_30[D.mask], "v23_30": v23_30[D.mask],
        "front": front[D.mask], 
        "mc30": box(mc, 3)[D.mask], "mn30": box(mn, 3)[D.mask], "dm": dm[D.mask],
    }
    return X, raw


def target_def(D: Data, T: int):
    return (D.loss_of(T)[D.mask] >= DEF_MIN_HA).astype(np.int8)


def target_min(D: Data, T: int):
    return (D.mine_new(T)[D.mask] >= MIN_MIN_HA).astype(np.int8)


def fit(D: Data, years, target, eligible=None):
    Xs, ys = [], []
    for T in years:
        X, raw = features(D, T)
        y = target(D, T)
        keep = raw["forest"] > 50 if eligible is None else eligible(raw)
        Xs.append(X[keep])
        ys.append(y[keep])
    X, y = np.vstack(Xs), np.concatenate(ys)
    m = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.06, max_leaf_nodes=48,
                                       l2_regularization=1.0, random_state=SEED)
    m.fit(X, y)
    return m, X, y


def evaluate(m, D: Data, T, target, amount):
    X, raw = features(D, T)
    keep = raw["forest"] > 50
    y = target(D, T)[keep]
    a = amount(T)[D.mask][keep]
    p = m.predict_proba(X[keep])[:, 1]
    out = {"ano": T, "celulas": int(keep.sum()), "positivas": int(y.sum())}
    if 0 < y.sum() < y.size:
        out["auc"] = round(float(roc_auc_score(y, p)), 3)
        top = p >= np.quantile(p, 0.9)
        out["captura_top10"] = round(float(y[top].sum() / y.sum()), 3)
        # fração da ÁREA perdida (ou de garimpo novo) que caiu nos 10% de maior risco
        out["area_top10"] = round(float(a[top].sum() / max(a.sum(), 1e-9)), 3)
    return out, m, X[keep], y


def importances(m, X, y, n=20000):
    rng = np.random.default_rng(SEED)
    idx = rng.choice(len(y), min(n, len(y)), replace=False)
    r = permutation_importance(m, X[idx], y[idx], n_repeats=3, random_state=SEED, scoring="roc_auc")
    imp = np.clip(r.importances_mean, 0, None)
    tot = imp.sum() or 1
    return {FEATURES[i][0]: round(float(imp[i] / tot), 3) for i in np.argsort(-imp) if imp[i] > 0}


# ------------------------------------------------------------------ motivos

def n_br(v):
    return f"{v:,.0f}".replace(",", ".")


def reasons(kind, raw, i, score_def, score_min):
    r = []
    km = lambda c: int(round(c * 11))  # noqa: E731
    if kind == "garimpo":
        if raw["mc30"][i] > 0 and raw["dm"][i] <= 3:
            r.append("garimpo já mapeado nesta área" if raw["dm"][i] == 0
                     else f"garimpo já mapeado a ~{km(raw['dm'][i])} km")
        if raw["mn30"][i] > 0:
            r.append(f"{n_br(raw['mn30'][i])} ha de garimpo novo a até ~30 km no último ano")
    if raw["l1"][i] >= 5:
        r.append(f"{n_br(raw['l1'][i])} ha de floresta perdidos aqui no último ano")
    elif raw["v1_30"][i] >= 50 and raw["front"][i] <= 3:
        r.append(f"frente de desmatamento a ~{max(km(raw['front'][i]), 1)} km")
    if raw["v23_30"][i] > 0 and raw["v1_30"][i] > 1.5 * raw["v23_30"][i] / 2 and raw["v1_30"][i] > 100:
        r.append("desmatamento em volta acelerando")
    if raw["forest"][i] > 0:
        r.append(f"{n_br(raw['forest'][i])} ha de floresta ainda de pé")
    return r[:4]


# ------------------------------------------------------------------ frentes

def fronts(D: Data, sdef_grid, smin_grid):
    doc, r = read_cells(DEF / "alerts" / "recent.json")
    if doc is None or r.size == 0:
        return [], None
    last = int(doc.get("last_day") or r[:, 2].max())
    r = r[r[:, 2] > last - FRONT_DAYS]
    cell = doc["cell"]
    k = r[:, 0].astype(np.int64) * 100000 + r[:, 1].astype(np.int64)
    u, inv = np.unique(k, return_inverse=True)
    ha = np.bincount(inv, weights=r[:, 3])
    lastd = np.zeros(len(u))
    np.maximum.at(lastd, inv, r[:, 2])
    keep = ha >= FRONT_MIN_HA
    u, ha, lastd = u[keep], ha[keep], lastd[keep]
    cx, cy = u // 100000, u % 100000
    lon = C.ORIGIN[0] + (cx + 0.5) * cell
    lat = C.ORIGIN[1] + (cy + 0.5) * cell

    # garimpo numa grade fina (0,02) dilatada ~4 km
    fine = np.zeros((int(40 / cell), int(45 / cell)), dtype=bool)
    p = D.mine_pts
    if p.size:
        mx = np.floor((p[:, 0] / 1000 - C.ORIGIN[0]) / cell).astype(int)
        my = np.floor((p[:, 1] / 1000 - C.ORIGIN[1]) / cell).astype(int)
        ok = (mx >= 0) & (my >= 0) & (mx < fine.shape[1]) & (my < fine.shape[0])
        fine[my[ok], mx[ok]] = True
    near_mine = box(fine.astype(np.float32), 2) > 0
    iy = np.clip(cy.astype(int), 0, fine.shape[0] - 1)
    ix = np.clip(cx.astype(int), 0, fine.shape[1] - 1)
    is_mine = near_mine[iy, ix]

    # perda nos últimos 3 anos a ~10 km e nos últimos 10 anos a ~30 km
    y0 = D.last_loss
    recent3 = sum(D.loss_of(k) for k in range(y0 - 2, y0 + 1))           # na própria célula (~11 km)
    old10 = box(sum(D.loss_of(k) for k in range(y0 - 9, y0 + 1)), 1)  # em volta (~33 km)
    gx = np.clip(np.floor((lon - C.ORIGIN[0]) / G).astype(int), 0, D.nx - 1)
    gy = np.clip(np.floor((lat - C.ORIGIN[1]) / G).astype(int), 0, D.ny - 1)
    # na grade fina do Hansen (0,05 grau, ~5 km): a abertura caiu onde nada tinha caído?
    fine10 = {}
    for k in range(y0 - 9, y0 + 1):
        _, rr = read_cells(DEF / "loss" / f"{k}.json")
        if rr is None:
            continue
        for x_, y_, _t, v_ in rr:
            fine10[(int(x_), int(y_))] = fine10.get((int(x_), int(y_)), 0) + v_
    fx = np.floor((lon - C.ORIGIN[0]) / 0.05).astype(int)
    fy = np.floor((lat - C.ORIGIN[1]) / 0.05).astype(int)
    fine_loss = np.array([sum(fine10.get((a + i, b + j), 0) for i in (-1, 0, 1) for j in (-1, 0, 1))
                          for a, b in zip(fx, fy)])
    is_front = recent3[gy, gx] >= 50
    isolated = fine_loss < 15   # menos de 15 ha perdidos em 10 anos num raio de ~8 km

    kind = np.where(is_mine, 1, np.where(isolated, 3, np.where(is_front, 2, 4)))
    sd = sdef_grid[gy, gx]
    sm = smin_grid[gy, gx]
    prio = ha * (1 + np.maximum(sd, sm) / 50) * np.where(kind == 1, 2, np.where(kind == 3, 1.6, 1))
    order = np.argsort(-prio)[:N_FRONTS]
    rows = []
    for i in order:
        rows.extend([round(float(lon[i]), 3), round(float(lat[i]), 3), int(kind[i]),
                     round(float(ha[i]), 1), int(lastd[i]), int(sd[i]), int(sm[i])])
    return rows, last


# ------------------------------------------------------------------ principal

def main():
    D = Data()
    y_last = D.last_loss                       # último ano com perda Hansen fechada
    today = dt.date.today()
    alert_year = max(D.alerts) if D.alerts else y_last
    target_year = alert_year + 1 if alert_year > y_last else y_last + 1
    print(f"Hansen até {y_last}; alertas até {alert_year}; previsão para {target_year}; "
          f"GLAD->perda x{D.glad_to_loss:.2f}")

    # ---- desmatamento: treina até y_last-1, valida em y_last, retreina com tudo
    def_years = list(range(max(D.loss_years[0] + 10, 2012), y_last))
    m, _, _ = fit(D, def_years, target_def)
    val_def, _, Xv, yv = evaluate(m, D, y_last, target_def, D.loss_of)
    imp_def = importances(m, Xv, yv)
    print("desmatamento validação", val_def)
    mdef, _, _ = fit(D, def_years + [y_last], target_def)

    # ---- garimpo: alvo = garimpo novo no ano (2019+)
    my = [y for y in D.mine_years if y > D.mine_years[0]]
    full_mine = [y for y in my if y < today.year]
    val_min = imp_min = None
    if len(full_mine) >= 3:
        mm, _, _ = fit(D, full_mine[:-1], target_min)
        val_min, _, Xv, yv = evaluate(mm, D, full_mine[-1], target_min, D.mine_new)
        imp_min = importances(mm, Xv, yv)
        print("garimpo validação", val_min)
    mmin, _, _ = fit(D, full_mine, target_min)

    # ---- previsão
    X, raw = features(D, target_year)
    forest_ok = raw["forest"] > 50
    pdef = mdef.predict_proba(X)[:, 1]
    pmin = mmin.predict_proba(X)[:, 1]
    # nota = chance (%) prevista pelo modelo
    sdef = np.where(forest_ok, np.round(pdef * 100), 0).astype(int)
    smin = np.where(forest_ok, np.round(pmin * 100), 0).astype(int)

    sdef_g = np.zeros(D.shape, dtype=int)
    smin_g = np.zeros(D.shape, dtype=int)
    sdef_g[D.mask] = sdef
    smin_g[D.mask] = smin

    # grade (só o que importa: nota alta em algum tema)
    ys, xs = np.nonzero(D.mask)
    grid = []
    for k in np.nonzero((sdef >= GRID_DEF) | (smin >= GRID_MIN))[0]:
        grid.extend([int(xs[k]), int(ys[k]), int(sdef[k]), int(smin[k])])

    # pontos prioritários: maior probabilidade, sem repetir vizinhos (~45 km)
    cur_alert = D.alerts.get(alert_year, np.zeros(D.shape))[D.mask]
    points = []

    def pick(cands, prob, n, kind_of, novo):
        taken = []
        for k in cands[np.argsort(-prob[cands])]:
            if len(taken) >= n:
                break
            if any(abs(xs[k] - xs[j]) <= NMS and abs(ys[k] - ys[j]) <= NMS for j in taken):
                continue
            taken.append(k)
            kind = kind_of(k)
            pk = pmin[k] if kind == "garimpo" else pdef[k]
            points.append({
                "lon": round(float(D.lon[xs[k]]), 3), "lat": round(float(D.lat[ys[k]]), 3),
                "tema": kind, "nota": int(smin[k] if kind == "garimpo" else sdef[k]), "prob": round(float(pk), 3),
                "risco_desmatamento": int(sdef[k]), "risco_garimpo": int(smin[k]),
                "alertas_ano_ha": round(float(cur_alert[k]), 1),
                "novo": novo,
                "motivos": reasons(kind, raw, k, sdef[k], smin[k]) if not novo else
                           [("ainda sem garimpo mapeado aqui" if kind == "garimpo" else "sem derrubada aqui no último ano")]
                           + reasons(kind, raw, k, sdef[k], smin[k])[:3],
            })

    ok_idx = np.nonzero(forest_ok)[0]
    pick(ok_idx, pmin, N_POINTS // 4, lambda k: "garimpo", False)
    pick(ok_idx, pdef, N_POINTS // 2, lambda k: "desmatamento", False)
    # pontos novos: onde ainda não aconteceu nada, mas o modelo espera que aconteça
    quiet_def = np.nonzero(forest_ok & (raw["l1"] < 5) & (cur_alert < 5) & (raw["forest"] > 500))[0]
    quiet_min = np.nonzero(forest_ok & (raw["dm"] > 0) & (raw["forest"] > 500))[0]
    pick(quiet_min, pmin, N_POINTS // 10, lambda k: "garimpo", True)
    pick(quiet_def, pdef, N_POINTS // 6, lambda k: "desmatamento", True)

    fr, last_day = fronts(D, sdef_g, smin_g)
    doc = {
        "v": 1,
        "updated": C.now_iso(),
        "previsao_ano": target_year,
        "cell": G,
        "origin": list(C.ORIGIN),
        "grid_fields": ["x", "y", "chance_desmatamento_pct", "chance_garimpo_pct"],
        "grid": grid,
        "points": points,
        "fronts_fields": ["lon", "lat", "tipo", "ha", "ultimo_dia", "risco_desmatamento", "risco_garimpo"],
        "fronts_tipos": {"1": "expansão de garimpo", "2": "avanço de frente de desmatamento",
                         "3": "abertura isolada em floresta", "4": "abertura em área já alterada"},
        "fronts": fr,
        "fronts_last_day": last_day,
        "fronts_days": FRONT_DAYS,
        "model": {
            "tipo": "gradient boosting (scikit-learn HistGradientBoostingClassifier)",
            "grade_km": 11,
            "desmatamento": {"alvo": f">= {DEF_MIN_HA} ha de perda de floresta na célula no ano",
                             "anos_treino": def_years + [y_last], "validacao": val_def,
                             "importancia": imp_def},
            "garimpo": {"alvo": "garimpo novo detectado na célula no ano",
                        "anos_treino": full_mine, "validacao": val_min, "importancia": imp_min},
            "glad_para_perda": round(D.glad_to_loss, 3),
            "variaveis": {k: v for k, v in FEATURES},
        },
    }
    C.write_json(C.DATA_DIR / "radar" / "radar.json", doc)
    C.update_manifest("radar", {"updated": doc["updated"], "previsao_ano": target_year})
    print(f"radar: {len(grid)//4} células, {len(points)} pontos, {len(fr)//7} frentes")


if __name__ == "__main__":
    main()
