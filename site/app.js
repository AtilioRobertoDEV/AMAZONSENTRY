/* Amazon Sentry: floresta perdida e garimpo novo no Brasil, com o Radar IA.
 * Sem build: MapLibre GL (vendor/) + JSON gerado pelo pipeline em data/.
 *
 * Gramática visual: terra que muda = quadrado (área); previsão = contorno vazado. As células são reagregadas conforme o zoom para
 * que nenhum quadrado fique menor que alguns pixels.
 */
'use strict';

const DATA = 'data/';
const DAY_MS = 86400000;
const NOW_YEAR = new Date().getUTCFullYear();
const FIRST_YEAR = 1985;
const LAYERS = ['deforestation', 'mining'];   // ordem de desenho
const COLOR = { deforestation: '#f3c34a', mining: '#1fc8b4', clarao: '#fff3df', negro: '#1b140f' };
const INK = { deforestation: '#8a5d00', mining: '#0c6f64' };   // mesmas cores, legíveis no painel
const FRONT_COLORS = { 1: '#1fc8b4', 2: '#f3c34a', 3: '#fff3df', 4: '#b39a6b' };
const EOX_YEARS = { 2016: 's2cloudless_3857', 2018: 's2cloudless-2018_3857', 2019: 's2cloudless-2019_3857',
  2020: 's2cloudless-2020_3857', 2021: 's2cloudless-2021_3857', 2022: 's2cloudless-2022_3857',
  2023: 's2cloudless-2023_3857', 2024: 's2cloudless-2024_3857' };
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const MODES = ['week', 'month', 'year', 'history', 'radar'];
const TL_YEARS = Object.keys(EOX_YEARS).map(Number);

const state = {
  mode: 'week', year: NOW_YEAR, cumulative: false, base: 'sat',
  on: { deforestation: true, mining: true },
  radarOn: { risk_def: true, risk_min: true, fronts: true },
  manifest: {}, stats: {}, radar: null, results: {}, factors: {},
  playing: null, renderSeq: 0, pins: [], estados: null, tl: null,
};

