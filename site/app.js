/* AMAZON SENTRY — mapa interativo de ameaças ambientais no Brasil.
 * Sem build: MapLibre GL (vendor/) + JSON gerado pelo pipeline em data/.
 */
'use strict';

const DATA = 'data/';
const DAY_MS = 86400000;
const NOW_YEAR = new Date().getUTCFullYear();
const FIRST_YEAR = 1985;
const LAYERS = ['deforestation', 'fires', 'mining'];          // ordem de desenho (garimpo por cima)
const COLORS = { fires: '#ff5a1f', deforestation: '#e8368f', mining: '#f5c518' };
const NAMES = { fires: 'Queimadas', deforestation: 'Desmatamento', mining: 'Garimpo' };
const EOX_YEARS = { 2016: 's2cloudless_3857', 2018: 's2cloudless-2018_3857', 2019: 's2cloudless-2019_3857',
  2020: 's2cloudless-2020_3857', 2021: 's2cloudless-2021_3857', 2022: 's2cloudless-2022_3857',
  2023: 's2cloudless-2023_3857', 2024: 's2cloudless-2024_3857' };
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

const state = {
  mode: 'live', year: NOW_YEAR, cumulative: false, base: 'dark',
  on: { fires: true, deforestation: true, mining: true },
  manifest: {}, stats: {}, playing: null, renderSeq: 0,
};

// ------------------------------------------------------------------ utilidades
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const fmt = new Intl.NumberFormat('pt-BR');
const fmtInt = (v) => fmt.format(Math.round(v));
const dayOf = (y, m = 1, d = 1) => Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
const dateOfDay = (n) => new Date(n * DAY_MS);
const fmtDay = (n) => { const d = dateOfDay(n); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const fmtMin = (m) => new Date(m * 60000).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const ha = (v) => v >= 1000 ? `${fmtInt(v)} ha` : `${fmt.format(Math.round(v * 10) / 10)} ha`;

const cache = new Map();
function getJSON(path) {
  if (!cache.has(path)) {
    cache.set(path, fetch(DATA + path, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null));
  }
  return cache.get(path);
}

// período de uma célula -> [início, fim) em dias desde 1970
function periodOf(unit, t) {
  if (unit === 'day') return [t, t + 1];
  if (unit === 'month') { const y = Math.floor(t / 100), m = t % 100; return [dayOf(y, m), m === 12 ? dayOf(y + 1) : dayOf(y, m + 1)]; }
  if (unit === 'year') return [dayOf(t), dayOf(t + 1)];
  if (unit === 'period') { const y = Math.floor(t / 10), q = t % 10; return q ? [dayOf(y, q * 3 - 2), q === 4 ? dayOf(y + 1) : dayOf(y, q * 3 + 1)] : [dayOf(y), dayOf(y + 1)]; }
  return [t, t + 1];
}

/** Agrega um arquivo "cells" dentro de [a, b) (dias). Retorna {features, total}. */
function cellsInWindow(doc, layer, a, b) {
  const out = new Map();
  if (!doc || !doc.data) return { features: [], total: 0 };
  const d = doc.data, cs = doc.cell, ox = doc.origin[0], oy = doc.origin[1];
  let total = 0;
  for (let i = 0; i < d.length; i += 4) {
    const [s] = periodOf(doc.time, d[i + 2]);
    if (s < a || s >= b) continue;
    const k = d[i] * 100000 + d[i + 1];
    const v = d[i + 3];
    total += v;
    const cur = out.get(k);
    if (cur) cur.v += v; else out.set(k, { x: d[i], y: d[i + 1], v });
  }
  const vals = [...out.values()];
  const ref = percentile(vals.map((c) => c.v), 0.97) || 1;
  const features = vals.map((c) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [ox + (c.x + 0.5) * cs, oy + (c.y + 0.5) * cs] },
    properties: { layer, v: c.v, w: Math.min(1, c.v / ref), cs, unit: doc.value },
  }));
  return { features, total };
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = Float64Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

