/* Amazon Sentry: floresta perdida e garimpo novo no Brasil, com o Radar IA.
 * Sem build: MapLibre GL (vendor/) + JSON gerado pelo pipeline em data/.
 *
 * Gramática visual: terra que muda = mancha de calor de longe e a área real de perto (célula do dado
 * ou o quadro de cada garimpo); previsão = contorno vazado; pista de pouso = traço na direção real da
 * pista (cheio se em uso, tracejado se abandonada). Garimpo de perto: cheio sem lavra autorizada,
 * vazado com lavra autorizada; as áreas da ANM e as terras indígenas e UCs aparecem como contornos.
 */
'use strict';

const DATA = 'data/';
const DAY_MS = 86400000;
const NOW_YEAR = new Date().getUTCFullYear();
const LAYERS = ['deforestation', 'mining'];   // ordem de desenho
const COLOR = { deforestation: '#f3c34a', mining: '#1fc8b4', airstrips: '#ff5fa2', clarao: '#fff3df', negro: '#1b140f',
  lavra: '#f4ead2', proibido: '#ff8a6b',
  aldeia: '#c4a3ff', cidade: '#8cc3ea', anac: '#e9e1d0', anacg: '#ffb25c' };
const REG_NEAR_KM = 5;    // registrada "perto de garimpo": privada a até 5 km de garimpo detectado
// tipos de pista: 0 sem registro (suspeita), 1 aldeia, 2 cidade ou vila (as três conferidas no Sentinel-2) e as registradas na ANAC
const AIR_TYPES = [['0', 'Sem registro', 'suspeitas: não achamos registro na ANAC'], ['1', 'Aldeia', 'pista de aldeia ou missão, de uso comunitário'],
  ['2', 'Cidade ou vila', 'pista pública de cidade ou vila que falta na lista da ANAC'],
  ['reg', 'Outras registradas', 'aeródromo público ou privado cadastrado na ANAC, longe de garimpo'],
  ['regg', 'Registrada perto de garimpo', 'aeródromo privado cadastrado na ANAC a até 5 km de garimpo: o registro não impede o uso pelo garimpo'],
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
const MODES = ['week', 'month', 'quarter', 'year', 'history', 'radar'];
const DAYS = { week: 7, month: 30, quarter: 90 };
const TL_YEARS = Object.keys(EOX_YEARS).map(Number);

const state = {
  mode: 'week', year: NOW_YEAR, cumulative: true, base: 'sat', lastMode: 'week',
  on: { deforestation: true, mining: true, airstrips: true, enforcement: false },
  air: null, airZoom: null, airTypes: new Set(['0', 'regg']), airHover: null,
  radarOn: { risk_def: true, risk_min: true, fronts: true },
  manifest: {}, stats: {}, radar: null, results: {}, factors: {},
  playing: null, renderSeq: 0, pins: [], estados: null, tl: null,
  imgYear: null, follow: true, badYears: new Map(), legal: 'all', nearDrawn: {},
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

const pxPerDeg = (z) => (256 * 2 ** z) / 360;
const NEAR = { deforestation: 9.5, mining: 9 };     // zoom em que a mancha dá lugar à área real

/** Células ou detecções -> pontos da mancha de calor (peso 0..1 pelo percentil 97). */
function heatPoints(r, l) {
  const feats = [];
  if (l === 'mining') {
    const ref = percentile(r.shown.map((it) => it.v), 0.97) || 1;
    for (const it of r.shown) {
      feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [it.x, it.y] }, properties: { w: Math.min(1, it.v / ref) } });
    }
    return feats;
  }
  const c = r.cells;
  const ref = percentile(c.list.map((q) => q.v), 0.97) || 1;
  for (const q of c.list) {
    const x = c.ox + (q.x + 0.5) * c.cs, y = c.oy + (q.y + 0.5) * c.cs;
    feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [x, y] }, properties: { w: Math.min(1, q.v / ref) } });
  }
  return feats;
}

/** De perto: o quadro de cada garimpo (lado pela área) ou a célula de desmatamento. */
function nearFeatures(r, l) {
  const feats = [];
  const sq = (x0, y0, x1, y1) => ({ type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] });
  if (l === 'mining') {
    for (const it of r.shown) {
      const h = Math.sqrt(it.v * 10000) / 111320 / 2, w = h / Math.cos((it.y * Math.PI) / 180);
      feats.push({ type: 'Feature', geometry: sq(it.x - w, it.y - h, it.x + w, it.y + h),
        properties: { layer: l, v: it.v, cls: it.cls || '', x0: it.x - w, y0: it.y - h, x1: it.x + w, y1: it.y + h } });
    }
    return feats;
  }
  const c = r.cells;
  const ref = percentile(c.list.map((q) => q.v), 0.97) || 1;
  for (const q of c.list) {
    const x0 = c.ox + q.x * c.cs, y0 = c.oy + q.y * c.cs;
    feats.push({ type: 'Feature', geometry: sq(x0, y0, x0 + c.cs, y0 + c.cs),
      properties: { layer: l, v: q.v, w: Math.min(1, q.v / ref), x0, y0, x1: x0 + c.cs, y1: y0 + c.cs } });
  }
  return feats;
}

// raio da mancha: cresce com o zoom e nunca fica menor que a célula do dado
// células grandes (histórico, 25 km) somam menos pontos por área: reforça; garimpo acumulado (muitos pontos): alivia
const HEAT_I = { deforestation: [[3, 0.24], [5, 0.34], [7, 0.6], [9, 1]], mining: [[3, 1.4], [5, 1.6], [7, 1.8], [9, 2]] };
function heatIntensity(l, r) {
  const k = l === 'mining'
    ? Math.min(1, Math.max(0.5, Math.sqrt(2500 / Math.max(1, r.shown.length))))
    : Math.min(4, Math.max(1, (r.cells.cs / 0.1) ** 2));
  return ['interpolate', ['linear'], ['zoom'], ...HEAT_I[l].flatMap(([z, v]) => [z, v * k])];
}
function heatRadius(cs, base) {
  const stops = [];
  for (const [z, px] of base) stops.push(z, Math.max(px, 1.3 * cs * pxPerDeg(z)));
  return ['interpolate', ['linear'], ['zoom'], ...stops];
}