// ------------------------------------------------------------------ utilidades
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const nf = new Intl.NumberFormat('pt-BR');
const fmtInt = (v) => nf.format(Math.round(v));
const dayOf = (y, m = 1, d = 1) => Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
const dateOfDay = (n) => new Date(n * DAY_MS);
const fmtDay = (n) => { const d = dateOfDay(n); return `${d.getUTCDate()} de ${MONTHS[d.getUTCMonth()]}`; };
const fmtIso = (s) => new Date(s).toLocaleString('pt-BR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const haTxt = (v) => (v >= 100 ? `${fmtInt(v)} ha` : `${nf.format(Math.round(v * 10) / 10)} ha`);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const latTxt = (v) => `${nf.format(Math.abs(v).toFixed(1))}° ${v < 0 ? 'S' : 'N'}`;
const lonTxt = (v) => `${nf.format(Math.abs(v).toFixed(1))}° O`;

const cache = new Map();
function getJSON(path) {
  if (!cache.has(path)) {
    cache.set(path, fetch(DATA + path, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null));
  }
  return cache.get(path);
}

// período de uma célula -> início em dias desde 1970
function startOf(unit, t) {
  if (unit === 'day') return t;
  if (unit === 'month') return dayOf(Math.floor(t / 100), t % 100);
  if (unit === 'year') return dayOf(t);
  return t;
}

/** Soma um arquivo "cells" dentro de [a, b) dias. Retorna células na resolução do arquivo. */
function cellsInWindow(doc, a, b) {
  const out = new Map();
  if (!doc || !doc.data) return { cs: 0.1, ox: -75, oy: -35, list: [], total: 0 };
  const d = doc.data;
  let total = 0;
  for (let i = 0; i < d.length; i += 4) {
    const s = startOf(doc.time, d[i + 2]);
    if (s < a || s >= b) continue;
    const k = d[i] * 100000 + d[i + 1];
    const v = d[i + 3];
    total += v;
    const cur = out.get(k);
    if (cur) cur.v += v; else out.set(k, { x: d[i], y: d[i + 1], v });
  }
  return { cs: doc.cell, ox: doc.origin[0], oy: doc.origin[1], list: [...out.values()], total };
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = Float64Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

// menor célula (graus) que ainda ocupa `px` pixels no zoom atual
const pxPerDeg = (z) => (256 * 2 ** z) / 360;
function factorFor(cs, px) {
  return Math.max(1, Math.ceil(px / pxPerDeg(map.getZoom()) / cs));
}

/** Células -> GeoJSON (quadrados ou pontos), reagregadas por `f`. */
function toFeatures(cells, layer, f, shape) {
  const agg = new Map();
  for (const c of cells.list) {
    const x = Math.floor(c.x / f), y = Math.floor(c.y / f);
    const k = x * 100000 + y;
    const cur = agg.get(k);
    if (cur) cur.v += c.v; else agg.set(k, { x, y, v: c.v });
  }
  const vals = [...agg.values()];
  const ref = percentile(vals.map((c) => c.v), 0.97) || 1;
  const cs = cells.cs * f;
  const feats = [];
  for (const c of vals) {
    if (c.v < ref * 0.08) continue;           // ruído visual fora do desenho (mas dentro do total)
    const x0 = cells.ox + c.x * cs, y0 = cells.oy + c.y * cs;
    const props = { layer, v: c.v, w: Math.min(1, c.v / ref), cs };
    const geometry = shape === 'square'
      ? { type: 'Polygon', coordinates: [[[x0, y0], [x0 + cs, y0], [x0 + cs, y0 + cs], [x0, y0 + cs], [x0, y0]]] }
      : { type: 'Point', coordinates: [x0 + cs / 2, y0 + cs / 2] };
    feats.push({ type: 'Feature', geometry, properties: props });
  }
  return feats;
}

// ------------------------------------------------------------------ mapa
const RASTER = (tiles, attribution, maxzoom = 19) => ({ type: 'raster', tiles, tileSize: 256, attribution, maxzoom });
const EMPTY = { type: 'FeatureCollection', features: [] };
const map = new maplibregl.Map({
  container: 'map',
  center: [-56, -10], zoom: 3.7, minZoom: 2.5, maxZoom: 16,
  attributionControl: { compact: true },
  style: {
    version: 8,
    sources: {
      dark: RASTER(['a', 'b', 'c', 'd'].map((s) => `https://${s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png`),
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/">CARTO</a>', 18),
      sat: RASTER(['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        'Imagens © Esri, Maxar, Earthstar Geographics'),
      s2: RASTER([eoxUrl(2024)], 'Sentinel-2 cloudless © <a href="https://s2maps.eu">EOX</a> (dados Copernicus)', 15),
      brasil: { type: 'geojson', data: DATA + 'base/brasil.geojson' },
      fora: { type: 'geojson', data: EMPTY },
      estados: { type: 'geojson', data: DATA + 'base/estados.geojson' },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': COLOR.negro } },
      { id: 'base-dark', type: 'raster', source: 'dark', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.72, 'raster-contrast': 0.1 } },
      { id: 'base-sat', type: 'raster', source: 'sat' },
      { id: 'base-s2', type: 'raster', source: 's2', layout: { visibility: 'none' } },
      { id: 'fora-fill', type: 'fill', source: 'fora', paint: { 'fill-color': COLOR.negro, 'fill-opacity': 0.55 } },
      { id: 'estados-line', type: 'line', source: 'estados', paint: { 'line-color': '#d6be93', 'line-width': 0.6, 'line-opacity': 0.35 } },
      { id: 'brasil-line', type: 'line', source: 'brasil', paint: { 'line-color': '#d6be93', 'line-width': 1.3, 'line-opacity': 0.75 } },
    ],
  },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'top-right');

function eoxUrl(year) {
  return `https://tiles.maps.eox.at/wmts/1.0.0/${EOX_YEARS[year]}/default/g/{z}/{y}/{x}.jpg`;
}

// No satélite, quanto mais perto, mais transparente: dá para ver o chão por baixo.
function fade(expr) {
  if (state.base === 'dark') return expr;
  return ['interpolate', ['linear'], ['zoom'],
    5, expr, 8, ['*', expr, 0.7], 10, ['*', expr, 0.45], 12, ['*', expr, 0.25], 14, ['*', expr, 0.12]];
}
// e o contorno aparece quando o preenchimento some
function outlineOpacity() {
  if (state.base === 'dark') return ['interpolate', ['linear'], ['zoom'], 9, 0, 12, 0.5];
  return ['interpolate', ['linear'], ['zoom'], 7, 0, 10, 0.75, 13, 0.95];
}

function applyPaint() {
  const squareFill = ['+', 0.1, ['*', 0.85, ['get', 'w']]];
  for (const l of ['deforestation', 'mining']) {
    map.setPaintProperty(`lyr-${l}`, 'fill-opacity', fade(squareFill));
    map.setPaintProperty(`lyr-${l}-edge`, 'line-opacity', outlineOpacity());
  }
  map.setPaintProperty('radar-def-fill', 'fill-opacity', fade(['interpolate', ['linear'], ['get', 'score'], 40, 0, 100, 0.22]));
  map.setPaintProperty('radar-min-fill', 'fill-opacity', fade(['interpolate', ['linear'], ['get', 'score'], 15, 0.04, 80, 0.3]));
  map.setPaintProperty('radar-fronts', 'circle-opacity', fade(0.95));
  map.setPaintProperty('fora-fill', 'fill-opacity', state.base === 'dark' ? 0.55 : 0.4);
}

function addDataLayers() {
  for (const l of ['deforestation', 'mining']) {
    map.addSource(`src-${l}`, { type: 'geojson', data: EMPTY });
    map.addLayer({ id: `lyr-${l}`, type: 'fill', source: `src-${l}`,
      paint: { 'fill-color': COLOR[l], 'fill-antialias': false } });
    map.addLayer({ id: `lyr-${l}-edge`, type: 'line', source: `src-${l}`,
      paint: { 'line-color': COLOR[l], 'line-width': 1 } });
  }
  // radar
  map.addSource('src-radar-def', { type: 'geojson', data: EMPTY });
  map.addSource('src-radar-min', { type: 'geojson', data: EMPTY });
  map.addSource('src-radar-fronts', { type: 'geojson', data: EMPTY });
  for (const [k, color, lo, hi] of [['def', COLOR.deforestation, 40, 100], ['min', COLOR.mining, 15, 70]]) {
    map.addLayer({ id: `radar-${k}-fill`, type: 'fill', source: `src-radar-${k}`, paint: { 'fill-color': color } });
    map.addLayer({ id: `radar-${k}`, type: 'line', source: `src-radar-${k}`, paint: {
      'line-color': color,
      'line-width': ['interpolate', ['linear'], ['zoom'], 3, ['interpolate', ['linear'], ['get', 'score'], lo, 0.4, hi, 1.4],
        8, ['interpolate', ['linear'], ['get', 'score'], lo, 1, hi, 3]],
      'line-opacity': ['interpolate', ['linear'], ['get', 'score'], lo, 0.3, hi, 1],
    } });
  }
  map.addLayer({ id: 'radar-fronts', type: 'circle', source: 'src-radar-fronts', paint: {
    'circle-color': ['match', ['get', 'tipo'], 1, FRONT_COLORS[1], 2, FRONT_COLORS[2], 3, FRONT_COLORS[3], FRONT_COLORS[4]],
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, ['case', ['==', ['get', 'tipo'], 4], 1.4, 2.2],
      7, ['case', ['==', ['get', 'tipo'], 4], 2.5, 3.6], 12, 7],
    'circle-stroke-color': COLOR.negro, 'circle-stroke-width': 0.8,
  } });

  for (const id of ['lyr-deforestation', 'lyr-mining', 'radar-def-fill', 'radar-min-fill', 'radar-fronts']) {
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
  }
  map.on('click', onMapClick);
  applyPaint();
}

function onMapClick(e) {
  const ids = state.mode === 'radar'
    ? ['radar-fronts', 'radar-min-fill', 'radar-def-fill']
    : ['lyr-mining', 'lyr-deforestation'];
  const feats = map.queryRenderedFeatures(e.point, { layers: ids.filter((i) => map.getLayer(i)) });
  if (!feats.length) return;
  const f = feats[0], p = f.properties;
  let html = '';
  if (f.layer.id === 'radar-fronts') {
    const tipos = state.radar?.fronts_tipos || {};
    html = `<h3>${esc(cap(tipos[p.tipo] || 'Abertura recente'))}</h3>
      <div class="big">${haTxt(p.ha)}</div>derrubados até ${fmtDay(p.dia)}
      <p class="fine">Chance prevista para a área: ${p.rd}% de desmatamento forte, ${p.rm}% de garimpo novo.</p>`;
  } else if (f.layer.id.startsWith('radar-')) {
    const c = radarCellAt(e.lngLat);
    html = `<h3>Previsão para ${state.radar.previsao_ano}</h3>
      <p>Chance de perder 50 ha ou mais de floresta: <b>${c ? c.rd : 0}%</b><br>Chance de surgir garimpo novo: <b>${c ? c.rm : 0}%</b></p>
      <p class="fine">Quadro de ~11 km.</p>`;
  } else if (p.layer === 'mining') {
    html = `<h3>Garimpo novo</h3><div class="big">${haTxt(p.v)}</div>de área de garimpo detectada`;
  } else {
    html = `<h3>Floresta perdida</h3><div class="big">${haTxt(p.v)}</div>de floresta derrubada nesta área`;
  }
  if (!f.layer.id.startsWith('radar-')) {
    const side = Math.round(p.cs * 111);
    html += `<p class="fine">${esc(state.results[p.layer]?.note || '')}${p.cs ? `. Quadro de ~${side} km.` : ''}</p>`;
  }
  if (p.layer === 'mining' || f.layer.id === 'radar-fronts' || f.layer.id.startsWith('radar-min')) {
    html += `<button class="tl-open" data-lng="${e.lngLat.lng}" data-lat="${e.lngLat.lat}">Ver a evolução por satélite</button>`;
  }
  new maplibregl.Popup({ maxWidth: '260px' }).setLngLat(e.lngLat).setHTML(html).addTo(map);
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ------------------------------------------------------------------ dados por camada e modo
async function deforestationData() {
  const m = state.mode;
  const man = state.manifest.layers?.deforestation || {};
  if (m === 'week' || m === 'month') {
    const doc = await getJSON('deforestation/alerts/recent.json');
    if (!doc || doc.last_day == null) return { total: 0, note: 'sem dados' };
    const days = m === 'month' ? 30 : 7;
    return { cells: cellsInWindow(doc, doc.last_day - days + 1, doc.last_day + 1), days,
      note: `alertas GLAD-L de ${days} dias até ${fmtDay(doc.last_day)}` };
  }
  const y = state.year;
  const lastLoss = Math.max(...(man.loss_years || [0]));
  if (m === 'history' && state.cumulative) {
    const doc = await getJSON('deforestation/loss/summary.json');
    if (!doc) return { total: 0, note: 'sem dados' };
    return { cells: cellsInWindow(doc, dayOf(2001), dayOf(y + 1)), note: `perda somada de 2001 a ${Math.min(y, lastLoss)} (Hansen)` };
  }
  if (m === 'history' && (man.loss_years || []).includes(y)) {
    const doc = await getJSON(`deforestation/loss/${y}.json`);
    return { cells: cellsInWindow(doc, dayOf(y), dayOf(y + 1)), note: 'perda anual de floresta (Hansen/UMD)' };
  }
  if ((man.alert_years || []).includes(y)) {
    const doc = await getJSON(`deforestation/alerts/${y}.json`);
    return { cells: cellsInWindow(doc, dayOf(y), dayOf(y + 1)), note: `alertas GLAD-L${y === NOW_YEAR ? ', ano em curso' : ''}` };
  }
  return { total: 0, note: `sem dados de ${y}; a série começa em 2001` };
}

async function miningData() {
  const doc = await getJSON('mining/detections.json');
  if (!doc || !doc.data?.length) return { total: 0, note: 'sem dados' };
  const d = doc.data;
  const lastP = Math.max(...(doc.periods || [0]));
  let keep, note;
  const m = state.mode;
  if (m === 'week' || m === 'month') {
    keep = (p) => p === lastP;
    note = `detecções mais recentes, ${periodLabel(lastP)}`;
  } else {
    const y = state.year;
    const cum = m === 'history' && state.cumulative;
    keep = cum ? (p) => Math.floor(p / 10) <= y : (p) => Math.floor(p / 10) === y;
    note = y < 2018 ? 'o monitoramento começa em 2018' : cum ? `somado de 2018 a ${y}` : `garimpo que surgiu em ${y}`;
    if (y === 2018 && !cum) note = 'garimpo que já existia em 2018';
  }
  const cs = 0.02, out = new Map();
  let total = 0, count = 0;
  for (let i = 0; i < d.length; i += 5) {
    if (!keep(d[i + 2])) continue;
    const v = d[i + 4];
    total += v; count += 1;
    const x = Math.floor((d[i] / 1000 + 75) / cs), y = Math.floor((d[i + 1] / 1000 + 35) / cs);
    const k = x * 100000 + y;
    const cur = out.get(k);
    if (cur) cur.v += v; else out.set(k, { x, y, v });
  }
  return { cells: { cs, ox: -75, oy: -35, list: [...out.values()], total }, total, count, note, period: lastP };
}

function periodLabel(p) {
  const y = Math.floor(p / 10), q = p % 10;
  return q ? `${q}º trimestre de ${y}` : `${y}`;
}

const LOADERS = { deforestation: deforestationData, mining: miningData };
const SHAPE = { deforestation: 'square', mining: 'square' };
const MIN_PX = { deforestation: 4, mining: 4 };

// ------------------------------------------------------------------ desenho
function drawLayer(l) {
  const r = state.results[l];
  const src = map.getSource(`src-${l}`);
  if (!src) return;
  if (!r || state.mode === 'radar' || !state.on[l]) { src.setData(EMPTY); return; }
  let feats = r.points || [];
  if (r.cells) {
    const f = factorFor(r.cells.cs, MIN_PX[l]);
    state.factors[l] = f;
    feats = toFeatures(r.cells, l, f, SHAPE[l]);
  }
  src.setData({ type: 'FeatureCollection', features: feats });
}

async function render() {
  const seq = ++state.renderSeq;
  $('#loading').hidden = false;
  if (state.mode === 'radar') {
    await renderRadar();
    if (seq !== state.renderSeq) return;
    LAYERS.forEach(drawLayer);
    $('#loading').hidden = true;
    return;
  }
  clearRadar();
  const results = await Promise.all(LAYERS.map((l) => LOADERS[l]()));
  if (seq !== state.renderSeq) return;
  LAYERS.forEach((l, i) => {
    const r = results[i];
    if (r.cells && r.total == null) r.total = r.cells.total;
    state.results[l] = r;
    drawLayer(l);
    const btn = $(`.layer[data-layer="${l}"]`);
    let num;
    if (l === 'mining') num = `${haTxt(r.total || 0).replace(' ha', '')}<small>ha</small>`;
    else num = `${haTxt(r.total || 0).replace(' ha', '')}<small>ha</small>`;
    $('[data-total]', btn).innerHTML = num;
    $('[data-note]', btn).textContent = r.note || '';
  });
  writeLede();
  $('#loading').hidden = true;
  drawCharts();
}

// a frase que abre o painel resume o período em palavras
function writeLede() {
  const r = state.results, m = state.mode;
  const defo = `<b>${haTxt(r.deforestation?.total || 0)}</b> de floresta derrubada`;
  const mine = `<b>${haTxt(r.mining?.total || 0)}</b> de garimpo novo`;
  let s;
  if (m === 'week' || m === 'month') {
    const n = m === 'week' ? 7 : 30;
    s = `Nos últimos ${n} dias de alertas, ${defo}. No trimestre mais recente, ${mine}.`;
  } else if (m === 'year') {
    s = `Em ${NOW_YEAR}, até agora: ${defo} e ${mine}.`;
  } else {
    const y = state.year;
    s = state.cumulative
      ? `De 2001 a ${y}, ${defo}${r.mining?.total ? `; desde 2018, <b>${haTxt(r.mining.total)}</b> de garimpo` : ''}.`
      : `Em ${y}: ${defo}${r.mining?.total ? ` e ${mine}` : ''}.`;
  }
  $('#lede').innerHTML = s;
}

// ------------------------------------------------------------------ radar IA
async function renderRadar() {
  if (!state.radar) state.radar = await getJSON('radar/radar.json');
  const R = state.radar;
  if (!R) {
    $('#lede').textContent = 'O radar ainda não foi gerado. Ele roda junto com a atualização diária de desmatamento.';
    return;
  }
  const cs = R.cell, [ox, oy] = R.origin, g = R.grid;
  const def = [], min = [];
  state.radarCells = new Map();
  for (let i = 0; i < g.length; i += 4) {
    const x = g[i], y = g[i + 1], rd = g[i + 2], rm = g[i + 3];
    state.radarCells.set(x * 100000 + y, { rd, rm });
    const sq = (inset) => {
      const a = ox + x * cs + inset, b = oy + y * cs + inset, s = cs - 2 * inset;
      return { type: 'Polygon', coordinates: [[[a, b], [a + s, b], [a + s, b + s], [a, b + s], [a, b]]] };
    };
    if (rd >= 40) def.push({ type: 'Feature', geometry: sq(0), properties: { score: rd } });
    if (rm >= 15) min.push({ type: 'Feature', geometry: sq(cs * 0.18), properties: { score: rm } });
  }
  const F = R.fronts || [], n = R.fronts_fields?.length || 7, fr = [];
  for (let i = 0; i < F.length; i += n) {
    fr.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [F[i], F[i + 1]] },
      properties: { tipo: F[i + 2], ha: F[i + 3], dia: F[i + 4], rd: F[i + 5], rm: F[i + 6] } });
  }
  map.getSource('src-radar-def').setData({ type: 'FeatureCollection', features: state.radarOn.risk_def ? def : [] });
  map.getSource('src-radar-min').setData({ type: 'FeatureCollection', features: state.radarOn.risk_min ? min : [] });
  map.getSource('src-radar-fronts').setData({ type: 'FeatureCollection', features: state.radarOn.fronts ? fr : [] });

  const md = R.model?.desmatamento || {}, mm = R.model?.garimpo || {};
  const anos = md.anos_treino || [];
  $('#lede').innerHTML = `Onde a floresta deve cair em <b>${R.previsao_ano}</b>, segundo um modelo que aprendeu com
    ${anos.length ? `${anos[0]} a ${anos[anos.length - 1]}` : 'os anos anteriores'} de desmatamento e garimpo.`;
  const v = md.validacao || {};
  $('#radar-intro').innerHTML = v.area_top10 != null
    ? `Testado em ${v.ano} sem ver ${v.ano}: os 10% de áreas que ele marcou como mais arriscadas concentraram
       <b>${Math.round(v.area_top10 * 100)}%</b> da floresta derrubada naquele ano${mm.validacao?.area_top10 != null
        ? ` e <b>${Math.round(mm.validacao.area_top10 * 100)}%</b> do garimpo novo` : ''}.`
    : '';
  const tipos = R.fronts_tipos || {};
  const counts = {};
  for (const f of fr) counts[f.properties.tipo] = (counts[f.properties.tipo] || 0) + 1;
  $('#fronts-name').textContent = `Aberturas dos últimos ${R.fronts_days || 35} dias`;
  $('#fronts-key').innerHTML = Object.entries(tipos).map(([k, t]) =>
    `<li><i style="background:${FRONT_COLORS[k]}"></i>${esc(cap(t))} (${fmtInt(counts[k] || 0)})</li>`).join('');
  drawPriority(R);
  drawMethod(R, md, mm);
}

function radarCellAt(ll) {
  const R = state.radar;
  if (!R) return null;
  const x = Math.floor((ll.lng - R.origin[0]) / R.cell), y = Math.floor((ll.lat - R.origin[1]) / R.cell);
  return state.radarCells?.get(x * 100000 + y) || { rd: 0, rm: 0 };
}

function pickPriority(R) {
  const pts = R.points || [];
  // espalha a lista pelo mapa: nada a menos de ~2 graus de um ponto já escolhido do mesmo grupo
  const by = (t, novo) => {
    const out = [];
    for (const p of pts.filter((q) => q.tema === t && !!q.novo === novo).sort((x, y) => y.prob - x.prob)) {
      if (out.every((q) => Math.abs(q.lon - p.lon) > 2 || Math.abs(q.lat - p.lat) > 2)) out.push(p);
    }
    return out;
  };
  const d = by('desmatamento', false), g = by('garimpo', false);
  const nd = by('desmatamento', true), ng = by('garimpo', true);
  const top = [], novos = [];
  for (let i = 0; i < 5; i++) { if (d[i]) top.push(d[i]); if (g[i]) top.push(g[i]); }
  for (let i = 0; i < 3; i++) { if (ng[i]) novos.push(ng[i]); if (nd[i]) novos.push(nd[i]); }
  return { top, novos };
}

function drawPriority(R) {
  for (const m of state.pins) m.remove();
  state.pins = [];
  const { top, novos } = pickPriority(R);
  const list = [...top.map((p) => ({ ...p, grupo: 'top' })), ...novos.map((p) => ({ ...p, grupo: 'novo' }))];
  const ol = $('#priority');
  ol.innerHTML = '';
  list.forEach((p, i) => {
    if (p.grupo === 'novo' && (i === 0 || list[i - 1].grupo !== 'novo')) {
      const h = document.createElement('li');
      h.className = 'sub';
      h.innerHTML = '<h2 style="margin:16px 0 6px">Pontos novos</h2><p class="fine" style="margin:0 0 8px">Lugares onde ainda não aconteceu nada, mas o padrão em volta diz que deve acontecer.</p>';
      h.style.borderTop = '0';
      ol.appendChild(h);
    }
    const uf = ufOf(p.lon, p.lat);
    const li = document.createElement('li');
    li.innerHTML = `<button data-tema="${p.tema}">
      <span class="score">${p.nota}%<small>de chance</small></span>
      <span class="where">${esc(uf || 'Brasil')}, ${latTxt(p.lat)} ${lonTxt(p.lon)}</span>
      <span class="what">${p.tema === 'garimpo' ? 'Garimpo' : 'Desmatamento'}${p.novo ? '<span class="tag">novo</span>' : ''}</span>
      <span class="why">${esc((p.motivos || []).slice(0, 2).join('; '))}</span></button>`;
    $('button', li).addEventListener('click', () => focusPoint(p, pin));
    ol.appendChild(li);
    // o MapLibre posiciona o marcador por transform: a animação vai num elemento interno
    const el = document.createElement('div');
    el.setAttribute('aria-hidden', 'true');
    const inner = document.createElement('div');
    inner.className = 'pin enter';
    inner.dataset.tema = p.tema;
    inner.style.animationDelay = `${i * 50}ms`;
    inner.textContent = p.nota;
    el.appendChild(inner);
    const pin = new maplibregl.Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(map);
    el.addEventListener('click', (ev) => { ev.stopPropagation(); focusPoint(p, pin); });
    state.pins.push(pin);
  });
}

function focusPoint(p, pin) {
  for (const m of state.pins) m.getElement().firstChild.classList.remove('on');
  pin.getElement().firstChild.classList.add('on');
  map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 9), speed: 1.4,
    padding: window.innerWidth < 760 ? { bottom: 160 } : undefined });
  const html = `<h3>${p.tema === 'garimpo' ? 'Garimpo provável' : 'Desmatamento provável'}${p.novo ? ' (ponto novo)' : ''}</h3>
    <div class="big">${p.nota}% de chance</div>
    <ul>${(p.motivos || []).map((m) => `<li>${esc(m)}</li>`).join('')}</ul>
    <p class="fine">${p.tema === 'garimpo' ? 'Chance de garimpo novo' : 'Chance de perder 50 ha ou mais de floresta'} em ${state.radar.previsao_ano}.
    Desmatamento ${p.risco_desmatamento}%, garimpo ${p.risco_garimpo}%.
    Alertas neste ano: ${haTxt(p.alertas_ano_ha || 0)}. Área de ~11 km.</p>
    <button class="tl-open" data-lng="${p.lon}" data-lat="${p.lat}">Ver a evolução por satélite</button>`;
  new maplibregl.Popup({ maxWidth: '280px', offset: 20 }).setLngLat([p.lon, p.lat]).setHTML(html).addTo(map);
}