// ------------------------------------------------------------------ mapa
const RASTER = (tiles, attribution, maxzoom = 19) => ({ type: 'raster', tiles, tileSize: 256, attribution, maxzoom });
const map = new maplibregl.Map({
  container: 'map',
  center: [-54, -12], zoom: 3.6, minZoom: 2.5, maxZoom: 16,
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
      estados: { type: 'geojson', data: DATA + 'base/estados.geojson' },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#0e1116' } },
      { id: 'base-dark', type: 'raster', source: 'dark' },
      { id: 'base-sat', type: 'raster', source: 'sat', layout: { visibility: 'none' } },
      { id: 'base-s2', type: 'raster', source: 's2', layout: { visibility: 'none' } },
      { id: 'brasil-fill', type: 'fill', source: 'brasil', paint: { 'fill-color': '#3ddc97', 'fill-opacity': 0.03 } },
      { id: 'estados-line', type: 'line', source: 'estados', paint: { 'line-color': '#7b8794', 'line-width': 0.5, 'line-opacity': 0.6 } },
      { id: 'brasil-line', type: 'line', source: 'brasil', paint: { 'line-color': '#3ddc97', 'line-width': 1.2, 'line-opacity': 0.8 } },
    ],
  },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

function eoxUrl(year) {
  return `https://tiles.maps.eox.at/wmts/1.0.0/${EOX_YEARS[year]}/default/g/{z}/{y}/{x}.jpg`;
}

// raio do círculo = metade da célula em pixels, modulado pelo valor
function cellRadius() {
  const stops = [];
  for (const z of [2, 4, 6, 8, 10, 12, 14]) {
    const px = (256 * 2 ** z) / 360;
    stops.push(z, ['case', ['==', ['get', 'cs'], 0],
      z < 6 ? 1.6 : z < 9 ? 2.6 : 4,
      ['max', 1.3, ['*', ['get', 'cs'], px * 0.62, ['+', 0.35, ['*', 0.65, ['sqrt', ['get', 'w']]]]]]]);
  }
  return ['interpolate', ['exponential', 2], ['zoom'], ...stops];
}

function addDataLayers() {
  for (const l of LAYERS) {
    map.addSource(`src-${l}`, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    const color = l === 'fires'
      ? ['case', ['has', 'age'], ['interpolate', ['linear'], ['get', 'age'], 0, '#fff3b0', 0.25, '#ffb020', 1, '#d62a0a'], COLORS.fires]
      : COLORS[l];
    map.addLayer({
      id: `lyr-${l}`, type: 'circle', source: `src-${l}`,
      paint: {
        'circle-color': color,
        'circle-radius': cellRadius(),
        'circle-opacity': ['case', ['==', ['get', 'cs'], 0], 0.9, ['+', 0.35, ['*', 0.6, ['get', 'w']]]],
        'circle-blur': ['case', ['==', ['get', 'cs'], 0], 0.15, 0.35],
        'circle-stroke-width': l === 'mining' ? 0.8 : 0,
        'circle-stroke-color': '#000',
      },
    });
    map.on('click', `lyr-${l}`, (e) => popup(e));
    map.on('mouseenter', `lyr-${l}`, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', `lyr-${l}`, () => { map.getCanvas().style.cursor = ''; });
  }
}

function popup(e) {
  const p = e.features[0].properties;
  let html = `<b style="color:${COLORS[p.layer]}">${NAMES[p.layer]}</b><br>`;
  if (p.layer === 'fires') {
    html += p.when ? `Foco detectado em ${p.when}<br>${p.sensor || ''}${p.frp ? ` · ${p.frp} MW` : ''}` : `${fmtInt(p.v)} focos nesta área`;
  } else if (p.layer === 'mining') {
    html += `Área de garimpo: ${ha(p.v)}<br>Início: ${p.when}${p.status === 0 ? ' (provisório)' : ''}`;
  } else {
    html += `${ha(p.v)} de floresta perdida nesta área`;
  }
  html += `<br><small>${p.period || $('#window-label').textContent}</small>`;
  new maplibregl.Popup({ closeButton: true, maxWidth: '260px' }).setLngLat(e.lngLat).setHTML(html).addTo(map);
}

// ------------------------------------------------------------------ dados por camada / modo
async function firesData() {
  const m = state.mode;
  if (m === 'live' || m === 'week') {
    const doc = await getJSON('fires/live.json');
    if (!doc || !doc.data?.length) return { features: [], total: 0, note: 'sem dados' };
    const span = m === 'live' ? 24 * 60 : 7 * 24 * 60;
    const last = doc.last_minutes, from = last - span, d = doc.data;
    const feats = [];
    const sensors = ['VIIRS NOAA-20', 'VIIRS NOAA-21', 'VIIRS S-NPP', 'MODIS'];
    for (let i = 0; i < d.length; i += 6) {
      const t = doc.t0_minutes + d[i + 2];
      if (t < from) continue;
      feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [d[i] / 1000, d[i + 1] / 1000] },
        properties: { layer: 'fires', v: 1, w: 1, cs: 0, age: (last - t) / span, frp: d[i + 3], sensor: sensors[d[i + 4]], when: fmtMin(t) } });
    }
    return { features: feats, total: feats.length, unit: 'detecções', note: `todos os satélites · até ${fmtMin(last)}` };
  }
  if (m === 'month') {
    const doc = await getJSON('fires/recent.json');
    if (!doc || doc.last_day == null) return { features: [], total: 0, note: 'sem dados' };
    const r = cellsInWindow(doc, 'fires', doc.last_day - 29, doc.last_day + 1);
    return { ...r, unit: 'focos', note: `VIIRS NOAA-20 · até ${fmtDay(doc.last_day)}` };
  }
  const y = state.year;
  const years = state.manifest.layers?.fires?.years || [];
  if (!years.includes(y)) return { features: [], total: 0, note: `sem dados de ${y} (série começa em 2000)` };
  const doc = await getJSON(`fires/${y}.json`);
  const r = cellsInWindow(doc, 'fires', dayOf(y), dayOf(y + 1));
  return { ...r, unit: 'focos', note: `${doc?.source?.replace('NASA FIRMS ', '') || ''}${doc?.partial ? ' · ano em curso' : ''}` };
}

