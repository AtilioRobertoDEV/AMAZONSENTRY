/* Amazon Sentry: floresta perdida e garimpo novo no Brasil, com o Radar IA.
 * Sem build: MapLibre GL (vendor/) + JSON gerado pelo pipeline em data/.
 *
 * Gramática visual: terra que muda = quadrado (área); previsão = contorno vazado; pista de pouso = traço
 * na direção real da pista (cheio se em uso, tracejado se abandonada). As células são reagregadas conforme o
 * zoom para que nenhum quadrado fique menor que alguns pixels.
 */
'use strict';

const DATA = 'data/';
const DAY_MS = 86400000;
const NOW_YEAR = new Date().getUTCFullYear();
const LAYERS = ['deforestation', 'mining'];   // ordem de desenho
const COLOR = { deforestation: '#f3c34a', mining: '#1fc8b4', airstrips: '#ff5fa2', clarao: '#fff3df', negro: '#1b140f',
  aldeia: '#c4a3ff', cidade: '#8cc3ea', anac: '#e9e1d0' };
// tipos de pista: 0 sem registro (suspeita), 1 aldeia, 2 cidade ou vila (as três conferidas no Sentinel-2) e as registradas na ANAC
const AIR_TYPES = [['0', 'Sem registro', 'suspeitas: não achamos registro na ANAC'], ['1', 'Aldeia', 'pista de aldeia ou missão, de uso comunitário'],
  ['2', 'Cidade ou vila', 'pista pública de cidade ou vila que falta na lista da ANAC'], ['reg', 'Registrada na ANAC', 'aeródromo público ou privado cadastrado'],
  ['fora', 'Fora da floresta', 'Cerrado, Pantanal e a transição do Mato Grosso, longe de garimpo e de terra indígena: quase sempre pista de fazenda']];
const INK = { deforestation: '#8a5d00', mining: '#0c6f64', airstrips: '#a3195b' };   // mesmas cores, legíveis no painel
const AIR_STATUS = { 1: 'ativa', 2: 'perdendo uso', 3: 'abandonada', 4: 'reaberta' };
const AIR_KEY = [[1, 'Em uso', 'pista limpa no último ano com imagem boa'], [4, 'Reaberta', 'voltou a ser limpa depois de fechar'],
  [2, 'Perdendo uso', 'o mato está voltando'], [3, 'Abandonada', 'a vegetação tomou a pista']];   // mesmas cores, legíveis no painel
const FRONT_COLORS = { 1: '#1fc8b4', 2: '#f3c34a', 3: '#fff3df', 4: '#b39a6b' };
const EOX_YEARS = { 2016: 's2cloudless_3857', 2018: 's2cloudless-2018_3857', 2019: 's2cloudless-2019_3857',
  2020: 's2cloudless-2020_3857', 2021: 's2cloudless-2021_3857', 2022: 's2cloudless-2022_3857',
  2023: 's2cloudless-2023_3857', 2024: 's2cloudless-2024_3857' };
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const MODES = ['week', 'month', 'year', 'history', 'radar'];
const TL_YEARS = Object.keys(EOX_YEARS).map(Number);