function drawMethod(R, md, mm) {
  const vars = R.model?.variaveis || {};
  const imp = Object.entries(md.importancia || {}).slice(0, 5);
  const vd = md.validacao || {}, vm = mm.validacao || {};
  $('#method-body').innerHTML = `
    <p>A cada atualização, um modelo de gradient boosting olha o Brasil em quadros de ~11 km. Para cada ano do passado, ele vê só o que se sabia
    até o ano anterior (perda de floresta em volta, aceleração, distância da frente, garimpo próximo, floresta que ainda resta)
    e aprende o que veio depois. Um modelo para desmatamento, outro para garimpo novo.</p>
    <table>
      ${vd.auc != null ? `<tr><td>Acerto no desmatamento de ${vd.ano} (AUC)</td><td>${nf.format(vd.auc)}</td></tr>` : ''}
      ${vd.area_top10 != null ? `<tr><td>Área derrubada em ${vd.ano} dentro dos 10% mais arriscados</td><td>${Math.round(vd.area_top10 * 100)}%</td></tr>` : ''}
      ${vm.auc != null ? `<tr><td>Acerto no garimpo novo de ${vm.ano} (AUC)</td><td>${nf.format(vm.auc)}</td></tr>` : ''}
      ${vm.area_top10 != null ? `<tr><td>Garimpo novo de ${vm.ano} dentro dos 10% mais arriscados</td><td>${Math.round(vm.area_top10 * 100)}%</td></tr>` : ''}
    </table>
    ${imp.length ? `<p>O que mais pesa: ${imp.map(([k, v]) => `${esc(vars[k] || k)} (${Math.round(v * 100)}%)`).join(', ')}.</p>` : ''}
    <p>Aberturas recentes são alertas GLAD dos últimos dias, classificados pela vizinhança: perto de garimpo mapeado,
    na borda de uma frente ativa ou isoladas no meio da floresta.</p>
    <p>Limites: a perda de floresta do Hansen inclui o corte de plantações de eucalipto e pinus (comum no Sul e Sudeste) e o modelo
    aprende com o passado, então uma frente totalmente nova, sem nada em volta, recebe nota baixa até começar.</p>
    <p>É uma lista de prioridades para olhar a imagem de satélite, não uma prova. Atualizado em ${fmtIso(R.updated)}.</p>`;
}