async function deforestationData() {
  const m = state.mode;
  const man = state.manifest.layers?.deforestation || {};
  if (m === 'live' || m === 'week' || m === 'month') {
    const doc = await getJSON('deforestation/alerts/recent.json');
    if (!doc || doc.last_day == null) return { features: [], total: 0, note: 'sem dados' };
    const days = m === 'month' ? 30 : 7;
    const r = cellsInWindow(doc, 'deforestation', doc.last_day - days + 1, doc.last_day + 1);
    return { ...r, unit: 'ha', note: `alertas GLAD-L · ${days} dias até ${fmtDay(doc.last_day)}` };
  }
  const y = state.year;
  if (m === 'history' && state.cumulative) {
    const doc = await getJSON('deforestation/loss/summary.json');
    if (!doc) return { features: [], total: 0, note: 'sem dados' };
    const r = cellsInWindow(doc, 'deforestation', dayOf(2001), dayOf(y + 1));
    return { ...r, unit: 'ha', note: `perda acumulada 2001–${Math.min(y, Math.max(...(man.loss_years || [y])))} (Hansen)` };
  }
  if (m === 'history' && (man.loss_years || []).includes(y)) {
    const doc = await getJSON(`deforestation/loss/${y}.json`);
    const r = cellsInWindow(doc, 'deforestation', dayOf(y), dayOf(y + 1));
    return { ...r, unit: 'ha', note: 'perda anual de floresta (Hansen/UMD)' };
  }
  if ((man.alert_years || []).includes(y)) {
    const doc = await getJSON(`deforestation/alerts/${y}.json`);
    const r = cellsInWindow(doc, 'deforestation', dayOf(y), dayOf(y + 1));
    return { ...r, unit: 'ha', note: `alertas GLAD-L${y === NOW_YEAR ? ' · ano em curso' : ''}` };
  }
  return { features: [], total: 0, note: `sem dados de ${y} (série começa em 2001)` };
}

async function miningData() {
  const doc = await getJSON('mining/detections.json');
  if (!doc || !doc.data?.length) return { features: [], total: 0, note: 'sem dados' };
  const d = doc.data;
  const periods = doc.periods || [];
  const lastP = Math.max(...periods);
  let keep, note;
  const m = state.mode;
  if (m === 'live' || m === 'week' || m === 'month') {
    keep = (p) => p === lastP;
    note = `detecções mais recentes (${periodLabel(lastP)})`;
  } else {
    const y = state.year;
    const cum = m === 'history' && state.cumulative;
    keep = cum ? (p) => Math.floor(p / 10) <= y : (p) => Math.floor(p / 10) === y;
    note = cum ? `acumulado 2018–${y}` : `início confirmado em ${y}`;
    if (y < 2018) note = 'monitoramento começa em 2018';
  }
  const feats = [];
  let total = 0;
  for (let i = 0; i < d.length; i += 5) {
    const p = d[i + 2];
    if (!keep(p)) continue;
    total += d[i + 4];
    feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [d[i] / 1000, d[i + 1] / 1000] },
      properties: { layer: 'mining', v: d[i + 4], w: Math.min(1, d[i + 4] / 40), cs: 0.02, status: d[i + 3], when: periodLabel(p) } });
  }
  return { features: feats, total, unit: 'ha', count: feats.length, note };
}

function periodLabel(p) {
  const y = Math.floor(p / 10), q = p % 10;
  return q ? `${q}º tri ${y}` : `${y}`;
}

const LOADERS = { fires: firesData, deforestation: deforestationData, mining: miningData };