const state = {
  mode: 'week', year: NOW_YEAR, cumulative: false, base: 'sat',
  on: { deforestation: true, mining: true, airstrips: true },
  air: null, airZoom: null, airTypes: new Set(['0']), airHover: null,
  radarOn: { risk_def: true, risk_min: true, fronts: true },
  manifest: {}, stats: {}, radar: null, results: {}, factors: {},
  playing: null, renderSeq: 0, pins: [], estados: null, tl: null,
  imgYear: null, follow: true, badYears: new Map(),
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
      brasil: { type: 'geojson', data: DATA + 'base/brasil.geojson' },
      fora: { type: 'geojson', data: EMPTY },
      estados: { type: 'geojson', data: DATA + 'base/estados.geojson' },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': COLOR.negro } },
      { id: 'base-dark', type: 'raster', source: 'dark', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.72, 'raster-contrast': 0.1 } },
      { id: 'base-sat', type: 'raster', source: 'sat' },
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

  // pistas: um traço por pista, na direção real; abaixo de ~1 km na tela o traço ganha um tamanho mínimo.
  // Com zoom alto o traço afina e fica translúcido, e some sob o mouse, para a imagem da pista aparecer.
  map.addSource('src-air', { type: 'geojson', data: EMPTY, promoteId: 'i' });
  map.addSource('src-air-reg', { type: 'geojson', data: EMPTY, promoteId: 'i' });
  const airW = (pad = 0) => ['interpolate', ['linear'], ['zoom'], 3, 2.2 + pad, 8, 3 + pad, 12, 4 + pad, 14, 2.6 + pad * 0.5, 16, 2 + pad * 0.4];
  const catColor = ['match', ['get', 'cat'], 1, COLOR.aldeia, 2, COLOR.cidade, COLOR.airstrips];
  map.addLayer({ id: 'air-casing', type: 'line', source: 'src-air', filter: ['!=', ['get', 'st'], 3],
    layout: { 'line-cap': 'butt' },
    paint: { 'line-color': COLOR.negro, 'line-opacity': airOpacity(0.55), 'line-width': airW(2) } });
  map.addLayer({ id: 'air-line', type: 'line', source: 'src-air', filter: ['!=', ['get', 'st'], 3],
    layout: { 'line-cap': 'butt' },
    paint: { 'line-color': ['case', ['all', ['==', ['get', 'st'], 4], ['==', ['get', 'cat'], 0]], COLOR.clarao, catColor], 'line-width': airW(),
      'line-opacity': airOpacity(['case', ['==', ['get', 'st'], 2], 0.55, 1]) } });
  map.addLayer({ id: 'air-gone', type: 'line', source: 'src-air', filter: ['==', ['get', 'st'], 3],
    layout: { 'line-cap': 'butt' },
    paint: { 'line-color': catColor, 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 1.6, 12, 2.5, 16, 1.8], 'line-dasharray': [1.2, 1.1], 'line-opacity': airOpacity(0.9) } });
  map.addLayer({ id: 'air-reg-line', type: 'line', source: 'src-air-reg', filter: ['==', ['geometry-type'], 'LineString'],
    paint: { 'line-color': COLOR.anac, 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 1.2, 10, 2, 14, 1.6],
      'line-opacity': airOpacity(0.85) } });
  map.addLayer({ id: 'air-reg-dot', type: 'circle', source: 'src-air-reg', filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 1.6, 10, 3.2], 'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': COLOR.anac, 'circle-stroke-width': 1.3, 'circle-stroke-opacity': airOpacity(0.85) } });
  map.addLayer({ id: 'air-hit', type: 'line', source: 'src-air', paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 16 } });
  map.addLayer({ id: 'air-reg-hit', type: 'line', source: 'src-air-reg', filter: ['==', ['geometry-type'], 'LineString'],
    paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 14 } });
  map.addLayer({ id: 'air-reg-hitdot', type: 'circle', source: 'src-air-reg', filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-color': '#000', 'circle-opacity': 0, 'circle-radius': 8 } });
  for (const [id, src] of [['air-hit', 'src-air'], ['air-reg-hit', 'src-air-reg'], ['air-reg-hitdot', 'src-air-reg']]) {
    map.on('mousemove', id, (e) => airHover(src, e.features[0]?.id));
    map.on('mouseleave', id, () => airHover(null));
  }

  for (const id of ['lyr-deforestation', 'lyr-mining', 'radar-def-fill', 'radar-min-fill', 'radar-fronts', 'air-hit', 'air-reg-hit', 'air-reg-hitdot']) {
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
  }
  map.on('click', onMapClick);
  applyPaint();
}

function onMapClick(e) {
  const ids = state.mode === 'radar'
    ? ['radar-fronts', 'radar-min-fill', 'radar-def-fill']
    : ['air-hit', 'air-reg-hit', 'air-reg-hitdot', 'lyr-mining', 'lyr-deforestation'];
  const feats = map.queryRenderedFeatures(e.point, { layers: ids.filter((i) => map.getLayer(i)) });
  if (!feats.length) {
    // clique num ponto vazio (de perto): coordenadas para copiar ou abrir no Google Maps,
    // por exemplo para apontar uma pista que o mapa ainda não marcou
    if (map.getZoom() >= 10) {
      new maplibregl.Popup({ maxWidth: '260px', className: 'geo-pop' }).setLngLat(e.lngLat)
        .setHTML(`<h3>Ponto no mapa</h3>${geoRow(e.lngLat.lng, e.lngLat.lat)}`).addTo(map);
    }
    return;
  }
  const f = feats[0], p = f.properties;
  if (f.layer.id === 'air-hit') return airPopup(p.i, e.lngLat);
  if (f.layer.id.startsWith('air-reg')) return airRegPopup(p.i, e.lngLat);
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
  const kind = p.layer === 'mining' || f.layer.id.startsWith('radar-min') || (f.layer.id === 'radar-fronts' && p.tipo === 1) ? 'mining' : 'deforestation';
  html += `<button class="tl-open" data-kind="${kind}" data-lng="${e.lngLat.lng}" data-lat="${e.lngLat.lat}">Ver a evolução por satélite</button>`;
  html += geoRow(e.lngLat.lng, e.lngLat.lat);
  new maplibregl.Popup({ maxWidth: '260px' }).setLngLat(e.lngLat).setHTML(html).addTo(map);
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// latitude, longitude do ponto: copiar ou abrir no Google Maps (vista de satélite)
function geoRow(lng, lat) {
  const ll = `${(+lat).toFixed(5)}, ${(+lng).toFixed(5)}`;
  const url = `https://www.google.com/maps/@${(+lat).toFixed(6)},${(+lng).toFixed(6)},1500m/data=!3m1!1e3`;
  return `<div class="geo"><span class="geo-ll">${ll}</span>
    <button type="button" class="geo-copy" data-ll="${ll}">Copiar</button>
    <a class="geo-maps" href="${url}" target="_blank" rel="noopener">Abrir no Google Maps</a></div>`;
}

async function copyLL(b) {
  const ll = b.dataset.ll;
  try {
    await navigator.clipboard.writeText(ll);
  } catch {
    const t = document.createElement('textarea');   // http ou navegador sem clipboard API
    t.value = ll; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove();
  }
  b.textContent = 'Copiado';
  setTimeout(() => { b.textContent = 'Copiar'; }, 1500);
}

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

// ------------------------------------------------------------------ pistas de pouso sem registro
// Cada linha: lon, lat, lon1, lat1, lon2, lat2, comprimento, surgiu depois de, surgiu até, situação,
// último ano visto, fechada desde, km até garimpo, fontes, aberta por ano ("0"-"9" ou "-"), nome.
const A = { LON: 0, LAT: 1, X1: 2, Y1: 3, X2: 4, Y2: 5, LEN: 6, B0: 7, B1: 8, ST: 9, LAST: 10, SHUT: 11, KM: 12, SRC: 13, SER: 14, NAME: 15, CAT: 16, TI: 17, PRIO: 18, P: 19 };
// registradas na ANAC: lon, lat, cabeceiras do OSM (ou null), pública, nome, código, município/UF
const R = { LON: 0, LAT: 1, X1: 2, Y1: 3, X2: 4, Y2: 5, PUB: 6, NAME: 7, CODE: 8, PLACE: 9 };

// opacidade das pistas: mais leve com zoom alto e quase sumida sob o mouse (para ver a imagem embaixo)
function airOpacity(base, dim = 1) {
  const hov = (v) => ['case', ['boolean', ['feature-state', 'hover'], false], 0.08, v];
  const b = typeof base === 'number' ? base * dim : ['*', base, dim];
  return ['interpolate', ['linear'], ['zoom'], 11, hov(b), 14, hov(typeof b === 'number' ? b * 0.5 : ['*', b, 0.5])];
}

function airHover(src, id) {
  const cur = state.airHover;
  if (cur && (cur.src !== src || cur.id !== id)) map.setFeatureState({ source: cur.src, id: cur.id }, { hover: false });
  state.airHover = src != null && id != null ? { src, id } : null;
  if (state.airHover) map.setFeatureState({ source: src, id }, { hover: true });
}

// situação da pista num ano do histórico, pela série de imagens (null = ainda não existia)
function airAt(r, y, first) {
  if (y >= NOW_YEAR && state.mode !== 'history') return r[A.ST];
  const s = r[A.SER];
  let i = Math.min(y - first, s.length - 1);
  if (i < 0) return r[A.B1] != null && r[A.B1] <= y ? 1 : null;
  while (i >= 0 && s[i] === '-') i -= 1;
  if (i < 0) return r[A.B1] != null && r[A.B1] <= y ? 1 : null;
  const v = +s[i];
  if (v >= 5) return [...s.slice(0, i)].some((c, k) => c !== '-' && +c < 3 && [...s.slice(0, k)].some((d) => d !== '-' && +d >= 5)) ? 4 : 1;
  const wasOpen = [...s.slice(0, i)].some((c) => c !== '-' && +c >= 5);
  if (v >= 3) return wasOpen ? 2 : (r[A.B1] != null && r[A.B1] <= y ? 2 : null);
  return wasOpen ? 3 : null;
}

async function airData() {
  const doc = await getJSON('airstrips/airstrips.json');
  if (!doc?.data?.length) return { total: 0, list: [], note: 'ainda conferindo as imagens' };
  state.air = doc;
  const first = doc.first_year || 2017;
  const y = state.mode === 'history' ? state.year : NOW_YEAR;
  const list = [];
  const by = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const types = state.airTypes, cats = { 0: 0, 1: 0, 2: 0 };
  let used0 = 0, fora = 0;
  // prioridade: 1 perto de garimpo ou em terra indígena, 2 floresta amazônica, 3 fora da floresta (fazendas)
  const far = (r) => r[A.PRIO] === 3 && !types.has('fora');
  doc.data.forEach((r, i) => {
    const st = state.mode === 'history' ? airAt(r, y, first) : r[A.ST];
    if (!st) return;
    const cat = r[A.CAT] || 0;
    if (r[A.PRIO] === 3 && types.has(String(cat))) fora += 1;
    if (far(r)) return;
    cats[cat] += 1;
    if (cat === 0 && (st === 1 || st === 4)) used0 += 1;
    if (!types.has(String(cat))) return;
    list.push({ i, st, cat, prio: r[A.PRIO] || 2 });
    by[st] += 1;
  });
  list.sort((a, b) => b.prio - a.prio);   // as de garimpo e terra indígena por cima
  const total = cats[0];
  const reg = state.mode === 'history' || !types.has('reg') ? [] : (doc.reg || []);
  const born = state.mode === 'history' ? doc.data.filter((r) => r[A.B1] === y && !r[A.CAT] && !far(r)).length : 0;
  const note = state.mode === 'history'
    ? (y < first ? `antes de ${first}, só as datadas pela perda de floresta` : `situação em ${y}${born ? `; ${born} surgiram até ${y}` : ''}`)
    : `${used0} em uso no último ano com imagem boa`;
  return { total, list, by, note, cats, reg, used0, fora, regTotal: (doc.reg || []).length };
}

function airFeatures(r) {
  const z = map.getZoom();
  const minHalf = 7 / pxPerDeg(z);          // traço de pelo menos ~14 px
  const D = state.air.data;
  const feats = [];
  for (const { i, st } of r.list) {
    const d = D[i];
    const k = Math.cos((d[A.LAT] * Math.PI) / 180);
    let dx = (d[A.X2] - d[A.X1]) * k, dy = d[A.Y2] - d[A.Y1];
    const half = Math.hypot(dx, dy) / 2 || 1e-6;
    const h = Math.max(half, minHalf);
    dx = (dx / (2 * half)) * h; dy = (dy / (2 * half)) * h;   // meio traço
    feats.push({ type: 'Feature', properties: { i, st, cat: d[A.CAT] || 0 },
      geometry: { type: 'LineString', coordinates: [[d[A.LON] - dx / k, d[A.LAT] - dy], [d[A.LON] + dx / k, d[A.LAT] + dy]] } });
  }
  return feats;
}

function drawAir() {
  const src = map.getSource('src-air');
  if (!src) return;
  const r = state.results.airstrips;
  const reg = map.getSource('src-air-reg');
  if (!r || state.mode === 'radar' || !state.on.airstrips) { src.setData(EMPTY); reg.setData(EMPTY); return; }
  state.airZoom = Math.round(map.getZoom() * 2) / 2;
  src.setData({ type: 'FeatureCollection', features: r.list.length ? airFeatures(r) : [] });
  reg.setData({ type: 'FeatureCollection', features: r.reg.map((d, i) => ({ type: 'Feature', properties: { i },
    geometry: d[R.X1] != null ? { type: 'LineString', coordinates: [[d[R.X1], d[R.Y1]], [d[R.X2], d[R.Y2]]] }
      : { type: 'Point', coordinates: [d[R.LON], d[R.LAT]] } })) });
}

function drawAirKey() {
  const r = state.results.airstrips, ul = $('#air-key'), box = $('#air-types');
  ul.hidden = box.hidden = !state.on.airstrips || !r?.by;
  if (ul.hidden) return;
  ul.innerHTML = AIR_KEY.map(([st, name, why]) => `<li data-st="${st}" title="${esc(why)}"><i aria-hidden="true"></i>${name}<b>${fmtInt(r.by[st] || 0)}</b></li>`).join('');
  const hist = state.mode === 'history';
  box.innerHTML = AIR_TYPES.map(([k, name, why]) => {
    const n = k === 'reg' ? r.regTotal : k === 'fora' ? r.fora : r.cats[k];
    const off = k === 'reg' && hist;
    return `<button type="button" data-type="${k}" aria-pressed="${state.airTypes.has(k) && !off}" title="${esc(off ? 'sem data: só aparece fora do histórico' : why)}"${off ? ' disabled' : ''}>
      <i aria-hidden="true"></i>${name}<b>${fmtInt(n || 0)}</b></button>`;
  }).join('');
}

function showAir(air) {
  state.results.airstrips = air;
  drawAir();
  drawAirKey();
  const ab = $('.layer[data-layer="airstrips"]');
  $('[data-total]', ab).innerHTML = air.total ? `${fmtInt(air.total)}<small>pistas</small>` : '–';
  $('[data-note]', ab).textContent = air.note || '';
}

function toggleAirType(k) {
  if (state.airTypes.has(k)) state.airTypes.delete(k); else state.airTypes.add(k);
  airData().then((air) => { showAir(air); writeLede(); syncURL(); });
}

// barra de anos do popup: quanto da pista estava limpa em cada ano; risco = imagem ruim, ano ignorado
function airYears(r, first) {
  const s = r[A.SER];
  return `<div class="air-years" role="img" aria-label="Quanto da pista estava limpa em cada ano">${[...s].map((c, k) => {
    const y = first + k;
    if (c === '-') return `<span class="bad" title="${y}: imagem ruim, ano ignorado"><i></i><em>${String(y).slice(2)}</em></span>`;
    return `<span title="${y}: ${+c * 10}% da pista limpa"><i style="--o:${(+c / 9).toFixed(2)}"></i><em>${String(y).slice(2)}</em></span>`;
  }).join('')}</div>`;
}

const SRC_NAMES = [[1, 'OpenStreetMap'], [2, 'OurAirports'], [4, 'MapBiomas'], [8, 'detector do site'], [16, 'apontada por quem usa o site']];

function airPopup(i, ll) {
  const doc = state.air, r = doc.data[i], first = doc.first_year || 2017;
  const st = r[A.ST];
  const b0 = r[A.B0], b1 = r[A.B1];
  let born;
  if (b1 == null) born = 'Data de abertura incerta.';
  else if (b1 <= 2000) born = 'Já estava aberta em 2000.';
  else if (b0 === b1) born = `Aberta por volta de <b>${b1}</b> (perda de floresta no eixo).`;
  else if (b0 == null) born = `Já aberta na primeira imagem boa, de <b>${b1}</b>.`;
  else {
    const gap = [];
    for (let y = b0 + 1; y < b1; y++) gap.push(y);
    born = `Surgiu entre <b>${b0}</b> e <b>${b1}</b>${gap.length ? ` (${gap.join(', ')} sem imagem boa)` : ''}.`;
  }
  const now = { 1: `Em uso em ${r[A.LAST]}: pista limpa.`, 4: `Reaberta: limpa de novo em ${r[A.LAST]}.`,
    2: `Perdendo uso em ${r[A.LAST]}: o mato está voltando.`,
    3: `Abandonada${r[A.SHUT] ? ` desde ${r[A.SHUT]}` : ''}: a vegetação tomou a pista.` }[st];
  const head = Math.round(((Math.atan2((r[A.X2] - r[A.X1]) * Math.cos((r[A.LAT] * Math.PI) / 180), r[A.Y2] - r[A.Y1]) * 180) / Math.PI + 360) % 180);
  const srcs = SRC_NAMES.filter(([b]) => r[A.SRC] & b).map(([, n]) => n).join(', ');
  const km = r[A.KM];
  const cat = r[A.CAT] || 0, ti = r[A.TI];
  const kind = ['Não achamos registro desta pista (suspeita), o que não prova que seja ilegal.',
    'Pista de aldeia ou missão, de uso comunitário. Não está na lista da ANAC.',
    'Pista pública de cidade ou vila. Não está na lista da ANAC.'][cat];
  const html = `<h3>${r[A.NAME] ? esc(r[A.NAME]) : ['Pista sem registro', 'Pista de aldeia', 'Pista de cidade ou vila'][cat]}</h3>
    <div class="big">${fmtInt(r[A.LEN])} m</div>de pista, rumo ${String(head).padStart(3, '0')}°
    <p class="air-now" data-st="${st}">${now}</p>
    <p>${born}</p>
    ${airYears(r, first)}
    ${ti ? `<p>Dentro da Terra Indígena <b>${esc(ti)}</b>.</p>` : ''}
    ${km != null ? `<p>${km < 1 ? 'Colada a um garimpo' : `Garimpo mais perto a ${nf.format(km)} km`}.</p>` : ''}
    ${r[A.PRIO] === 3 ? '<p>Fora da floresta amazônica e longe de garimpo: muitas pistas assim servem a fazendas.</p>' : ''}
    <p class="fine">${kind} Fonte da indicação: ${esc(srcs)}. Medida no Sentinel-2${r[A.P] != null ? `; nosso modelo dá ${Math.round(r[A.P] * 100)}% de chance de ser pista e não estrada ou rio` : ''}.</p>
    <button class="tl-open" data-kind="airstrip" data-lng="${r[A.LON]}" data-lat="${r[A.LAT]}">Ver a evolução por satélite</button>
    ${geoRow(r[A.LON], r[A.LAT])}`;
  new maplibregl.Popup({ maxWidth: '280px' }).setLngLat(ll).setHTML(html).addTo(map);
}

// opacidade normal (dim = 1) ou apagada durante a evolução por satélite
function airDim(dim) {
  map.setPaintProperty('air-casing', 'line-opacity', airOpacity(0.55, dim));
  map.setPaintProperty('air-line', 'line-opacity', airOpacity(['case', ['==', ['get', 'st'], 2], 0.55, 1], dim));
  map.setPaintProperty('air-gone', 'line-opacity', airOpacity(0.9, dim));
  map.setPaintProperty('air-reg-line', 'line-opacity', airOpacity(0.85, dim));
  map.setPaintProperty('air-reg-dot', 'circle-stroke-opacity', airOpacity(0.85, dim));
}

function airRegPopup(i, ll) {
  const r = state.results.airstrips.reg[i];
  if (!r) return;
  const html = `<h3>${esc(r[R.NAME] || 'Aeródromo registrado')}</h3>
    <div class="big">${esc(r[R.CODE] || '')}</div>${esc(r[R.PLACE] || '')}
    <p class="air-reg">Registrada na ANAC como aeródromo ${r[R.PUB] ? 'público' : 'privado'}.</p>
    <p class="fine">${r[R.X1] != null ? 'Traçado da pista: OpenStreetMap.' : 'Sem traçado da pista: só a posição do cadastro.'} Cadastro de aeródromos da ANAC, guardado no site.</p>
    <button class="tl-open" data-kind="airstrip" data-lng="${r[R.LON]}" data-lat="${r[R.LAT]}">Ver a evolução por satélite</button>
    ${geoRow(r[R.LON], r[R.LAT])}`;
  new maplibregl.Popup({ maxWidth: '280px' }).setLngLat(ll).setHTML(html).addTo(map);
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
    drawAir();
    $('#loading').hidden = true;
    return;
  }
  clearRadar();
  const [results, air] = await Promise.all([Promise.all(LAYERS.map((l) => LOADERS[l]())), airData()]);
  if (seq !== state.renderSeq) return;
  showAir(air);
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
  const r = state.results, m = state.mode, on = state.on;
  const defo = `<b>${haTxt(r.deforestation?.total || 0)}</b> de floresta derrubada`;
  const mine = `<b>${haTxt(r.mining?.total || 0)}</b> de garimpo novo`;
  const both = on.deforestation && on.mining;
  let s;
  if (m === 'week' || m === 'month') {
    const n = m === 'week' ? 7 : 30;
    const a = `Nos últimos ${n} dias de alertas, ${defo}.`, b = `No trimestre mais recente, ${mine}.`;
    s = both ? `${a} ${b}` : on.mining ? b : a;
  } else if (m === 'year') {
    s = both ? `Em ${NOW_YEAR}, até agora: ${defo} e ${mine}.` : `Em ${NOW_YEAR}, até agora: ${on.mining ? mine : defo}.`;
  } else {
    const y = state.year;
    const mineCum = `<b>${haTxt(r.mining?.total || 0)}</b> de garimpo`;
    if (state.cumulative) {
      const a = `De 2001 a ${y}, ${defo}`, b = `desde 2018, ${mineCum}`;
      s = both ? `${a}${r.mining?.total ? `; ${b}` : ''}.` : on.mining ? `De 2018 a ${y}, ${mineCum}.` : `${a}.`;
    } else {
      s = both ? `Em ${y}: ${defo}${r.mining?.total ? ` e ${mine}` : ''}.` : `Em ${y}: ${on.mining ? mine : defo}.`;
    }
  }
  const air = r.airstrips;
  if (on.airstrips && air?.total) {
    const used = air.used0 ?? ((air.by[1] || 0) + (air.by[4] || 0));
    const a = m === 'history'
      ? `<b>${fmtInt(air.total)}</b> pistas de pouso sem registro já abertas em ${state.year}, <b>${fmtInt(used)}</b> em uso.`
      : `<b>${fmtInt(air.total)}</b> pistas de pouso sem registro na Amazônia, <b>${fmtInt(used)}</b> em uso.`;
    s = on.deforestation || on.mining ? `${s} ${a}` : a;
  } else if (!on.deforestation && !on.mining) s = '';
  if (!on.deforestation && !on.mining && !on.airstrips) s = 'Nenhuma camada ligada. Escolha abaixo o que mostrar.';
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
    <button class="tl-open" data-kind="${p.tema === 'garimpo' ? 'mining' : 'deforestation'}" data-lng="${p.lon}" data-lat="${p.lat}">Ver a evolução por satélite</button>
    ${geoRow(p.lon, p.lat)}`;
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

// ------------------------------------------------------------------ imagem ruim? pula o ano
// O mosaico "sem nuvens" ainda tem nuvem, faixa sem dado ou borrão em alguns lugares.
// Baixa os 4 tiles (zoom 12, ~20 km) em volta do ponto e mede a imagem: muito branco
// sem cor = nuvem; muito preto = sem dado; quase sem variação = borrão/névoa.
const QUALITY = new Map();

function tileFrac(lng, lat, z) {
  const n = 2 ** z, r = (lat * Math.PI) / 180;
  return [((lng + 180) / 360) * n, ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n];
}

async function tileStats(url) {
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(res.status);
  const bmp = await createImageBitmap(await res.blob());
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0, 64, 64);
  return g.getImageData(0, 0, 64, 64).data;
}

function imageQuality(year, lng, lat) {
  const z = 12;
  const [fx, fy] = tileFrac(lng, lat, z);
  const x0 = Math.floor(fx - 0.5), y0 = Math.floor(fy - 0.5);
  const key = `${year}/${x0}/${y0}`;
  if (!QUALITY.has(key)) {
    const base = `https://tiles.maps.eox.at/wmts/1.0.0/${EOX_YEARS[year]}/default/g/${z}`;
    const urls = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([dx, dy]) => `${base}/${y0 + dy}/${x0 + dx}.jpg`);
    QUALITY.set(key, Promise.all(urls.map(tileStats)).then((tiles) => {
      let n = 0, cloud = 0, empty = 0, s = 0, s2 = 0;
      for (const d of tiles) {
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], gg = d[i + 1], b = d[i + 2];
          const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), lum = 0.3 * r + 0.59 * gg + 0.11 * b;
          n += 1; s += lum; s2 += lum * lum;
          if (mn > 175 && mx - mn < 40) cloud += 1;
          if (mx < 8) empty += 1;
        }
      }
      const mean = s / n, sd = Math.sqrt(Math.max(0, s2 / n - mean * mean));
      const q = { cloud: cloud / n, empty: empty / n, mean, sd };
      q.bad = q.cloud > 0.3 || q.empty > 0.2 || sd < 4 || (mean > 165 && sd < 22);
      q.why = q.empty > 0.2 ? 'falha na imagem' : q.cloud > 0.3 || mean > 165 ? 'nuvem' : 'imagem borrada';
      return q;
    }).catch(() => ({ bad: false })));   // se não der para conferir, mantém o ano
  }
  return QUALITY.get(key);
}