function clearRadar() {
  for (const m of state.pins) m.remove();
  state.pins = [];
  for (const s of ['src-radar-def', 'src-radar-min', 'src-radar-fronts']) map.getSource(s)?.setData(EMPTY);
}

// estado (UF) de um ponto
function ufOf(lon, lat) {
  const E = state.estados;
  if (!E) return '';
  for (const f of E.features) {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) if (inRing(lon, lat, poly[0])) return f.properties.nome;
  }
  return '';
}
function inRing(x, y, ring) {
  let ins = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}

// ------------------------------------------------------------------ evolução por satélite
// Roda os mosaicos anuais Sentinel-2 (EOX) e por fim a imagem atual (Esri) em volta
// de um ponto, com o garimpo mapeado até cada ano desenhado por cima.
const TL_FRAMES = [...TL_YEARS.map((y) => ({ y, id: `tl-${y}`, url: eoxUrl(y), label: String(y) })),
  { y: NOW_YEAR, id: 'tl-hoje', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', label: 'Hoje' }];
const RADAR_IDS = ['radar-def-fill', 'radar-def', 'radar-min-fill', 'radar-min', 'radar-fronts'];

function detSquare(n, novo) {
  const side = Math.sqrt(Math.max(n.ha, 0.5) * 1e4);
  const dy = side / 111320 / 2, dx = side / (111320 * Math.cos((n.y * Math.PI) / 180)) / 2;
  return { type: 'Feature', properties: { novo },
    geometry: { type: 'Polygon', coordinates: [[[n.x - dx, n.y - dy], [n.x + dx, n.y - dy], [n.x + dx, n.y + dy], [n.x - dx, n.y + dy], [n.x - dx, n.y - dy]]] } };
}

async function openTimelapse(lng, lat) {
  if (state.tl) closeTimelapse();
  stopPlay();
  const doc = await getJSON('mining/detections.json');
  const d = doc?.data || [];
  const near = [];
  for (let i = 0; i < d.length; i += 5) {
    const x = d[i] / 1000, y = d[i + 1] / 1000;
    if (Math.abs(x - lng) < 0.08 && Math.abs(y - lat) < 0.08) near.push({ x, y, yr: Math.floor(d[i + 2] / 10), ha: d[i + 4] });
  }
  state.tl = { lng, lat, near, i: 0, timer: null };
  for (const f of TL_FRAMES) {
    const esri = f.id === 'tl-hoje';
    map.addSource(f.id, RASTER([f.url], esri ? 'Imagens © Esri, Maxar' : 'Sentinel-2 cloudless © EOX (dados Copernicus)', esri ? 19 : 15));
    map.addLayer({ id: f.id, type: 'raster', source: f.id,
      paint: { 'raster-opacity': 0, 'raster-opacity-transition': { duration: 450 }, 'raster-fade-duration': 0 } }, 'fora-fill');
  }
  map.addSource('src-tl', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'tl-mine', type: 'line', source: 'src-tl', paint: {
    'line-color': ['case', ['get', 'novo'], COLOR.clarao, COLOR.mining],
    'line-width': ['case', ['get', 'novo'], 2.4, 1.4], 'line-opacity': 0.9 } });
  for (const l of LAYERS) for (const id of [`lyr-${l}`, `lyr-${l}-edge`]) map.setLayoutProperty(id, 'visibility', 'none');
  for (const id of RADAR_IDS) map.setLayoutProperty(id, 'visibility', 'none');
  for (const m of state.pins) m.getElement().style.display = 'none';
  $$('.maplibregl-popup').forEach((el) => el.remove());
  map.flyTo({ center: [lng, lat], zoom: 13, speed: 1.6 });
  const ticks = $('#tl-ticks');
  ticks.innerHTML = '';
  TL_FRAMES.forEach((f, i) => {
    const b = document.createElement('button');
    b.textContent = f.label;
    b.addEventListener('click', () => { tlPause(); tlShow(i); });
    ticks.appendChild(b);
  });
  $('#tl').hidden = false;
  document.body.classList.add('tl-on');
  tlShow(0);
  tlPlay();
  syncURL();
}

function tlShow(i) {
  const T = state.tl;
  if (!T) return;
  T.i = i;
  const f = TL_FRAMES[i];
  TL_FRAMES.forEach((g, k) => map.setPaintProperty(g.id, 'raster-opacity', k === i ? 1 : 0));
  const isLast = i === TL_FRAMES.length - 1;
  const prevY = i > 0 ? TL_FRAMES[i - 1].y : 0;
  const isNew = (n) => n.yr > prevY && n.yr >= 2019;   // 2018 é a linha de base do mapeamento
  const upto = T.near.filter((n) => n.yr <= f.y);
  map.getSource('src-tl').setData({ type: 'FeatureCollection', features: upto.map((n) => detSquare(n, isNew(n))) });
  $('#tl-year').textContent = f.label;
  const total = upto.reduce((a, n) => a + n.ha, 0);
  const nov = upto.filter(isNew).reduce((a, n) => a + n.ha, 0);
  const when = isLast ? `depois de ${prevY}` : prevY + 1 === f.y ? `em ${f.y}` : `entre ${prevY + 1} e ${f.y}`;
  let note;
  if (f.y < 2018) note = 'O mapeamento de garimpo começa em 2018; aqui é como a área estava antes.';
  else if (!upto.length) note = `Nenhum garimpo mapeado aqui até ${f.y}.`;
  else note = `${haTxt(total)} de garimpo mapeado em volta${nov ? `; ${haTxt(nov)} surgiram ${when}, em branco` : ''}.`;
  $('#tl-note').textContent = `${note} ${isLast ? 'Imagem mais recente disponível (Esri).' : 'Mosaico Sentinel-2 do ano (EOX).'}`;
  $$('#tl-ticks button').forEach((b, k) => b.setAttribute('aria-pressed', String(k === i)));
}

function tlPlay() {
  const T = state.tl;
  if (!T) return;
  clearInterval(T.timer);
  T.timer = setInterval(() => tlShow((T.i + 1) % TL_FRAMES.length), 1700);
  $('#tl-play span').textContent = '❚❚';
  $('#tl-play').setAttribute('aria-label', 'Pausar');
}

function tlPause() {
  const T = state.tl;
  if (!T) return;
  clearInterval(T.timer);
  T.timer = null;
  $('#tl-play span').textContent = '▶';
  $('#tl-play').setAttribute('aria-label', 'Reproduzir');
}

function closeTimelapse() {
  const T = state.tl;
  if (!T) return;
  clearInterval(T.timer);
  for (const f of TL_FRAMES) {
    map.removeLayer(f.id);
    map.removeSource(f.id);
  }
  map.removeLayer('tl-mine');
  map.removeSource('src-tl');
  for (const l of LAYERS) for (const id of [`lyr-${l}`, `lyr-${l}-edge`]) map.setLayoutProperty(id, 'visibility', 'visible');
  for (const id of RADAR_IDS) map.setLayoutProperty(id, 'visibility', 'visible');
  for (const m of state.pins) m.getElement().style.display = '';
  state.tl = null;
  $('#tl').hidden = true;
  document.body.classList.remove('tl-on');
  syncURL();
}

// ------------------------------------------------------------------ séries anuais
function chartSeries() {
  const s = state.stats || {};
  const defo = {};
  for (const [y, v] of Object.entries(s.deforestation?.alertas_glad_ha || {})) defo[y] = { v, alt: true };
  for (const [y, v] of Object.entries(s.deforestation?.perda_hansen_ha || {})) defo[y] = { v };
  const mine = {};
  for (const [y, v] of Object.entries(s.mining?.area_nova_ha || {})) if (+y > 2018) mine[y] = { v };
  return [
    ['deforestation', defo, 'Floresta perdida', (v) => haTxt(v), 'claro: alertas GLAD do ano ainda sem o número anual'],
    ['mining', mine, 'Garimpo novo', (v) => haTxt(v), ''],
  ];
}

function drawCharts() {
  const box = $('#charts');
  const first = 2000;
  const years = [];
  for (let y = first; y <= NOW_YEAR; y++) years.push(y);
  const W = 320, H = 40, bw = W / years.length;
  const sel = state.mode === 'history' || state.mode === 'year' ? state.year : null;
  $('#trend-title').textContent = sel ? `Ano a ano, ${sel} em destaque` : 'Ano a ano';
  box.innerHTML = '';
  const NS = 'http://www.w3.org/2000/svg';
  for (const [l, series, title, f, foot] of chartSeries()) {
    const max = Math.max(1, ...Object.values(series).map((o) => o.v));
    const cur = sel ? series[sel] : null;
    const div = document.createElement('div');
    div.className = 'chart';
    div.innerHTML = `<div class="ttl"><span><b>${title}</b>${foot ? `, ${foot}` : ''}</span><b>${cur ? f(cur.v) : ''}</b></div>`;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `${title} por ano`);
    years.forEach((y, i) => {
      const o = series[y];
      const h = o ? Math.max(1.5, (o.v / max) * (H - 2)) : 1;
      const r = document.createElementNS(NS, 'rect');
      r.setAttribute('x', i * bw + 0.6);
      r.setAttribute('width', Math.max(1, bw - 1.2));
      r.setAttribute('y', H - h);
      r.setAttribute('height', h);
      r.setAttribute('fill', o ? INK[l] : 'rgba(42,30,18,.18)');
      r.setAttribute('opacity', o ? (o.alt ? 0.4 : 0.92) : 1);
      if (y === sel) r.classList.add('sel');
      const t = document.createElementNS(NS, 'title');
      t.textContent = `${y}: ${o ? f(o.v) : 'sem dados'}`;
      r.appendChild(t);
      r.addEventListener('click', () => { setMode('history'); setYear(y); });
      svg.appendChild(r);
    });
    div.appendChild(svg);
    box.appendChild(div);
  }
  const ax = document.createElement('div');
  ax.className = 'axis';
  ax.innerHTML = `<span>${first}</span><span>${NOW_YEAR}</span>`;
  box.appendChild(ax);
}