// ------------------------------------------------------------------ render
async function render() {
  const seq = ++state.renderSeq;
  $('#loading').hidden = false;
  updateWindowLabel();
  const results = await Promise.all(LAYERS.map((l) => (state.on[l] ? LOADERS[l]() : Promise.resolve(null))));
  if (seq !== state.renderSeq) return; // um render mais novo já começou
  LAYERS.forEach((l, i) => {
    const r = results[i];
    const src = map.getSource(`src-${l}`);
    if (src) src.setData({ type: 'FeatureCollection', features: r ? r.features : [] });
    const li = $(`#layers li[data-layer="${l}"]`);
    if (!r) { $('[data-total]', li).textContent = '–'; $('[data-note]', li).textContent = 'oculto'; return; }
    let txt;
    if (l === 'fires') txt = `${fmtInt(r.total)} ${r.unit || 'focos'}`;
    else if (l === 'mining') txt = `${fmtInt(r.count || 0)} áreas · ${ha(r.total)}`;
    else txt = ha(r.total);
    $('[data-total]', li).textContent = r.features.length || r.total ? txt : '0';
    $('[data-note]', li).textContent = r.note || '';
  });
  $('#loading').hidden = true;
  drawCharts();
}

function updateWindowLabel() {
  const labels = {
    live: 'Últimas 24 horas de focos; alertas de desmatamento dos últimos 7 dias publicados.',
    week: 'Últimos 7 dias.',
    month: 'Últimos 30 dias.',
    year: `Ano de ${NOW_YEAR} até hoje.`,
    history: `Ano de ${state.year}${state.cumulative ? ' (acumulado)' : ''}.`,
  };
  $('#window-label').textContent = labels[state.mode];
}

// ------------------------------------------------------------------ gráficos anuais
function chartSeries() {
  const s = state.stats || {};
  const fires = {};
  const viirs = s.fires?.focos_viirs || {}, modis = s.fires?.focos_modis || {};
  for (const [y, v] of Object.entries(modis)) fires[y] = { v, alt: false };
  for (const [y, v] of Object.entries(viirs)) if (+y >= 2012) fires[y] = { v, alt: false };
  const defo = {};
  for (const [y, v] of Object.entries(s.deforestation?.alertas_glad_ha || {})) defo[y] = { v, alt: true };
  for (const [y, v] of Object.entries(s.deforestation?.perda_hansen_ha || {})) defo[y] = { v, alt: false };
  const mine = {};
  for (const [y, v] of Object.entries(s.mining?.area_nova_ha || {})) mine[y] = { v, alt: false };
  return [
    ['fires', fires, 'focos (MODIS até 2011, VIIRS depois)'],
    ['deforestation', defo, 'ha perdidos (Hansen; claro = alertas GLAD)'],
    ['mining', mine, 'ha de garimpo novo'],
  ];
}

function drawCharts() {
  const box = $('#charts');
  const years = [];
  for (let y = FIRST_YEAR; y <= NOW_YEAR; y++) years.push(y);
  const W = 288, H = 38, bw = W / years.length;
  box.innerHTML = '';
  for (const [l, series, caption] of chartSeries()) {
    const max = Math.max(1, ...Object.values(series).map((o) => o.v));
    const cur = series[state.year];
    const div = document.createElement('div');
    div.className = 'chart';
    div.innerHTML = `<div class="ttl"><span>${NAMES[l]} · ${caption}</span><span>${state.mode === 'history' || state.mode === 'year' ? (cur ? fmtInt(cur.v) : '–') : ''}</span></div>`;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    years.forEach((y, i) => {
      const o = series[y];
      const h = o ? Math.max(1, (o.v / max) * (H - 2)) : 1;
      const r = document.createElementNS(NS, 'rect');
      r.setAttribute('x', i * bw + 0.4);
      r.setAttribute('width', Math.max(1, bw - 0.8));
      r.setAttribute('y', H - h);
      r.setAttribute('height', h);
      r.setAttribute('fill', o ? COLORS[l] : '#2a313c');
      r.setAttribute('opacity', o ? (o.alt ? 0.45 : 0.9) : 0.6);
      if (y === state.year && (state.mode === 'history' || state.mode === 'year')) r.classList.add('sel');
      const t = document.createElementNS(NS, 'title');
      t.textContent = `${y}: ${o ? fmtInt(o.v) : 'sem dados'}`;
      r.appendChild(t);
      r.addEventListener('click', () => { setMode('history'); setYear(y); });
      svg.appendChild(r);
    });
    div.appendChild(svg);
    box.appendChild(div);
  }
}