// anos ruins num ponto (o mosaico de "Hoje" é da Esri e fica sempre)
async function badYearsAt(lng, lat) {
  const qs = await Promise.all(TL_YEARS.map((y) => imageQuality(y, lng, lat)));
  const out = new Map();
  TL_YEARS.forEach((y, i) => { if (qs[i].bad) out.set(y, qs[i].why); });
  return out;
}

// no mapa: com zoom de perto, confere o centro e tira os anos ruins do seletor
let qualityTimer = null;
function checkCenterQuality() {
  clearTimeout(qualityTimer);
  qualityTimer = setTimeout(async () => {
    if (map.getZoom() < 9) {
      if (state.badYears.size) { state.badYears = new Map(); updateBase(); }
      return;
    }
    const c = map.getCenter();
    const bad = await badYearsAt(c.lng, c.lat);
    const same = bad.size === state.badYears.size && [...bad.keys()].every((k) => state.badYears.has(k));
    if (same) return;
    state.badYears = bad;
    updateBase();
  }, 500);
}

// ------------------------------------------------------------------ evolução por satélite
// Roda os mosaicos anuais Sentinel-2 (EOX) e por fim a imagem atual (Esri) em volta
// de um ponto. Por cima, o que foi mapeado em cada intervalo: garimpo (quadrados) e
// floresta derrubada (quadros de ~5 km da perda anual Hansen), conforme o que está ligado.
const TL_FRAMES = [...TL_YEARS.map((y) => ({ y, id: `tl-${y}`, url: eoxUrl(y), label: String(y) })),
  { y: NOW_YEAR, id: 'tl-hoje', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', label: 'Hoje' }];
const RADAR_IDS = ['radar-def-fill', 'radar-def', 'radar-min-fill', 'radar-min', 'radar-fronts'];
const TL_LAYERS = ['tl-def-fill', 'tl-def', 'tl-mine'];

function detSquare(n, novo) {
  const side = Math.sqrt(Math.max(n.ha, 0.5) * 1e4);
  const dy = side / 111320 / 2, dx = side / (111320 * Math.cos((n.y * Math.PI) / 180)) / 2;
  return { type: 'Feature', properties: { novo },
    geometry: { type: 'Polygon', coordinates: [[[n.x - dx, n.y - dy], [n.x + dx, n.y - dy], [n.x + dx, n.y + dy], [n.x - dx, n.y + dy], [n.x - dx, n.y - dy]]] } };
}

// janela de anos que cada quadro representa: do quadro anterior (exclusive) até ele
function tlWindow(i) {
  const bad = state.tl?.bad || new Map();
  const f = TL_FRAMES[i];
  let k = i - 1;
  while (k >= 0 && bad.has(TL_FRAMES[k].y)) k -= 1;
  return [k < 0 ? f.y : TL_FRAMES[k].y + 1, f.y];
}
function tlNext(i) {
  const bad = state.tl?.bad || new Map();
  for (let s = 1; s <= TL_FRAMES.length; s++) {
    const j = (i + s) % TL_FRAMES.length;
    if (!bad.has(TL_FRAMES[j].y) || TL_FRAMES[j].id === 'tl-hoje') return j;
  }
  return TL_FRAMES.length - 1;
}
const spanTxt = (a, b) => (a >= b ? `em ${b}` : `entre ${a} e ${b}`);

// perda Hansen de um ano, só nos quadros perto do ponto
async function tlLoss(T, y) {
  if (!T.loss.has(y)) {
    T.loss.set(y, getJSON(`deforestation/loss/${y}.json`).then((doc) => {
      const out = new Map();
      if (!doc?.data) return out;
      const cs = doc.cell, [ox, oy] = doc.origin, d = doc.data;
      const cx = Math.floor((T.lng - ox) / cs), cy = Math.floor((T.lat - oy) / cs);
      for (let k = 0; k < d.length; k += 4) {
        if (Math.abs(d[k] - cx) > 3 || Math.abs(d[k + 1] - cy) > 3) continue;
        const key = `${d[k]},${d[k + 1]}`;
        out.set(key, (out.get(key) || 0) + d[k + 3]);
      }
      out.cs = cs; out.ox = ox; out.oy = oy;
      return out;
    }));
  }
  return T.loss.get(y);
}

async function tlDefSum(T, a, b) {
  const years = (state.manifest.layers?.deforestation?.loss_years || []).filter((y) => y >= a && y <= b);
  const maps = await Promise.all(years.map((y) => tlLoss(T, y)));
  const sum = new Map();
  let geo = null;
  for (const m of maps) {
    if (m.cs) geo = m;
    for (const [k, v] of m) sum.set(k, (sum.get(k) || 0) + v);
  }
  return { sum, geo, years };
}

async function openTimelapse(lng, lat, kind) {
  if (state.tl) closeTimelapse();
  stopPlay();
  const doc = await getJSON('mining/detections.json');
  const d = doc?.data || [];
  const near = [];
  for (let i = 0; i < d.length; i += 5) {
    const x = d[i] / 1000, y = d[i + 1] / 1000;
    if (Math.abs(x - lng) < 0.16 && Math.abs(y - lat) < 0.16) near.push({ x, y, yr: Math.floor(d[i + 2] / 10), ha: d[i + 4] });
  }
  // pista: a mais perto do ponto, para contar no rodapé quanto dela estava limpa em cada ano
  let air = null;
  if (kind === 'airstrip' && state.air) {
    let best = 0.02;
    state.air.data.forEach((r) => { const d = Math.hypot(r[A.LON] - lng, r[A.LAT] - lat); if (d < best) { best = d; air = r; } });
  }
  state.tl = { lng, lat, near, air, i: 0, timer: null, loss: new Map(), seq: 0, bad: new Map() };
  for (const f of TL_FRAMES) {
    const esri = f.id === 'tl-hoje';
    map.addSource(f.id, RASTER([f.url], esri ? 'Imagens © Esri, Maxar' : 'Sentinel-2 cloudless © EOX (dados Copernicus)', esri ? 19 : 15));
    map.addLayer({ id: f.id, type: 'raster', source: f.id,
      paint: { 'raster-opacity': 0, 'raster-opacity-transition': { duration: 450 }, 'raster-fade-duration': 0 } }, 'fora-fill');
  }
  map.addSource('src-tl', { type: 'geojson', data: EMPTY });
  map.addSource('src-tl-def', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'tl-def-fill', type: 'fill', source: 'src-tl-def', filter: ['get', 'novo'], paint: {
    'fill-color': COLOR.deforestation,
    'fill-opacity': ['interpolate', ['linear'], ['get', 'ha'], 0, 0.03, 50, 0.1, 300, 0.2, 1500, 0.32] } });
  map.addLayer({ id: 'tl-def', type: 'line', source: 'src-tl-def', filter: ['get', 'novo'], paint: {
    'line-color': COLOR.deforestation, 'line-width': 1,
    'line-opacity': ['interpolate', ['linear'], ['get', 'ha'], 0, 0.15, 300, 0.55] } });
  map.addLayer({ id: 'tl-mine', type: 'line', source: 'src-tl', paint: {
    'line-color': ['case', ['get', 'novo'], COLOR.clarao, COLOR.mining],
    'line-width': ['case', ['get', 'novo'], 2.4, 1.4], 'line-opacity': 0.9 } });
  for (const l of LAYERS) for (const id of [`lyr-${l}`, `lyr-${l}-edge`]) map.setLayoutProperty(id, 'visibility', 'none');
  for (const id of RADAR_IDS) map.setLayoutProperty(id, 'visibility', 'none');
  for (const m of state.pins) m.getElement().style.display = 'none';
  $$('.maplibregl-popup').forEach((el) => el.remove());
  const zoom = kind === 'airstrip' ? 14 : state.on.deforestation ? (kind === 'mining' ? 12 : 11.3) : 13;
  airDim(0.35);
  map.flyTo({ center: [lng, lat], zoom, speed: 1.6 });
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
  updateBase();
  // já começa a baixar a perda de todos os anos, para o play não travar
  if (state.on.deforestation) for (const y of state.manifest.layers?.deforestation?.loss_years || []) if (y >= TL_FRAMES[0].y) tlLoss(state.tl, y);
  const T = state.tl;
  badYearsAt(lng, lat).then((bad) => {
    if (state.tl !== T || !bad.size) return;
    T.bad = bad;
    $$('#tl-ticks button').forEach((btn, k) => { btn.hidden = bad.has(TL_FRAMES[k].y) && TL_FRAMES[k].id !== 'tl-hoje'; });
    tlShow(bad.has(TL_FRAMES[T.i].y) ? tlNext(T.i) : T.i);
  });
  tlShow(0);
  tlPlay();
  syncURL();
}

async function tlShow(i) {
  const T = state.tl;
  if (!T) return;
  T.i = i;
  const seq = ++T.seq;
  const f = TL_FRAMES[i];
  const isLast = i === TL_FRAMES.length - 1;
  const [a, b] = tlWindow(i);
  TL_FRAMES.forEach((g, k) => map.setPaintProperty(g.id, 'raster-opacity', k === i ? 1 : 0));
  $('#tl-year').textContent = f.label;
  $$('#tl-ticks button').forEach((btn, k) => btn.setAttribute('aria-pressed', String(k === i)));
  const parts = [];

  // garimpo
  if (state.on.mining) {
    const isNew = (n) => n.yr >= a && n.yr <= b && n.yr >= 2019;   // 2018 é a linha de base do mapeamento
    const upto = T.near.filter((n) => n.yr <= f.y);
    map.getSource('src-tl').setData({ type: 'FeatureCollection', features: upto.map((n) => detSquare(n, isNew(n))) });
    const total = upto.reduce((s, n) => s + n.ha, 0);
    const nov = upto.filter(isNew).reduce((s, n) => s + n.ha, 0);
    if (f.y < 2018) parts.push('O mapeamento de garimpo começa em 2018.');
    else if (!upto.length) parts.push(`Nenhum garimpo mapeado aqui até ${f.y}.`);
    else parts.push(`${haTxt(total)} de garimpo mapeado em volta${nov ? `; ${haTxt(nov)} surgiram ${spanTxt(a, Math.min(b, NOW_YEAR))} (contorno branco)` : ''}.`);
  } else map.getSource('src-tl').setData(EMPTY);

  // floresta derrubada
  if (state.on.deforestation) {
    const lastLoss = Math.max(...(state.manifest.layers?.deforestation?.loss_years || [0]));
    const bb = Math.min(b, lastLoss);
    const [now, before] = await Promise.all([tlDefSum(T, a, bb), tlDefSum(T, TL_FRAMES[0].y, a - 1)]);
    if (seq !== T.seq || state.tl !== T) return;
    const geo = now.geo || before.geo;
    const feats = [];
    if (geo) {
      const keys = new Set([...now.sum.keys(), ...before.sum.keys()]);
      for (const k of keys) {
        const [x, y] = k.split(',').map(Number);
        const x0 = geo.ox + x * geo.cs, y0 = geo.oy + y * geo.cs, x1 = x0 + geo.cs, y1 = y0 + geo.cs;
        const ha = now.sum.get(k) || 0;
        feats.push({ type: 'Feature', properties: { ha, novo: ha > 0 },
          geometry: { type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] } });
      }
    }
    map.getSource('src-tl-def').setData({ type: 'FeatureCollection', features: feats });
    const nowHa = [...now.sum.values()].reduce((s, v) => s + v, 0);
    const prevHa = [...before.sum.values()].reduce((s, v) => s + v, 0);
    if (!now.years.length) parts.push(`A perda anual de floresta ainda não saiu para ${b}.`);
    else parts.push(nowHa
      ? `${haTxt(nowHa)} de floresta derrubada ${spanTxt(a, bb)} em volta; quanto mais amarelo o quadro de ~5 km, mais perda${prevHa ? `. Antes disso, desde ${TL_FRAMES[0].y}: ${haTxt(prevHa)}` : ''}.`
      : `Nenhuma floresta derrubada ${spanTxt(a, bb)} em volta${prevHa ? `; ${haTxt(prevHa)} desde ${TL_FRAMES[0].y}` : ''}.`);
  } else map.getSource('src-tl-def').setData(EMPTY);

  if (T.air) {
    const first = state.air.first_year || 2017, c = T.air[A.SER][f.y - first];
    if (c == null) parts.unshift(f.y < first ? `A medição da pista começa em ${first}.` : 'A pista ainda não foi medida neste ano.');
    else if (c === '-') parts.unshift(`Pista: imagem de ${f.y} ruim, ano ignorado na medição.`);
    else parts.unshift(`Pista: ${+c * 10}% dela limpa em ${f.y}, medida no Sentinel-2.`);
  }
  parts.push(isLast ? 'Imagem mais recente disponível (Esri).' : `Mosaico Sentinel-2 sem nuvens de ${f.y} (EOX).`);
  if (T.bad.size) {
    const ys = [...T.bad.keys()];
    const lista = ys.length > 1 ? `${ys.slice(0, -1).join(', ')} e ${ys[ys.length - 1]}` : String(ys[0]);
    parts.push(`${ys.length > 1 ? 'Os anos' : 'O ano'} ${lista} ${ys.length > 1 ? 'ficaram' : 'ficou'} de fora: imagem ruim neste ponto (${[...new Set(T.bad.values())].join(', ')}).`);
  }
  $('#tl-note').textContent = parts.join(' ');
}