// ------------------------------------------------------------------ controles
function setMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  document.body.dataset.mode = mode;
  if (mode === 'year') state.year = NOW_YEAR;
  $$('#modes button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  $('#timeline').hidden = mode !== 'history';
  $('#cumulative-opt').hidden = mode !== 'history';
  $('#observed').hidden = mode === 'radar';
  $('#radar').hidden = mode !== 'radar';
  $('#trend').hidden = mode === 'radar';
  if (mode !== 'history') stopPlay();
  syncYearUI();
  updateBase();
  syncURL();
  render();
}

function setYear(y) {
  state.year = y;
  syncYearUI();
  updateBase();
  syncURL();
  render();
}

function syncYearUI() {
  $('#year').value = state.year;
  $('#year-label').textContent = state.year;
}

function syncURL() {
  const q = new URLSearchParams();
  if (state.mode !== 'week') q.set('modo', state.mode);
  if (state.tl) q.set('evolucao', `${state.tl.lng.toFixed(4)},${state.tl.lat.toFixed(4)}`);
  if (state.mode === 'history') q.set('ano', state.year);
  if (state.base !== 'sat') q.set('fundo', state.base);
  const s = q.toString();
  history.replaceState(null, '', s ? `?${s}` : location.pathname);
}

function setBase(b) {
  state.base = b;
  $$('#basemaps button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.base === b)));
  updateBase();
  applyPaint();
  syncURL();
}

function updateBase() {
  const b = state.base;
  let note = '';
  let showS2 = false;
  if (b === 's2') {
    const y = state.mode === 'history' || state.mode === 'year' ? state.year : NOW_YEAR;
    const avail = Object.keys(EOX_YEARS).map(Number).filter((k) => k <= y);
    if (avail.length) {
      const pick = Math.max(...avail);
      map.getSource('s2')?.setTiles([eoxUrl(pick)]);
      note = `Mosaico Sentinel-2 de ${pick}${pick !== y ? `, o mais próximo de ${y}` : ''}.`;
      showS2 = true;
    } else {
      note = `Não há mosaico de imagem para ${y}; mostrando a imagem atual.`;
    }
  } else if (b === 'sat') {
    note = 'Ao aproximar, as camadas ficam transparentes e só o contorno continua, para a imagem aparecer.';
  }
  map.setLayoutProperty('base-dark', 'visibility', b === 'dark' ? 'visible' : 'none');
  map.setLayoutProperty('base-sat', 'visibility', b === 'sat' || (b === 's2' && !showS2) ? 'visible' : 'none');
  map.setLayoutProperty('base-s2', 'visibility', showS2 ? 'visible' : 'none');
  $('#base-note').textContent = note;
}

function firstDataYear() {
  const L = state.manifest.layers || {};
  const ys = [...(L.deforestation?.loss_years || []), ...(L.mining?.years || [])];
  return ys.length ? Math.min(...ys) : 2001;
}

function play() {
  if (state.playing) return stopPlay();
  $('#play span').textContent = '❚❚';
  $('#play').setAttribute('aria-label', 'Pausar');
  let y = state.year >= NOW_YEAR ? firstDataYear() : state.year;
  setYear(y);
  state.playing = setInterval(() => {
    y += 1;
    if (y > NOW_YEAR) return stopPlay();
    setYear(y);
  }, 1500);
}
function stopPlay() {
  clearInterval(state.playing);
  state.playing = null;
  $('#play span').textContent = '▶';
  $('#play').setAttribute('aria-label', 'Reproduzir a série ano a ano');
}

// recorta o mundo menos o Brasil, para escurecer os vizinhos
async function buildOutside() {
  const b = await fetch(DATA + 'base/brasil.geojson').then((r) => r.json()).catch(() => null);
  if (!b) return;
  const geom = b.features ? b.features[0].geometry : b.geometry || b;
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  const holes = polys.map((p) => p[0].slice().reverse());
  map.getSource('fora').setData({ type: 'Feature', properties: {},
    geometry: { type: 'Polygon', coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]], ...holes] } });
}