// ------------------------------------------------------------------ controles
function setMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  if (mode === 'year') state.year = NOW_YEAR;
  $$('#modes button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  $('#timeline').hidden = mode !== 'history';
  $('#cumulative-opt').hidden = mode !== 'history';
  if (mode !== 'history') stopPlay();
  syncYearUI();
  updateBase();
  render();
}

function setYear(y) {
  state.year = y;
  syncYearUI();
  updateBase();
  render();
}

function syncYearUI() {
  $('#year').value = state.year;
  $('#year-label').textContent = state.year;
}

function setBase(b) {
  state.base = b;
  $$('#basemaps button').forEach((x) => x.classList.toggle('on', x.dataset.base === b));
  updateBase();
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
      note = `Mosaico Sentinel-2 de ${pick}${pick !== y ? ` (mais próximo de ${y})` : ''}.`;
      showS2 = true;
    } else {
      note = `Sem mosaico de imagem para ${y}. Imagens Landsat desde 1985 entram com o Google Earth Engine (próxima etapa).`;
    }
  }
  map.setLayoutProperty('base-dark', 'visibility', b === 'dark' ? 'visible' : 'none');
  map.setLayoutProperty('base-sat', 'visibility', b === 'sat' || (b === 's2' && !showS2) ? 'visible' : 'none');
  map.setLayoutProperty('base-s2', 'visibility', showS2 ? 'visible' : 'none');
  $('#base-note').textContent = note;
}

function firstDataYear() {
  const L = state.manifest.layers || {};
  const ys = [...(L.fires?.years || []), ...(L.deforestation?.loss_years || []), ...(L.deforestation?.alert_years || []), ...(L.mining?.years || [])];
  return ys.length ? Math.min(...ys) : 2001;
}

function play() {
  if (state.playing) return stopPlay();
  $('#play').textContent = '❚❚';
  let y = state.year >= NOW_YEAR ? firstDataYear() : state.year;
  setYear(y);
  state.playing = setInterval(() => {
    y += 1;
    if (y > NOW_YEAR) return stopPlay();
    setYear(y);
  }, 1400);
}
function stopPlay() {
  clearInterval(state.playing);
  state.playing = null;
  $('#play').textContent = '▶';
}

function bind() {
  $$('#modes button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $$('#basemaps button').forEach((b) => b.addEventListener('click', () => setBase(b.dataset.base)));
  $$('#layers li').forEach((li) => {
    const l = li.dataset.layer;
    $('input', li).addEventListener('change', (e) => {
      state.on[l] = e.target.checked;
      map.setLayoutProperty(`lyr-${l}`, 'visibility', e.target.checked ? 'visible' : 'none');
      render();
    });
  });
  $('#cumulative').addEventListener('change', (e) => { state.cumulative = e.target.checked; render(); });
  const yr = $('#year');
  yr.min = FIRST_YEAR; yr.max = NOW_YEAR;
  yr.addEventListener('input', () => { $('#year-label').textContent = yr.value; });
  yr.addEventListener('change', () => setYear(+yr.value));
  $('#play').addEventListener('click', play);
  // parâmetros na URL: ?modo=history&ano=2019
  const q = new URLSearchParams(location.search);
  const modo = q.get('modo');
  if (q.get('ano')) state.year = Math.min(NOW_YEAR, Math.max(FIRST_YEAR, +q.get('ano')));
  if (modo && ['live', 'week', 'month', 'year', 'history'].includes(modo)) {
    state.mode = '';
    setMode(modo);
    return true;
  }
  return false;
}

async function init() {
  const [manifest, stats] = await Promise.all([getJSON('manifest.json'), getJSON('stats.json')]);
  state.manifest = manifest || {};
  state.stats = stats || {};
  const L = state.manifest.layers || {};
  const upd = [L.fires?.live_updated && `focos ${fmtIso(L.fires.live_updated)}`,
    L.deforestation?.alerts_updated && `alertas ${fmtIso(L.deforestation.alerts_updated)}`,
    L.mining?.updated && `garimpo ${fmtIso(L.mining.updated)}`].filter(Boolean);
  $('#updated').textContent = upd.length ? `Atualizado: ${upd.join(' · ')}` : 'Ainda sem dados publicados: rode os workflows de dados.';
  addDataLayers();
  if (!bind()) render();
}

function fmtIso(s) {
  return new Date(s).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// 'style.load' (e não 'load'): o mapa funciona mesmo se o fundo externo estiver fora do ar
let started = false;
const start = () => { if (!started) { started = true; init(); } };
map.once('style.load', start);
map.once('load', start);