function tlPlay() {
  const T = state.tl;
  if (!T) return;
  clearInterval(T.timer);
  T.timer = setInterval(() => tlShow(tlNext(T.i)), 1900);
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
  for (const id of TL_LAYERS) map.removeLayer(id);
  map.removeSource('src-tl');
  map.removeSource('src-tl-def');
  for (const f of TL_FRAMES) {
    map.removeLayer(f.id);
    map.removeSource(f.id);
  }
  for (const l of LAYERS) for (const id of [`lyr-${l}`, `lyr-${l}-edge`]) map.setLayoutProperty(id, 'visibility', 'visible');
  for (const id of RADAR_IDS) map.setLayoutProperty(id, 'visibility', 'visible');
  airDim(1);
  for (const m of state.pins) m.getElement().style.display = '';
  state.tl = null;
  $('#tl').hidden = true;
  document.body.classList.remove('tl-on');
  updateBase();
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
  const air = {};
  for (const [y, v] of Object.entries(s.airstrips?.novas_por_ano || {})) if (+y > 2017) air[y] = { v };
  return [
    ['deforestation', defo, 'Floresta perdida', (v) => haTxt(v), 'claro: alertas GLAD do ano ainda sem o número anual'],
    ['mining', mine, 'Garimpo novo', (v) => haTxt(v), ''],
    ['airstrips', air, 'Pistas que surgiram', (v) => `${fmtInt(v)} ${v === 1 ? 'pista' : 'pistas'}`, 'no último ano da janela em que apareceram'],
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
    div.dataset.layer = l;
    div.hidden = !state.on[l];
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
  if (mode === 'history') state.follow = true;
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
  const [a, b] = yearBounds();
  const yr = $('#year');
  yr.min = a; yr.max = b;
  yr.value = state.year;
  $('#year-label').textContent = state.year;
  $('#year-min').textContent = a;
  $('#year-max').textContent = b;
}

function syncURL() {
  const q = new URLSearchParams();
  if (state.mode !== 'week') q.set('modo', state.mode);
  if (state.tl) q.set('evolucao', `${state.tl.lng.toFixed(4)},${state.tl.lat.toFixed(4)}`);
  if (state.mode === 'history') q.set('ano', state.year);
  const ver = ['deforestation', 'mining', 'airstrips'].filter((l) => state.on[l]);
  if (ver.length < 3 && ver.length) q.set('ver', ver.map((l) => VER[l]).join(','));
  const tipos = [...state.airTypes].sort().join(',');
  if (tipos !== '0') q.set('pistas', tipos.replace('reg', 'anac'));
  if (state.base === 'dark') q.set('fundo', 'mapa');
  else if (state.mode !== 'history' && state.imgYear) q.set('imagem', state.imgYear);
  const s = q.toString();
  history.replaceState(null, '', s ? `?${s}` : location.pathname);
}

// ------------------------------------------------------------------ imagem de satélite por ano
// Fora do Histórico, o visitante escolhe o ano da imagem. No Histórico, a imagem
// acompanha o ano escolhido na régua (o mosaico mais próximo que não seja posterior).
const IMG_SEQ = [...TL_YEARS, 'hoje'];

function currentImage() {
  if (state.base === 'dark') return { key: 'mapa', note: 'Mapa simples, sem imagem de satélite.' };
  if (state.mode === 'history' && state.follow) {
    const want = state.year, last = TL_YEARS[TL_YEARS.length - 1];
    if (want > last) return { key: 'hoje', note: `Ainda não há mosaico anual de ${want}; esta é a imagem mais recente (Esri).` };
    const av = TL_YEARS.filter((k) => k <= want && !state.badYears.has(k));
    const why = state.badYears.get(want);
    if (!av.length) return { key: 'hoje', note: why ? `A imagem de ${want} está ruim aqui (${why}); esta é a imagem atual (Esri).` : `Não há imagem de ${want}: os mosaicos anuais começam em ${TL_YEARS[0]}. Esta é a imagem atual (Esri).` };
    const y = Math.max(...av);
    return { key: y, note: y === want ? `Mosaico Sentinel-2 de ${y}: a imagem acompanha o ano do histórico.`
      : why ? `A imagem de ${want} está ruim aqui (${why}); este é o mosaico de ${y}.` : `Não há mosaico de ${want}; este é o de ${y}.` };
  }
  if (state.imgYear) {
    const why = state.badYears.get(state.imgYear);
    if (!why) return { key: state.imgYear, note: `Mosaico Sentinel-2 sem nuvens de ${state.imgYear} (EOX).` };
    const alt = TL_YEARS.find((k) => k > state.imgYear && !state.badYears.has(k));
    return { key: alt || 'hoje', note: `A imagem de ${state.imgYear} está ruim aqui (${why}); mostrando ${alt || 'a atual'}.` };
  }
  return { key: 'hoje', note: 'Imagem mais recente (Esri).' };
}

function updateBase() {
  const img = currentImage();
  const s2 = typeof img.key === 'number';
  // uma camada por ano (trocar os tiles de uma fonte só quebra o MapLibre com tiles em voo)
  if (s2 && !map.getLayer(`base-s2-${img.key}`)) {
    map.addSource(`s2-${img.key}`, RASTER([eoxUrl(img.key)], 'Sentinel-2 cloudless © <a href="https://s2maps.eu">EOX</a> (dados Copernicus)', 15));
    map.addLayer({ id: `base-s2-${img.key}`, type: 'raster', source: `s2-${img.key}` }, 'fora-fill');
  }
  for (const y of TL_YEARS) if (map.getLayer(`base-s2-${y}`)) map.setLayoutProperty(`base-s2-${y}`, 'visibility', img.key === y ? 'visible' : 'none');
  map.setLayoutProperty('base-dark', 'visibility', img.key === 'mapa' ? 'visible' : 'none');
  map.setLayoutProperty('base-sat', 'visibility', img.key === 'hoje' ? 'visible' : 'none');
  let note = img.note;
  if (img.key !== 'mapa' && state.mode !== 'history') note += ' No Histórico, a imagem muda junto com o ano.';
  $('#base-note').textContent = note;
  $$('#imgs button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.img === String(img.key)));
    const why = state.badYears.get(+b.dataset.img);
    b.disabled = !!why;
    b.title = why ? `Imagem ruim nesta área (${why})` : '';
  });
  $('#img-badge').hidden = img.key === 'mapa' || !!state.tl;
  $('#img-year').textContent = s2 ? img.key : 'Hoje';
  $('#img-src').textContent = s2 ? 'Sentinel-2' : 'Esri';
  const seq = IMG_SEQ.filter((k) => !state.badYears.has(k));
  const i = seq.indexOf(img.key);
  $('#img-prev').disabled = i <= 0;
  $('#img-next').disabled = i >= seq.length - 1;
}