// ------------------------------------------------------------------ mapa
const RASTER = (tiles, attribution, maxzoom = 19) => ({ type: 'raster', tiles, tileSize: 256, attribution, maxzoom });
// mapa comum e relevo da Esri (a CARTO passou a exigir chave)
const ESRI = (name) => `https://server.arcgisonline.com/ArcGIS/rest/services/${name}/MapServer/tile/{z}/{y}/{x}`;
const EMPTY = { type: 'FeatureCollection', features: [] };
const map = new maplibregl.Map({
  container: 'map',
  center: [-56, -10], zoom: 3.7, minZoom: 2.5, maxZoom: 16,
  attributionControl: { compact: true },
  style: {
    version: 8,
    sources: {
      mapa: RASTER([ESRI('World_Street_Map')], 'Mapa © Esri, HERE, Garmin, OpenStreetMap', 19),
      'relevo-base': RASTER([ESRI('World_Terrain_Base')], 'Relevo © Esri, USGS, NOAA', 13),
      'relevo-rotulos': RASTER([ESRI('Reference/World_Reference_Overlay')], '', 13),
      dem: { type: 'raster-dem', encoding: 'terrarium', tileSize: 256, maxzoom: 14,
        tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
        attribution: 'Relevo: <a href="https://registry.opendata.aws/terrain-tiles/">Terrain Tiles</a> (AWS, Mapzen)' },
      sat: RASTER(['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        'Imagens © Esri, Maxar, Earthstar Geographics'),
      brasil: { type: 'geojson', data: DATA + 'base/brasil.geojson' },
      fora: { type: 'geojson', data: EMPTY },
      estados: { type: 'geojson', data: DATA + 'base/estados.geojson' },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': COLOR.negro } },
      { id: 'base-mapa', type: 'raster', source: 'mapa', layout: { visibility: 'none' } },
      { id: 'base-relevo', type: 'raster', source: 'relevo-base', layout: { visibility: 'none' }, paint: { 'raster-saturation': -0.25 } },
      { id: 'base-relevo-hs', type: 'hillshade', source: 'dem', layout: { visibility: 'none' },
        paint: { 'hillshade-exaggeration': 0.55, 'hillshade-shadow-color': '#4a3826', 'hillshade-highlight-color': '#fffaf0', 'hillshade-accent-color': '#6b5640' } },
      { id: 'base-relevo-rotulos', type: 'raster', source: 'relevo-rotulos', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.85 } },
      { id: 'base-sat', type: 'raster', source: 'sat' },
      { id: 'fora-fill', type: 'fill', source: 'fora', paint: { 'fill-color': COLOR.negro, 'fill-opacity': 0.55 } },
      { id: 'estados-line', type: 'line', source: 'estados', paint: { 'line-color': '#d6be93', 'line-width': 0.7, 'line-opacity': 0.4 } },
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
  if (state.base !== 'sat') return expr;
  return ['interpolate', ['linear'], ['zoom'],
    5, expr, 8, ['*', expr, 0.7], 10, ['*', expr, 0.45], 12, ['*', expr, 0.25], 14, ['*', expr, 0.12]];
}
// e o contorno aparece quando o preenchimento some
function outlineOpacity() {
  if (state.base !== 'sat') return ['interpolate', ['linear'], ['zoom'], 9, 0, 12, 0.5];
  return ['interpolate', ['linear'], ['zoom'], 7, 0, 10, 0.75, 13, 0.95];
}

// Mancha de calor: opaca o bastante para se ver de longe, em cima do satélite ou do mapa.
// Em fundo escuro (satélite) a cor clareia com a densidade; em fundo claro (mapa, relevo) escurece.
const HEAT = {
  dark: {
    deforestation: ['interpolate', ['linear'], ['heatmap-density'],
      0, 'rgba(243,195,74,0)', 0.03, 'rgba(206,92,18,0.26)', 0.12, 'rgba(222,112,22,0.46)', 0.25, 'rgba(236,140,30,0.66)',
      0.45, 'rgba(243,186,60,0.88)', 0.7, 'rgba(255,212,104,0.95)', 1, 'rgba(255,232,160,0.97)'],
    mining: ['interpolate', ['linear'], ['heatmap-density'],
      0, 'rgba(31,200,180,0)', 0.03, 'rgba(12,132,118,0.5)', 0.15, 'rgba(22,176,158,0.76)',
      0.4, 'rgba(31,200,180,0.92)', 0.7, 'rgba(92,228,206,0.95)', 1, 'rgba(168,246,232,0.97)'],
  },
  light: {
    deforestation: ['interpolate', ['linear'], ['heatmap-density'],
      0, 'rgba(232,150,30,0)', 0.03, 'rgba(240,170,50,0.32)', 0.15, 'rgba(236,146,30,0.5)',
      0.4, 'rgba(222,118,14,0.64)', 0.7, 'rgba(196,88,8,0.74)', 1, 'rgba(150,58,4,0.82)'],
    mining: ['interpolate', ['linear'], ['heatmap-density'],
      0, 'rgba(31,200,180,0)', 0.03, 'rgba(40,196,176,0.3)', 0.15, 'rgba(26,176,158,0.48)',
      0.4, 'rgba(16,146,132,0.62)', 0.7, 'rgba(10,116,106,0.72)', 1, 'rgba(4,84,76,0.8)'],
  },
};
// as células muito fracas quase não pesam, mas ainda pintam a borda da mancha
const HEAT_W = ['interpolate', ['linear'], ['get', 'w'], 0, 0.02, 1, 1];
const HEAT_BASE = { deforestation: [[3, 9], [5, 15], [7, 24], [9, 38], [11, 64], [13, 120], [15, 240], [17, 480]],
  mining: [[3, 9], [5, 14], [7, 20], [9, 28], [11, 36], [13, 48]] };
// layers das camadas de terra (o timelapse esconde todas)
const LAND_IDS = ['heat-deforestation', 'lyr-deforestation', 'heat-mining', 'areas-fill', 'areas-line', 'anm-fill', 'anm-lavra', 'anm-pedido',
  'lyr-mining', 'lyr-mining-edge'];

function applyPaint() {
  const sat = state.base === 'sat';
  for (const l of LAYERS) {
    const n = NEAR[l];
    map.setPaintProperty(`heat-${l}`, 'heatmap-color', HEAT[sat ? 'dark' : 'light'][l]);
    // o desmatamento vem em células de 2 a 25 km: fica mancha em qualquer zoom, mais transparente de perto
    map.setPaintProperty(`heat-${l}`, 'heatmap-opacity', l === 'deforestation'
      ? ['interpolate', ['linear'], ['zoom'], 8, 0.92, 11, 0.74, 14, 0.58]
      : ['interpolate', ['linear'], ['zoom'], n - 1, 0.92, n + 1, 0]);
  }
  // contornos do Brasil e dos estados: claros no satélite, tinta no mapa claro
  map.setPaintProperty('brasil-line', 'line-color', sat ? '#d6be93' : '#5a4632');
  map.setPaintProperty('estados-line', 'line-color', sat ? '#d6be93' : '#5a4632');
  // as células do desmatamento ficam invisíveis: só servem para o clique
  map.setPaintProperty('lyr-deforestation', 'fill-opacity', 0);
  const m = NEAR.mining;
  // sem lavra autorizada = cheio; com lavra autorizada = só o contorno
  map.setPaintProperty('lyr-mining', 'fill-opacity', ['interpolate', ['linear'], ['zoom'],
    m - 1, 0, m + 1, ['case', ['==', ['get', 'cls'], 'com'], 0, sat ? 0.6 : 0.75], 14, ['case', ['==', ['get', 'cls'], 'com'], 0, sat ? 0.35 : 0.6]]);
  map.setPaintProperty('lyr-mining-edge', 'line-opacity', ['interpolate', ['linear'], ['zoom'], m - 1, 0, m + 1, 1]);
  map.setPaintProperty('radar-def-fill', 'fill-opacity', fade(['interpolate', ['linear'], ['get', 'score'], 40, 0, 100, 0.22]));
  map.setPaintProperty('radar-min-fill', 'fill-opacity', fade(['interpolate', ['linear'], ['get', 'score'], 15, 0.04, 80, 0.3]));
  map.setPaintProperty('radar-fronts', 'circle-opacity', fade(0.95));
  map.setPaintProperty('fora-fill', 'fill-color', sat ? COLOR.negro : '#f4efe6');
  map.setPaintProperty('fora-fill', 'fill-opacity', sat ? 0.45 : 0.55);
  // áreas da ANM: creme no satélite, tinta no mapa claro
  const lavra = sat ? COLOR.lavra : '#4a3522';
  map.setPaintProperty('anm-fill', 'fill-color', lavra);
  map.setPaintProperty('anm-lavra', 'line-color', lavra);
  map.setPaintProperty('anm-pedido', 'line-color', lavra);
}

function addDataLayers() {
  for (const l of LAYERS) {
    map.addSource(`src-${l}-heat`, { type: 'geojson', data: EMPTY });
    map.addSource(`src-${l}`, { type: 'geojson', data: EMPTY });
  }
  // de longe, mancha de calor; de perto, a área real
  map.addLayer({ id: 'heat-deforestation', type: 'heatmap', source: 'src-deforestation-heat',
    paint: { 'heatmap-weight': HEAT_W, 'heatmap-color': HEAT.dark.deforestation,
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 3, 0.24, 5, 0.34, 7, 0.6, 9, 1] } });
  map.addLayer({ id: 'lyr-deforestation', type: 'fill', source: 'src-deforestation', minzoom: NEAR.deforestation - 1.2,
    paint: { 'fill-color': COLOR.deforestation, 'fill-antialias': false } });
  map.addLayer({ id: 'heat-mining', type: 'heatmap', source: 'src-mining-heat', maxzoom: NEAR.mining + 1.2,
    paint: { 'heatmap-weight': HEAT_W, 'heatmap-color': HEAT.dark.mining,
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 3, 1.4, 5, 1.6, 7, 1.8, 9, 2] } });
  // autorização: terras indígenas e UCs de proteção integral, e os processos da ANM com garimpo dentro
  map.addSource('src-areas', { type: 'geojson', data: EMPTY });
  map.addSource('src-anm', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'areas-fill', type: 'fill', source: 'src-areas', minzoom: 5,
    paint: { 'fill-color': COLOR.proibido, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.04, 10, 0.08] } });
  map.addLayer({ id: 'areas-line', type: 'line', source: 'src-areas', minzoom: 5,
    paint: { 'line-color': COLOR.proibido, 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1, 10, 2.2],
      'line-dasharray': [3, 1.5], 'line-opacity': 0.9 } });
  map.addLayer({ id: 'anm-fill', type: 'fill', source: 'src-anm', minzoom: 7, filter: ['==', ['get', 't'], 2],
    paint: { 'fill-color': COLOR.lavra, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 7, 0.1, 11, 0.16] } });
  map.addLayer({ id: 'anm-pedido', type: 'line', source: 'src-anm', minzoom: 8, filter: ['==', ['get', 't'], 1],
    paint: { 'line-color': COLOR.lavra, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 12, 1],
      'line-dasharray': [1, 2.5], 'line-opacity': ['interpolate', ['linear'], ['zoom'], 8, 0.2, 12, 0.45] } });
  map.addLayer({ id: 'anm-lavra', type: 'line', source: 'src-anm', minzoom: 7, filter: ['==', ['get', 't'], 2],
    paint: { 'line-color': COLOR.lavra, 'line-width': ['interpolate', ['linear'], ['zoom'], 7, 1, 11, 2], 'line-opacity': 0.95 } });
  map.addLayer({ id: 'lyr-mining', type: 'fill', source: 'src-mining', minzoom: NEAR.mining - 1.2,
    paint: { 'fill-color': COLOR.mining, 'fill-antialias': false } });
  map.addLayer({ id: 'lyr-mining-edge', type: 'line', source: 'src-mining', minzoom: NEAR.mining - 1.2,
    paint: { 'line-color': COLOR.mining, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.8, 13, 1.6] } });
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
  const airW = (pad = 0) => ['interpolate', ['linear'], ['zoom'], 3, 1.6 + pad * 0.6, 6, 2 + pad * 0.8, 8, 3 + pad, 12, 4 + pad, 14, 2.6 + pad * 0.5, 16, 2 + pad * 0.4];
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
    paint: { 'line-color': ['case', ['==', ['get', 'near'], 1], COLOR.anacg, COLOR.anac],
      'line-width': ['interpolate', ['linear'], ['zoom'], 3, ['case', ['==', ['get', 'near'], 1], 2, 1.2], 10, ['case', ['==', ['get', 'near'], 1], 3, 2], 14, 1.6],
      'line-opacity': airOpacity(0.85) } });
  map.addLayer({ id: 'air-reg-dot', type: 'circle', source: 'src-air-reg', filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, ['case', ['==', ['get', 'near'], 1], 2.2, 1.6], 10, ['case', ['==', ['get', 'near'], 1], 4.2, 3.2]],
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': ['case', ['==', ['get', 'near'], 1], COLOR.anacg, COLOR.anac],
      'circle-stroke-width': ['case', ['==', ['get', 'near'], 1], 2, 1.3], 'circle-stroke-opacity': airOpacity(0.85) } });
  map.addLayer({ id: 'air-hit', type: 'line', source: 'src-air', paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 16 } });
  map.addLayer({ id: 'air-reg-hit', type: 'line', source: 'src-air-reg', filter: ['==', ['geometry-type'], 'LineString'],
    paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 14 } });
  map.addLayer({ id: 'air-reg-hitdot', type: 'circle', source: 'src-air-reg', filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-color': '#000', 'circle-opacity': 0, 'circle-radius': 8 } });
  for (const [id, src] of [['air-hit', 'src-air'], ['air-reg-hit', 'src-air-reg'], ['air-reg-hitdot', 'src-air-reg']]) {
    map.on('mousemove', id, (e) => airHover(src, e.features[0]?.id));
    map.on('mouseleave', id, () => airHover(null));
  }

  for (const id of ['lyr-deforestation', 'lyr-mining', 'anm-fill', 'areas-fill', 'radar-def-fill', 'radar-min-fill', 'radar-fronts', 'air-hit', 'air-reg-hit', 'air-reg-hitdot']) {
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
  }
  map.on('click', onMapClick);
  applyPaint();
}

function onMapClick(e) {
  const ids = state.mode === 'radar'
    ? ['radar-fronts', 'radar-min-fill', 'radar-def-fill']
    : ['air-hit', 'air-reg-hit', 'air-reg-hitdot', 'lyr-mining', 'lyr-deforestation', 'anm-fill', 'areas-fill'];
  const feats = map.queryRenderedFeatures(e.point, { layers: ids.filter((i) => map.getLayer(i)) });
  const f = feats[0];
  if (f?.layer.id === 'air-hit') return airPopup(f.properties.i, e.lngLat);
  if (f?.layer.id.startsWith('air-reg')) return airRegPopup(f.properties.i, e.lngLat);
  let html = '';
  if (f?.layer.id === 'radar-fronts') {
    const p = f.properties, tipos = state.radar?.fronts_tipos || {};
    html = `<h3>${esc(cap(tipos[p.tipo] || 'Abertura recente'))}</h3>
      <div class="big">${haTxt(p.ha)}</div>derrubados até ${fmtDay(p.dia)}
      <p class="fine">Chance prevista para a área: ${p.rd}% de desmatamento forte, ${p.rm}% de garimpo novo.</p>`;
  } else if (f?.layer.id.startsWith('radar-')) {
    const c = radarCellAt(e.lngLat);
    html = `<h3>Previsão para ${state.radar.previsao_ano}</h3>
      <p>Chance de perder 50 ha ou mais de floresta: <b>${c ? c.rd : 0}%</b><br>Chance de surgir garimpo novo: <b>${c ? c.rm : 0}%</b></p>
      <p class="fine">Quadro de ~11 km.</p>`;
  } else if (state.mode !== 'radar') {
    html = landPopup(e, feats);
  }
  if (!html) {
    // clique num ponto vazio (de perto): coordenadas para copiar ou abrir no Google Maps,
    // por exemplo para apontar uma pista que o mapa ainda não marcou
    if (map.getZoom() >= 10) {
      new maplibregl.Popup({ maxWidth: '260px', className: 'geo-pop' }).setLngLat(e.lngLat)
        .setHTML(`<h3>Ponto no mapa</h3>${geoRow(e.lngLat.lng, e.lngLat.lat)}${reportLink('Pista apontada', e.lngLat.lng, e.lngLat.lat,
          'Pista vista na imagem de satélite e que o mapa ainda não marca.', 'Apontar pista aqui')}`).addTo(map);
    }
    return;
  }
  if (f?.layer.id.startsWith('radar-')) {
    const p = f.properties;
    const kind = f.layer.id.startsWith('radar-min') || (f.layer.id === 'radar-fronts' && p.tipo === 1) ? 'mining' : 'deforestation';
    html += `<button class="tl-open" data-kind="${kind}" data-lng="${e.lngLat.lng}" data-lat="${e.lngLat.lat}">Ver a evolução por satélite</button>`;
  }
  html += geoRow(e.lngLat.lng, e.lngLat.lat);
  new maplibregl.Popup({ maxWidth: '280px' }).setLngLat(e.lngLat).setHTML(html).addTo(map);
}

// Popup de terra: garimpo e desmatamento no trecho clicado (de longe, um raio de ~16 px; de perto, o quadro
// clicado), com a situação na ANM, o processo e a área protegida embaixo do ponto.
function landPopup(e, feats) {
  const z = map.getZoom(), ll = e.lngLat;
  const hit = (id) => feats.find((f) => f.layer.id === id);
  const half = 16 / pxPerDeg(z);
  const around = { x0: ll.lng - half, x1: ll.lng + half, y0: ll.lat - half, y1: ll.lat + half };
  const fm = hit('lyr-mining'), fd = hit('lyr-deforestation');
  const anm = feats.filter((f) => f.layer.id === 'anm-fill').concat(
    map.getLayer('anm-pedido') && z >= 7 ? map.queryRenderedFeatures([[e.point.x - 1, e.point.y - 1], [e.point.x + 1, e.point.y + 1]], { layers: ['anm-pedido'] }) : []);
  const inAnm = anmAt(ll);
  const area = hit('areas-fill');
  let out = '', kind = null, side = 0;
  const r = state.results;
  if (state.on.mining && r.mining?.shown) {
    const box = fm ? fm.properties : z < NEAR.mining + 0.5 ? around : null;
    const v = box ? sumItems(r.mining.shown, box) : 0;
    if (v) {
      side = (box.x1 - box.x0) * 111 * Math.cos((ll.lat * Math.PI) / 180);
      const what = fm ? 'de área de garimpo neste quadro' : `de garimpo num raio de ~${fmtKm(side / 2)}`;
      out += `<h3>Garimpo novo</h3><div class="big">${haTxt(v)}</div>${what}${legalPopup(box)}`;
      out += `<p class="fine">${esc(r.mining.note || '')}.</p>`;
      kind = 'mining';
    }
  }
  if (!out && state.on.deforestation && r.deforestation?.cells) {
    const box = fd ? fd.properties : z < NEAR.deforestation + 0.5 ? around : null;
    const v = box ? sumCells(r.deforestation.cells, box) : 0;
    if (v) {
      side = (box.x1 - box.x0) * 111 * Math.cos((ll.lat * Math.PI) / 180);
      out += `<h3>Floresta perdida</h3><div class="big">${haTxt(v)}</div>de floresta derrubada ${fd ? `neste quadro de ~${fmtKm(side)}` : `num raio de ~${fmtKm(side / 2)}`}`;
      out += `<p class="fine">${esc(r.deforestation.note || '')}.</p>`;
      kind = 'deforestation';
    }
  }
  // processo da ANM e área protegida embaixo do ponto
  const procs = inAnm.length ? inAnm : anm.map((f) => f.properties);
  if (state.on.mining && procs.length) {
    const top = procs.sort((a, b) => b.t - a.t).slice(0, 2);
    out += `${out ? '' : '<h3>Processo na ANM</h3>'}<ul class="anm">${top.map((p) => `<li class="${p.t === 2 ? 'lavra' : 'pedido'}">
      <b>${p.t === 2 ? 'Lavra autorizada' : 'Ainda sem lavra autorizada'}</b><br>${esc(p.f)}${p.s ? `, ${esc(p.s.toLowerCase())}` : ''}<br><span>processo ${esc(p.p)}</span></li>`).join('')}</ul>`;
  }
  if (state.on.mining && area) {
    const a = area.properties;
    out += `${out ? '' : `<h3>${esc(nomeArea(a.n))}</h3>`}<p class="proibido">${out ? `Dentro de ${esc(nomeArea(a.n))}: ` : ''}${a.a === 1 ? 'terra indígena' : 'unidade de conservação de proteção integral'}, onde garimpo é proibido.</p>`;
  }
  if (out && kind) out += `<button class="tl-open" data-kind="${kind}" data-lng="${ll.lng}" data-lat="${ll.lat}">Ver a evolução por satélite</button>`;
  return out;
}
const fmtKm = (km) => (km >= 10 ? `${Math.round(km)} km` : km >= 1 ? `${nf.format(Math.round(km * 10) / 10)} km` : `${Math.round(km * 100) * 10} m`);
const inBox = (x, y, b) => x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1;
function sumItems(items, b) {
  let v = 0;
  for (const it of items) if (inBox(it.x, it.y, b)) v += it.v;
  return v;
}
function sumCells(c, b) {
  let v = 0;
  for (const q of c.list) {
    const x = c.ox + (q.x + 0.5) * c.cs, y = c.oy + (q.y + 0.5) * c.cs;
    if (inBox(x, y, b)) v += q.v;
  }
  return v;
}
// processos da ANM que contêm o ponto (mesmo com o mapa longe, quando os contornos não aparecem)
function anmAt(ll) {
  const out = [];
  for (const f of state.anm?.features || []) {
    const bb = f.bbox || (f.bbox = bboxOf(f.geometry));
    if (ll.lng < bb[0] || ll.lng > bb[2] || ll.lat < bb[1] || ll.lat > bb[3]) continue;
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    if (polys.some((rings) => inRing(ll.lng, ll.lat, rings[0]) && !rings.slice(1).some((h) => inRing(ll.lng, ll.lat, h)))) out.push(f.properties);
  }
  return out;
}
function bboxOf(g) {
  const bb = [Infinity, Infinity, -Infinity, -Infinity];
  const walk = (c) => { if (typeof c[0] === 'number') { bb[0] = Math.min(bb[0], c[0]); bb[1] = Math.min(bb[1], c[1]); bb[2] = Math.max(bb[2], c[0]); bb[3] = Math.max(bb[3], c[1]); } else c.forEach(walk); };
  walk(g.coordinates);
  return bb;
}
// contornos da ANM e das áreas protegidas: só baixa quando o garimpo está ligado
async function loadLegalShapes() {
  if (state.anm !== undefined || !state.legalDoc?.titulos_ok) return;
  state.anm = null;
  const [anm, areas] = await Promise.all([getJSON('mining/anm.json'), getJSON('mining/areas.json')]);
  state.anm = anm;
  if (anm) map.getSource('src-anm')?.setData(anm);
  if (areas) map.getSource('src-areas')?.setData(areas);
  $('#legal-key').hidden = false;
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
// nomes do WDPA vêm com todas as palavras em maiúscula: "Área De Proteção Ambiental Do Tapajós"
const nomeArea = (s) => String(s).replace(/ (D[aeo]s?|E) /g, (m) => m.toLowerCase());

// latitude, longitude do ponto: copiar ou abrir no Google Maps (vista de satélite)
function geoRow(lng, lat) {
  const ll = `${(+lat).toFixed(5)}, ${(+lng).toFixed(5)}`;
  const url = `https://www.google.com/maps/@${(+lat).toFixed(6)},${(+lng).toFixed(6)},1500m/data=!3m1!1e3`;
  return `<div class="geo"><span class="geo-ll">${ll}</span>
    <button type="button" class="geo-copy" data-ll="${ll}">Copiar</button>
    <a class="geo-maps" href="${url}" target="_blank" rel="noopener">Abrir no Google Maps</a></div>`;
}

// Apontar uma pista que falta (ou marcar um traço errado): abre uma issue no GitHub já
// preenchida. A issue de quem cuida do site vira dado e dispara a conferência no satélite.
const REPO = 'https://github.com/AtilioRobertoDEV/AMAZONSENTRY';
function reportLink(kind, lng, lat, note, label, ends) {
  const ll = `${(+lat).toFixed(5)}, ${(+lng).toFixed(5)}`;
  const body = `${note}\n\nAberta pelo botão do mapa. Não mude o título.${ends ? `\n\neixo: ${JSON.stringify(ends)}` : ''}`;
  const url = `${REPO}/issues/new?title=${encodeURIComponent(`${kind}: ${ll}`)}&body=${encodeURIComponent(body)}`;
  return `<a class="geo-report" href="${url}" target="_blank" rel="noopener">${label}</a>`;
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
  if (m === 'quarter') {
    // 90 dias: os três últimos meses dos alertas mensais (o arquivo diário guarda só ~5 semanas)
    const rec = await getJSON('deforestation/alerts/recent.json');
    const last = rec?.last_day != null ? dateOfDay(rec.last_day) : new Date();
    const ly = last.getUTCFullYear(), lm = last.getUTCMonth() + 1;
    const first = new Date(Date.UTC(ly, lm - 3, 1));
    const a = dayOf(first.getUTCFullYear(), first.getUTCMonth() + 1), b = dayOf(ly, lm + 1);
    const years = [...new Set([first.getUTCFullYear(), ly])];
    const docs = await Promise.all(years.map((y) => getJSON(`deforestation/alerts/${y}.json`)));
    const parts = docs.filter(Boolean).map((d) => cellsInWindow(d, a, b));
    if (!parts.length) return { total: 0, note: 'sem dados' };
    const merged = new Map();
    for (const c of parts.flatMap((q) => q.list)) {
      const k = c.x * 100000 + c.y, cur = merged.get(k);
      if (cur) cur.v += c.v; else merged.set(k, { ...c });
    }
    const cells = { ...parts[0], list: [...merged.values()], total: parts.reduce((t, q) => t + q.total, 0) };
    return { cells, note: `alertas GLAD-L de ${MONTHS[first.getUTCMonth()]} a ${MONTHS[lm - 1]} de ${ly}` };
  }
  if (m === 'week' || m === 'month') {
    const doc = await getJSON('deforestation/alerts/recent.json');
    if (!doc || doc.last_day == null) return { total: 0, note: 'sem dados' };
    const days = DAYS[m];
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
  if (DAYS[m]) {
    keep = (p) => p === lastP;
    note = `detecções mais recentes, ${periodLabel(lastP)}`;
  } else {
    const y = state.year;
    const cum = m === 'history' && state.cumulative;
    keep = cum ? (p) => Math.floor(p / 10) <= y : (p) => Math.floor(p / 10) === y;
    note = y < 2018 ? 'o monitoramento começa em 2018' : cum ? `somado de 2018 a ${y}` : `garimpo que surgiu em ${y}`;
    if (y === 2018 && !cum) note = 'garimpo que já existia em 2018';
  }
  const legal = await legalIndex();
  const want = legal ? state.legal : 'all';
  const cs = 0.02, out = new Map();
  let total = 0, count = 0;
  const tally = { sem: 0, com: 0, prot: 0, all: 0 }, items = [], shown = [];
  for (let i = 0; i < d.length; i += 5) {
    if (!keep(d[i + 2])) continue;
    const v = d[i + 4];
    const L = legal?.get(`${d[i]},${d[i + 1]}`);
    const cls = legalClass(L);
    tally.all += v;
    if (cls) tally[cls] += v;
    if (L && (L.a === 1 || L.a === 2)) tally.prot += v;
    const it = { x: d[i] / 1000, y: d[i + 1] / 1000, v, L, cls };
    items.push(it);
    if (want !== 'all' && cls !== want) continue;
    shown.push(it);
    total += v; count += 1;
    const x = Math.floor((d[i] / 1000 + 75) / cs), y = Math.floor((d[i + 1] / 1000 + 35) / cs);
    const k = x * 100000 + y;
    const cur = out.get(k);
    if (cur) cur.v += v; else out.set(k, { x, y, v });
  }
  return { cells: { cs, ox: -75, oy: -35, list: [...out.values()], total }, total, count, note, period: lastP, items, shown, tally,
    legalNote: legal ? legalSummary(tally) : '' };
}

// ------------------------------------------------------------------ autorização (ANM) e áreas protegidas
// Cada detecção vem marcada pelo pipeline (legal.py): título na ANM e se cai em
// terra indígena ou unidade de conservação. "Sem autorização" = sem lavra autorizada
// na ANM, ou dentro de terra indígena ou UC de proteção integral (onde é proibido).
async function legalIndex() {
  if (state.legalIdx !== undefined) return state.legalIdx;
  const doc = await getJSON('mining/legal.json');
  if (!doc?.data?.length) { state.legalIdx = null; return null; }
  const m = new Map(), d = doc.data;
  for (let i = 0; i < d.length; i += 5) m.set(`${d[i]},${d[i + 1]}`, { t: d[i + 2], a: d[i + 3], n: doc.nomes[d[i + 4]] || '' });
  state.legalDoc = doc;
  state.legalIdx = m;
  $('#legal-opt').hidden = !state.on.mining;
  // sem os títulos da ANM só dá para dizer o que está em área protegida
  $('#legal').hidden = !doc.titulos_ok;
  $('#legal-label').textContent = doc.titulos_ok ? 'Autorização de lavra na ANM' : 'Garimpo em área protegida';
  if (!doc.titulos_ok) state.legal = 'all';
  return m;
}
// TI e UC de proteção integral contam como sem autorização mesmo com título na ANM (lá garimpo é proibido)
const legalClass = (L) => (!L ? null : L.a === 1 || L.a === 2 ? 'sem' : L.t < 0 ? null : L.t < 2 ? 'sem' : 'com');
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '0%');
function legalSummary(t) {
  if (!t.all) return '';
  if (!state.legalDoc?.titulos_ok) return `${pct(t.prot, t.all)} da área em terra indígena ou UC de proteção integral, onde garimpo é proibido.`;
  return `${pct(t.sem, t.all)} da área sem autorização de lavra na ANM${t.prot ? `, ${pct(t.prot, t.all)} em terra indígena ou UC de proteção integral` : ''}.`;
}

function legalPopup(p) {
  const r = state.results.mining;
  if (!state.legalIdx || !r?.items) return '';
  let sem = 0, com = 0, semTit = 0, pedido = 0;
  const areas = new Map();
  for (const it of r.shown) {
    if (!inBox(it.x, it.y, p) || !it.L) continue;
    if (it.L.n) areas.set(it.L.n, { v: (areas.get(it.L.n)?.v || 0) + it.v, a: it.L.a });
    if (!state.legalDoc.titulos_ok) continue;
    if (it.cls === 'com') com += it.v; else if (it.cls === 'sem') sem += it.v;
    if (it.L.t === 0) semTit += it.v;
    if (it.L.t === 1) pedido += it.v;
  }
  if (!sem && !com && !areas.size) return '';
  const tops = [...areas.entries()].sort((a, b) => b[1].v - a[1].v).slice(0, 2);
  return `<ul class="legal">
    ${sem ? `<li class="sem"><b>${haTxt(sem)}</b> sem lavra autorizada${semTit && pedido ? ` (${haTxt(semTit)} sem título na ANM, ${haTxt(pedido)} só com pedido ou pesquisa)` : semTit ? ', sem título na ANM' : pedido ? ', só com pedido ou pesquisa na ANM' : ''}</li>` : ''}
    ${com ? `<li class="com"><b>${haTxt(com)}</b> com lavra autorizada na ANM</li>` : ''}
    ${tops.map(([n, o]) => `<li class="area">${haTxt(o.v)} dentro de ${esc(nomeArea(n))}${o.a === 1 || o.a === 2 ? ', onde garimpo é proibido' : ''}</li>`).join('')}
  </ul>`;
}

function setLegal(v) {
  state.legal = v;
  $$('#legal button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.legal === v)));
  syncURL();
  render();
}

function periodLabel(p) {
  const y = Math.floor(p / 10), q = p % 10;
  return q ? `${q}º trimestre de ${y}` : `${y}`;
}

// ------------------------------------------------------------------ pistas de pouso sem registro
// Cada linha: lon, lat, lon1, lat1, lon2, lat2, comprimento, surgiu depois de, surgiu até, situação,
// último ano visto, fechada desde, km até garimpo, fontes, aberta por ano ("0"-"9" ou "-"), nome.
const A = { LON: 0, LAT: 1, X1: 2, Y1: 3, X2: 4, Y2: 5, LEN: 6, B0: 7, B1: 8, ST: 9, LAST: 10, SHUT: 11, KM: 12, SRC: 13, SER: 14, NAME: 15, CAT: 16, TI: 17, PRIO: 18, P: 19, CODE: 20 };
// registradas na ANAC: lon, lat, cabeceiras do OSM (ou null), pública, nome, código, município/UF
const R = { LON: 0, LAT: 1, X1: 2, Y1: 3, X2: 4, Y2: 5, PUB: 6, NAME: 7, CODE: 8, PLACE: 9, KM: 10 };
const regNear = (r) => !r[R.PUB] && r[R.KM] != null && r[R.KM] <= REG_NEAR_KM;   // privada; as públicas são aeroportos de cidade

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
  const allReg = doc.reg || [];
  const reg = state.mode === 'history' ? [] : allReg.filter((r) => types.has(regNear(r) ? 'regg' : 'reg'));
  const regNearN = allReg.filter(regNear).length;
  const born = state.mode === 'history' ? doc.data.filter((r) => r[A.B1] === y && !r[A.CAT] && !far(r)).length : 0;
  const note = state.mode === 'history'
    ? (y < first ? `antes de ${first}, só as datadas pela perda de floresta` : `situação em ${y}${born ? `; ${born} surgiram até ${y}` : ''}`)
    : `${used0} em uso no último ano com imagem boa`;
  return { total, list, by, note, cats, reg, used0, fora, regNear: regNearN, regTotal: allReg.length - regNearN };
}

function airFeatures(r) {
  const z = map.getZoom();
  const minHalf = (z < 6 ? 4 : z < 8 ? 5.5 : 7) / pxPerDeg(z);   // traço mínimo: ~8 px de longe, ~14 px de perto
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
  reg.setData({ type: 'FeatureCollection', features: r.reg.map((d, i) => ({ type: 'Feature', properties: { i, near: regNear(d) ? 1 : 0 },
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
    const n = k === 'reg' ? r.regTotal : k === 'regg' ? r.regNear : k === 'fora' ? r.fora : r.cats[k];
    const off = (k === 'reg' || k === 'regg') && hist;
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

const SRC_NAMES = [[1, 'OpenStreetMap'], [2, 'OurAirports'], [4, 'MapBiomas'], [8, 'detector do site'], [16, 'apontada por quem usa o site'], [32, 'busca do site em volta dos garimpos, conferida a olho']];

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
    ${r[A.CODE] ? `<p>Tem o código <b>${esc(r[A.CODE])}</b> no OpenStreetMap ou no OurAirports, mas não está no cadastro atual de aeródromos da ANAC (registro cancelado, vencido ou nunca feito).</p>` : ''}
    <p class="fine">${kind} Fonte da indicação: ${esc(srcs)}. Medida no Sentinel-2${r[A.P] != null ? `; nosso modelo dá ${Math.round(r[A.P] * 100)}% de chance de ser pista e não estrada ou rio` : ''}.</p>
    <button class="tl-open" data-kind="airstrip" data-lng="${r[A.LON]}" data-lat="${r[A.LAT]}">Ver a evolução por satélite</button>
    ${geoRow(r[A.LON], r[A.LAT])}
    ${reportLink('Não é pista', r[A.LON], r[A.LAT], 'O traço do mapa caiu numa estrada, rio, cava ou outra coisa que não é pista.',
      'Não é pista? Avise', [[r[A.X1], r[A.Y1]], [r[A.X2], r[A.Y2]]])}`;
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
    ${regNear(r) ? `<p>${r[R.KM] < 1 ? 'Colada a um garimpo' : `Garimpo mais perto a ${nf.format(r[R.KM])} km`}. O registro não impede que a pista sirva ao garimpo.</p>` : ''}
    <p class="fine">${r[R.X1] != null ? 'Traçado da pista: OpenStreetMap.' : 'Sem traçado da pista: só a posição do cadastro.'} Cadastro de aeródromos da ANAC, guardado no site.</p>
    <button class="tl-open" data-kind="airstrip" data-lng="${r[R.LON]}" data-lat="${r[R.LAT]}">Ver a evolução por satélite</button>
    ${geoRow(r[R.LON], r[R.LAT])}`;
  new maplibregl.Popup({ maxWidth: '280px' }).setLngLat(ll).setHTML(html).addTo(map);
}


// ------------------------------------------------------------------ desenho
const LOADERS = { deforestation: deforestationData, mining: miningData };

function drawLayer(l) {
  const r = state.results[l];
  const heat = map.getSource(`src-${l}-heat`), near = map.getSource(`src-${l}`);
  if (!heat) return;
  state.nearDrawn[l] = false;
  if (!r || state.mode === 'radar' || !state.on[l] || !(r.cells || r.shown)) { heat.setData(EMPTY); near.setData(EMPTY); return; }
  heat.setData({ type: 'FeatureCollection', features: heatPoints(r, l) });
  map.setPaintProperty(`heat-${l}`, 'heatmap-radius', heatRadius(l === 'mining' ? 0.0045 : r.cells.cs, HEAT_BASE[l]));
  map.setPaintProperty(`heat-${l}`, 'heatmap-intensity', heatIntensity(l, r));
  drawNear(l);
}
// a área real só é montada quando o mapa chega perto (são dezenas de milhares de quadros)
function drawNear(l) {
  const r = state.results[l];
  if (state.nearDrawn[l] || !r || map.getZoom() < NEAR[l] - 1.3) return;
  if (state.mode === 'radar' || !state.on[l] || !(r.cells || r.shown)) return;
  state.nearDrawn[l] = true;
  map.getSource(`src-${l}`).setData({ type: 'FeatureCollection', features: nearFeatures(r, l) });
}
function drawLegalShapes() {
  const show = state.on.mining && state.mode !== 'radar' && state.legalDoc?.titulos_ok;
  for (const id of ['areas-fill', 'areas-line', 'anm-fill', 'anm-lavra', 'anm-pedido']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', show ? 'visible' : 'none');
  }
  if (show) loadLegalShapes();
  $('#legal-zoom').hidden = map.getZoom() >= 7;
}

async function render() {
  const seq = ++state.renderSeq;
  $('#loading').hidden = false;
  if (state.mode === 'radar') {
    await renderRadar();
    if (seq !== state.renderSeq) return;
    LAYERS.forEach(drawLayer);
    drawLegalShapes();
    drawAir();
    ENF.draw();
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
    if (l === 'mining') {
      $('#legal-note').textContent = r.legalNote || '';
      if (state.legal !== 'all' && r.note) $('[data-note]', btn).textContent = `${r.note}, só ${state.legal === 'sem' ? 'sem' : 'com'} autorização`;
    }
  });
  drawLegalShapes();
  writeLede();
  $('#loading').hidden = true;
  drawCharts();
  ENF.draw();
}

// a frase que abre o painel resume o período em palavras
function writeLede() {
  const r = state.results, m = state.mode, on = state.on;
  const defo = `<b>${haTxt(r.deforestation?.total || 0)}</b> de floresta derrubada`;
  const aut = state.legalIdx && state.legal !== 'all' ? ` ${state.legal} autorização` : '';
  const mine = `<b>${haTxt(r.mining?.total || 0)}</b> de garimpo novo${aut}`;
  const both = on.deforestation && on.mining;
  let s;
  if (DAYS[m]) {
    const n = DAYS[m];
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
  if (!on.deforestation && !on.mining && !on.airstrips) s = on.enforcement ? ENF.lede() : 'Nenhuma camada ligada. Escolha abaixo o que mostrar.';
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
  for (const id of LAND_IDS) map.setLayoutProperty(id, 'visibility', 'none');
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
  for (const id of LAND_IDS) map.setLayoutProperty(id, 'visibility', 'visible');
  drawLegalShapes();
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
  if (mode !== 'radar') state.lastMode = mode;
  $$('#modes button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  $('#radar-go').setAttribute('aria-pressed', String(mode === 'radar'));
  $('#radar-go').textContent = mode === 'radar' ? 'Voltar ao monitoramento' : 'Abrir o radar';
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
  const ver = Object.keys(VER).filter((l) => state.on[l]);
  if (ver.length && (ver.length < 3 || state.on.enforcement)) q.set('ver', ver.map((l) => VER[l]).join(','));
  const tipos = [...state.airTypes].sort().join(',');
  if (tipos !== '0,regg') q.set('pistas', [...state.airTypes].sort().map((t) => (t === 'reg' ? 'anac' : t === 'regg' ? 'anac-garimpo' : t)).join(','));
  if (state.base !== 'sat') q.set('fundo', state.base);
  else if (state.mode !== 'history' && state.imgYear) q.set('imagem', state.imgYear);
  if (state.legal !== 'all') q.set('autorizacao', state.legal);
  const s = q.toString();
  history.replaceState(null, '', s ? `?${s}` : location.pathname);
}

// ------------------------------------------------------------------ imagem de satélite por ano
// Fora do Histórico, o visitante escolhe o ano da imagem. No Histórico, a imagem
// acompanha o ano escolhido na régua (o mosaico mais próximo que não seja posterior).
const IMG_SEQ = [...TL_YEARS, 'hoje'];

function currentImage() {
  if (state.base !== 'sat') return { key: state.base, note: '' };
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
  const vis = (id, on) => map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  vis('base-mapa', img.key === 'mapa');
  for (const id of ['base-relevo', 'base-relevo-hs', 'base-relevo-rotulos']) vis(id, img.key === 'relevo');
  vis('base-sat', img.key === 'hoje');
  $$('#basemap button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.base === state.base)));
  $('#sat-years').hidden = state.base !== 'sat';
  let note = img.note;
  if (state.base === 'sat' && state.mode !== 'history') note += ' Em "Tudo", a imagem muda junto com o ano da régua.';
  $('#base-note').textContent = note;
  $$('#imgs button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.img === String(img.key)));
    const why = state.badYears.get(+b.dataset.img);
    b.disabled = !!why;
    b.title = why ? `Imagem ruim nesta área (${why})` : '';
  });
  $('#img-badge').hidden = state.base !== 'sat' || !!state.tl;
  $('#img-year').textContent = s2 ? img.key : 'Hoje';
  $('#img-src').textContent = s2 ? 'Sentinel-2' : 'Esri';
  const seq = IMG_SEQ.filter((k) => !state.badYears.has(k));
  const i = seq.indexOf(img.key);
  $('#img-prev').disabled = i <= 0;
  $('#img-next').disabled = i >= seq.length - 1;
}

function setBase(b) {
  if (state.base === b) return;
  state.base = b;
  updateBase();
  applyPaint();
  ENF.paint();
  syncURL();
}

function pickImage(key) {
  const wasSat = state.base === 'sat';
  {
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
  if (!wasSat) { applyPaint(); ENF.paint(); }
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
  for (const k of [...IMG_SEQ].reverse()) {
    const b = document.createElement('button');
    b.dataset.img = String(k);
    b.textContent = k === 'hoje' ? 'Hoje' : String(k);
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
const VER = { deforestation: 'desmatamento', mining: 'garimpo', airstrips: 'pistas', enforcement: 'fiscalizacao' };

function layersChanged() {
  $$('#show button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.show === showValue())));
  $$('.layer[data-layer]').forEach((b) => b.setAttribute('aria-pressed', String(state.on[b.dataset.layer])));
  $('#legal-opt').hidden = !state.on.mining || !state.legalIdx;
  LAYERS.forEach(drawLayer);
  drawAir();
  drawAirKey();
  if (state.mode !== 'radar') writeLede();
  $$('#charts .chart').forEach((c) => { c.hidden = !state.on[c.dataset.layer]; });
  const [a] = yearBounds();
  if (state.mode === 'history' && state.year < a) { stopPlay(); setYear(a); }
  else { syncYearUI(); syncURL(); }
  if (state.tl) tlShow(state.tl.i);
  ENF.draw();
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
  $('#radar-go').addEventListener('click', () => setMode(state.mode === 'radar' ? state.lastMode || 'week' : 'radar'));
  $$('#basemap button').forEach((b) => b.addEventListener('click', () => setBase(b.dataset.base)));
  $$('#show button').forEach((b) => b.addEventListener('click', () => setShow(b.dataset.show)));
  $$('#legal button').forEach((b) => b.addEventListener('click', () => setLegal(b.dataset.legal)));
  $$('.layer[data-layer]').forEach((btn) => btn.addEventListener('click', () => {
    const l = btn.dataset.layer;
    state.on[l] = !state.on[l];
    layersChanged();
  }));
  $('#air-types').addEventListener('click', (e) => { const b = e.target.closest('button[data-type]'); if (b && !b.disabled) toggleAirType(b.dataset.type); });
  $('#img-prev').addEventListener('click', () => stepImage(-1));
  $('#img-next').addEventListener('click', () => stepImage(1));
  $$('button[data-radar]').forEach((btn) => btn.addEventListener('click', () => {
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
  // a área real de cada camada só é montada quando o mapa chega perto
  map.on('moveend', checkCenterQuality);
  map.on('zoomend', () => {
    LAYERS.forEach(drawNear);
    $('#legal-zoom').hidden = map.getZoom() >= 7;
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
  const tipos = (q.get('pistas') || '').split(',').map((t) => (t === 'anac' ? 'reg' : t === 'anac-garimpo' ? 'regg' : t)).filter((t) => AIR_TYPES.some(([k]) => k === t));
  if (tipos.length) state.airTypes = new Set(tipos);
  const evo = (q.get('evolucao') || '').split(',').map(Number);
  if (evo.length === 2 && evo.every(Number.isFinite)) setTimeout(() => openTimelapse(evo[0], evo[1]), 300);
  const aut = q.get('autorizacao');
  if (aut === 'sem' || aut === 'com') {
    state.legal = aut;
    $$('#legal button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.legal === aut)));
  }
  const fundo = q.get('fundo'), imagem = +q.get('imagem');
  if (fundo === 'mapa' || fundo === 'relevo') setBase(fundo);
  else if (fundo === 'dark') setBase('mapa');
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