function bind() {
  $$('#modes button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $$('#basemaps button').forEach((b) => b.addEventListener('click', () => setBase(b.dataset.base)));
  $$('.layer[data-layer]').forEach((btn) => btn.addEventListener('click', () => {
    const l = btn.dataset.layer;
    state.on[l] = !state.on[l];
    btn.setAttribute('aria-pressed', String(state.on[l]));
    drawLayer(l);
  }));
  $$('.layer[data-radar]').forEach((btn) => btn.addEventListener('click', () => {
    const k = btn.dataset.radar;
    state.radarOn[k] = !state.radarOn[k];
    btn.setAttribute('aria-pressed', String(state.radarOn[k]));
    renderRadar();
  }));
  $('#cumulative').addEventListener('change', (e) => { state.cumulative = e.target.checked; render(); });
  const yr = $('#year');
  yr.min = FIRST_YEAR; yr.max = NOW_YEAR;
  yr.addEventListener('input', () => { $('#year-label').textContent = yr.value; });
  yr.addEventListener('change', () => setYear(+yr.value));
  $('#play').addEventListener('click', play);
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.tl-open');
    if (b) openTimelapse(+b.dataset.lng, +b.dataset.lat);
  });
  $('#tl-play').addEventListener('click', () => (state.tl?.timer ? tlPause() : tlPlay()));
  $('#tl-close').addEventListener('click', closeTimelapse);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.tl) closeTimelapse(); });
  $('#sheet-handle').addEventListener('click', () => {
    const closed = $('#rail').classList.toggle('closed');
    $('#sheet-handle').setAttribute('aria-expanded', String(!closed));
  });
  // reagrega as células quando o zoom muda o tamanho mínimo visível
  map.on('zoomend', () => {
    for (const l of LAYERS) {
      const r = state.results[l];
      if (r?.cells && factorFor(r.cells.cs, MIN_PX[l]) !== state.factors[l]) drawLayer(l);
    }
  });
  // parâmetros na URL: ?modo=history&ano=2019&fundo=sat
  const q = new URLSearchParams(location.search);
  if (q.get('ano')) state.year = Math.min(NOW_YEAR, Math.max(FIRST_YEAR, +q.get('ano')));
  const evo = (q.get('evolucao') || '').split(',').map(Number);
  if (evo.length === 2 && evo.every(Number.isFinite)) setTimeout(() => openTimelapse(evo[0], evo[1]), 300);
  const fundo = q.get('fundo');
  if (fundo && ['dark', 'sat', 's2'].includes(fundo)) setBase(fundo);
  const modo = q.get('modo');
  if (modo && MODES.includes(modo) && modo !== 'week') {
    state.mode = '';
    setMode(modo);
    return true;
  }
  return false;
}

async function init() {
  const [manifest, stats, estados] = await Promise.all([getJSON('manifest.json'), getJSON('stats.json'),
    fetch(DATA + 'base/estados.geojson').then((r) => r.json()).catch(() => null)]);
  state.manifest = manifest || {};
  state.stats = stats || {};
  state.estados = estados;
  const L = state.manifest.layers || {};
  $('#updated').textContent = L.deforestation?.alerts_updated
    ? `Alertas de desmatamento atualizados em ${fmtIso(L.deforestation.alerts_updated)}; garimpo em ${L.mining?.updated ? fmtIso(L.mining.updated) : '–'}.`
    : 'Ainda sem dados publicados.';
  addDataLayers();
  updateBase();
  buildOutside();
  if (!bind()) render();
  if (window.innerWidth < 760) {
    $('#rail').classList.add('closed');
    map.fitBounds([[-74, -34], [-34.5, 5.3]], { padding: { top: 20, left: 10, right: 10, bottom: 170 }, duration: 0 });
  }
}

// 'style.load' (e não 'load'): o mapa funciona mesmo se o fundo externo estiver fora do ar
let started = false;
const start = () => { if (!started) { started = true; init(); } };
map.once('style.load', start);
map.once('load', start);