function pickImage(key) {
  const wasDark = state.base === 'dark';
  if (key === 'mapa') state.base = 'dark';
  else {
    state.base = 'sat';
    const y = key === 'hoje' ? null : +key;
    if (state.mode === 'history') {
      state.follow = y != null;
      if (y != null && state.year !== y) {
        const [a, b] = yearBounds();
        state.year = Math.min(b, Math.max(a, y));
        syncYearUI();
        render();
      }
    } else state.imgYear = y;
  }
  updateBase();
  if (wasDark !== (state.base === 'dark')) applyPaint();
  syncURL();
}

function stepImage(dir) {
  const seq = IMG_SEQ.filter((k) => !state.badYears.has(k));
  const i = seq.indexOf(currentImage().key);
  const j = Math.min(seq.length - 1, Math.max(0, i + dir));
  if (j !== i) pickImage(String(seq[j]));
}

function buildImageChips() {
  const box = $('#imgs');
  box.innerHTML = '';
  for (const k of [...IMG_SEQ].reverse().concat('mapa')) {
    const b = document.createElement('button');
    b.dataset.img = String(k);
    b.textContent = k === 'hoje' ? 'Hoje' : k === 'mapa' ? 'Sem imagem' : String(k);
    if (k === 'mapa') b.className = 'wide';
    b.addEventListener('click', () => pickImage(String(k)));
    box.appendChild(b);
  }
}

// ------------------------------------------------------------------ o que mostrar
function yearBounds() {
  const L = state.manifest.layers || {};
  const ys = [];
  if (state.on.deforestation) ys.push(...(L.deforestation?.loss_years || []), ...(L.deforestation?.alert_years || []));
  if (state.on.mining) ys.push(...(L.mining?.years || []));
  if (state.on.airstrips && L.airstrips) ys.push(2017);
  return [ys.length ? Math.min(...ys) : 2001, NOW_YEAR];
}

function setShow(v) {
  for (const l of ['deforestation', 'mining', 'airstrips']) state.on[l] = v === 'all' || v === l;
  layersChanged();
}

// 'all', uma camada só, ou '' quando a combinação não é nenhum dos botões
function showValue() {
  const on = ['deforestation', 'mining', 'airstrips'].filter((l) => state.on[l]);
  return on.length === 3 ? 'all' : on.length === 1 ? on[0] : '';
}
const VER = { deforestation: 'desmatamento', mining: 'garimpo', airstrips: 'pistas' };

function layersChanged() {
  $$('#show button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.show === showValue())));
  $$('.layer[data-layer]').forEach((b) => b.setAttribute('aria-pressed', String(state.on[b.dataset.layer])));
  LAYERS.forEach(drawLayer);
  drawAir();
  drawAirKey();
  if (state.mode !== 'radar') writeLede();
  $$('#charts .chart').forEach((c) => { c.hidden = !state.on[c.dataset.layer]; });
  const [a] = yearBounds();
  if (state.mode === 'history' && state.year < a) { stopPlay(); setYear(a); }
  else { syncYearUI(); syncURL(); }
  if (state.tl) tlShow(state.tl.i);
}

function play() {
  if (state.playing) return stopPlay();
  $('#play span').textContent = '❚❚';
  $('#play').setAttribute('aria-label', 'Pausar');
  const first = yearBounds()[0];
  let y = state.year >= NOW_YEAR || state.year < first ? first : state.year;
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
  $$('#show button').forEach((b) => b.addEventListener('click', () => setShow(b.dataset.show)));
  $$('.layer[data-layer]').forEach((btn) => btn.addEventListener('click', () => {
    const l = btn.dataset.layer;
    state.on[l] = !state.on[l];
    layersChanged();
  }));
  $('#air-types').addEventListener('click', (e) => { const b = e.target.closest('button[data-type]'); if (b && !b.disabled) toggleAirType(b.dataset.type); });
  $('#img-prev').addEventListener('click', () => stepImage(-1));
  $('#img-next').addEventListener('click', () => stepImage(1));
  $$('.layer[data-radar]').forEach((btn) => btn.addEventListener('click', () => {
    const k = btn.dataset.radar;
    state.radarOn[k] = !state.radarOn[k];
    btn.setAttribute('aria-pressed', String(state.radarOn[k]));
    renderRadar();
  }));
  $('#cumulative').addEventListener('change', (e) => { state.cumulative = e.target.checked; render(); });
  const yr = $('#year');
  yr.addEventListener('input', () => { $('#year-label').textContent = yr.value; });
  yr.addEventListener('change', () => setYear(+yr.value));
  $('#play').addEventListener('click', play);
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.tl-open');
    if (b) openTimelapse(+b.dataset.lng, +b.dataset.lat, b.dataset.kind);
    const c = e.target.closest('.geo-copy');
    if (c) copyLL(c);
  });
  $('#tl-play').addEventListener('click', () => (state.tl?.timer ? tlPause() : tlPlay()));
  $('#tl-close').addEventListener('click', closeTimelapse);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.tl) closeTimelapse(); });
  $('#sheet-handle').addEventListener('click', () => {
    const closed = $('#rail').classList.toggle('closed');
    $('#sheet-handle').setAttribute('aria-expanded', String(!closed));
  });
  // reagrega as células quando o zoom muda o tamanho mínimo visível
  map.on('moveend', checkCenterQuality);
  map.on('zoomend', () => {
    for (const l of LAYERS) {
      const r = state.results[l];
      if (r?.cells && factorFor(r.cells.cs, MIN_PX[l]) !== state.factors[l]) drawLayer(l);
    }
    if (state.airZoom !== Math.round(map.getZoom() * 2) / 2) drawAir();
  });
  // parâmetros na URL: ?modo=history&ano=2019&fundo=sat
  const q = new URLSearchParams(location.search);
  const ver = (q.get('ver') || '').split(',').filter((v) => Object.values(VER).includes(v));
  if (ver.length) {
    for (const [l, name] of Object.entries(VER)) state.on[l] = ver.includes(name);
    $$('#show button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.show === showValue())));
    $$('.layer[data-layer]').forEach((b) => b.setAttribute('aria-pressed', String(state.on[b.dataset.layer])));
  }
  if (q.get('ano')) { const [a, b] = yearBounds(); state.year = Math.min(b, Math.max(a, +q.get('ano'))); }
  const tipos = (q.get('pistas') || '').split(',').map((t) => (t === 'anac' ? 'reg' : t)).filter((t) => AIR_TYPES.some(([k]) => k === t));
  if (tipos.length) state.airTypes = new Set(tipos);
  const evo = (q.get('evolucao') || '').split(',').map(Number);
  if (evo.length === 2 && evo.every(Number.isFinite)) setTimeout(() => openTimelapse(evo[0], evo[1]), 300);
  const fundo = q.get('fundo'), imagem = +q.get('imagem');
  if (fundo === 'mapa' || fundo === 'dark') pickImage('mapa');
  else if (TL_YEARS.includes(imagem)) pickImage(String(imagem));
  else if (fundo === 's2') pickImage(String(TL_YEARS[TL_YEARS.length - 1]));
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
  buildImageChips();
  syncYearUI();
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
