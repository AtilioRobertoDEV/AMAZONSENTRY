/* Fiscalização: onde o Ibama autuou ou embargou, como mancha de calor, e o garimpo novo que ficou longe disso.
 * Módulo à parte do app.js: usa map, state, $, $$, fmtInt, getJSON e MONTHS de lá, e é chamado por ENF.draw().
 * Dados: data/enforcement/{heat,monthly,gaps}.json (pipeline/enforcement.py).
 */
'use strict';

const ENF = (() => {
  const BRASA = '#e2552b', TINTA = '#9c2f12', GAP = '#fff1de';
  const NS = 'http://www.w3.org/2000/svg';
  let heat = null, monthly = null, gaps = null, loading = null, ready = false;

  const load = () => loading || (loading = Promise.all([
    getJSON('enforcement/heat.json'), getJSON('enforcement/monthly.json'), getJSON('enforcement/gaps.json'),
  ]).then(([h, m, g]) => { heat = h; monthly = m; gaps = g; }));

  const ymTxt = (t) => `${MONTHS[t % 100 - 1]}/${Math.floor(t / 100)}`;
  const addMonths = (t, n) => { const k = Math.floor(t / 100) * 12 + (t % 100 - 1) + n; return Math.floor(k / 12) * 100 + (k % 12) + 1; };

  // período mostrado, conforme o modo do painel
  function period() {
    const last = monthly?.months?.at(-1);
    if (!last) return null;
    if (state.mode === 'history') {
      const y = state.year, a = y * 100 + 1, b = Math.min(y * 100 + 12, last);
      return a > last ? null : { a, b, txt: `em ${y}` };
    }
    if (state.mode === 'year') {
      const y = Math.floor(last / 100);
      return { a: y * 100 + 1, b: last, txt: `em ${y}, até ${ymTxt(last)}` };
    }
    return { a: addMonths(last, -11), b: last, txt: `de ${ymTxt(addMonths(last, -11))} a ${ymTxt(last)}` };
  }

  function setup() {
    if (ready) return;
    ready = true;
    const EMPTY = { type: 'FeatureCollection', features: [] };
    map.addSource('src-enf', { type: 'geojson', data: EMPTY });
    map.addSource('src-enf-gap', { type: 'geojson', data: EMPTY });
    const below = map.getLayer('lyr-deforestation') ? 'lyr-deforestation' : undefined;
    map.addLayer({ id: 'enf-heat', type: 'heatmap', source: 'src-enf', paint: {
      'heatmap-weight': ['interpolate', ['linear'], ['get', 'n'], 0, 0, 1, 0.08, 10, 0.35, 60, 1],
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 3, 0.7, 8, 1.6],
      'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 3, 8, 6, 22, 9, 60],
      'heatmap-opacity': 0.9,
      'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'],
        0, 'rgba(156,47,18,0)', 0.12, 'rgba(156,47,18,.55)', 0.35, BRASA, 0.65, '#ffb27a', 1, '#fff1de'],
    } }, below);
    map.addLayer({ id: 'enf-gap', type: 'circle', source: 'src-enf-gap', paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, ['interpolate', ['linear'], ['get', 'ha'], 20, 4, 3000, 10],
        8, ['interpolate', ['linear'], ['get', 'ha'], 20, 14, 3000, 34]],
      'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': GAP, 'circle-stroke-width': 1.6, 'circle-stroke-opacity': 0.95,
    } });
    map.on('mouseenter', 'enf-gap', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'enf-gap', () => { map.getCanvas().style.cursor = ''; });
    map.on('click', 'enf-gap', (e) => {
      const p = e.features[0].properties;
      new maplibregl.Popup({ maxWidth: '280px' }).setLngLat(e.lngLat).setHTML(
        `<h3>Garimpo sem fiscalização por perto</h3><p><b>${fmtInt(p.ha)} ha</b> de garimpo novo desde ${ymTxt(gaps.since)} ` +
        `neste quadro de ~11 km, e nenhum auto de infração ou embargo do Ibama a até ~10 km no mesmo período.</p>` +
        '<p class="fine">Não inclui operações da Polícia Federal, das Forças Armadas nem dos estados.</p>').addTo(map);
    });
  }

  function features(p) {
    const cs = heat.cell, [ox, oy] = heat.origin, d = heat.data, n = heat.fields.length, acc = new Map();
    let autos = 0, emb = 0;
    for (let i = 0; i < d.length; i += n) {
      const t = d[i + 2];
      if (t < p.a || t > p.b) continue;
      const k = d[i] * 100000 + d[i + 1];
      acc.set(k, (acc.get(k) || 0) + d[i + 3] + d[i + 4]);
      autos += d[i + 3]; emb += d[i + 4];
    }
    const feats = [];
    for (const [k, v] of acc) {
      const x = Math.floor(k / 100000), y = k % 100000;
      feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [ox + (x + 0.5) * cs, oy + (y + 0.5) * cs] }, properties: { n: v } });
    }
    return { feats, autos, emb };
  }

  function gapFeatures() {
    if (!gaps || state.mode === 'history') return [];
    const cs = gaps.cell, [ox, oy] = gaps.origin, d = gaps.data, out = [];
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 0) continue;
      out.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [ox + (d[i] + 0.5) * cs, oy + (d[i + 1] + 0.5) * cs] }, properties: { ha: d[i + 2] } });
    }
    return out;
  }

  // ---------------------------------------------------------------- painel
  const svgEl = (tag, attrs, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  };
  const sumUF = (k, i) => Object.values(monthly.uf).reduce((s, u) => s + u[k][i], 0);

  function barChart(svg, values, months, color, opt = {}) {
    svg.replaceChildren();
    const W = +svg.getAttribute('width'), H = +svg.getAttribute('height'), pb = 16, pt = 6;
    const max = Math.max(...values, 1), bw = W / values.length;
    const y = (v) => H - pb - (v / max) * (H - pb - pt);
    values.forEach((v, i) => {
      if (v <= 0) return;
      svgEl('rect', { x: i * bw + 0.4, y: y(v), width: Math.max(bw - 1.2, 0.8), height: H - pb - y(v),
        fill: opt.hi && opt.hi(months[i]) ? color : opt.dim || color }, svg);
    });
    months.forEach((t, i) => { if (t % 100 === 1) svgEl('text', { x: i * bw, y: H - 3 }, svg).textContent = Math.floor(t / 100); });
    if (opt.label) svgEl('text', { x: W, y: 10, 'text-anchor': 'end' }, svg).textContent = opt.label(max);
  }

  function panel(p) {
    const box = $('#enf-panel');
    if (!box || !monthly) return;
    const i0 = Math.max(0, monthly.months.indexOf(202301)), months = monthly.months.slice(i0);
    const inP = (t) => p && t >= p.a && t <= p.b;
    if (gaps) {
      $('#enf-far').textContent = `${Math.round(gaps.far_share * 100)}%`;
      $('#enf-far-txt').textContent = `da área de garimpo aberta desde ${ymTxt(gaps.since)} fica a mais de 10 km de qualquer auto de infração ou embargo do Ibama no mesmo período.`;
    }
    $('#enf-gapstat').hidden = !gaps;
    barChart($('#enf-monthly'), months.map((_, i) => sumUF('autos', i0 + i) + sumUF('embargos', i0 + i)), months, TINTA,
      { hi: inP, dim: '#b8996a', label: (m) => `máx. ${fmtInt(m)} por mês` });
    const rows = Object.entries(monthly.uf).map(([uf, u]) => {
      let v = 0;
      monthly.months.forEach((t, i) => { if (inP(t)) v += u.autos[i] + u.embargos[i]; });
      return [uf, v];
    }).sort((a, b) => b[1] - a[1]);
    const top = rows[0]?.[1] || 1;
    $('#enf-ufs').innerHTML = rows.map(([uf, v]) =>
      `<li><b>${uf}</b><i style="width:${Math.max(2, (v / top) * 100)}%"></i><span>${fmtInt(v)}</span></li>`).join('');
    const sp = monthly.spend?.ibama?.fisc_empenhado;
    const spend = sp ? sp.slice(i0).map((v) => v / 1e6) : [];
    const lastSp = spend.findLastIndex((v) => v !== 0);
    $('#enf-spend-box').hidden = lastSp < 0;
    if (lastSp >= 0) {
      barChart($('#enf-spend'), spend, months, TINTA, { label: (m) => `máx. R$ ${fmtInt(m)} mi` });
      $('#enf-spend-note').textContent = `Empenho da ação "Controle e fiscalização ambiental", de jan/2023 a ${ymTxt(months[lastSp])}. O Portal da Transparência ainda não libera para download automático os meses seguintes.`;
    }
  }

  // ---------------------------------------------------------------- desenho
  async function draw() {
    const btn = $('.layer[data-layer="enforcement"]');
    const on = state.on.enforcement && state.mode !== 'radar';
    $('#enf-panel').hidden = !on;
    if (!on && !ready) return;
    setup();
    if (!on) {
      for (const id of ['enf-heat', 'enf-gap']) map.setLayoutProperty(id, 'visibility', 'none');
      return;
    }
    await load();
    if (!heat || !monthly) {
      $('[data-note]', btn).textContent = 'dados ainda não publicados';
      return;
    }
    const p = period();
    const f = p ? features(p) : { feats: [], autos: 0, emb: 0 };
    map.getSource('src-enf').setData({ type: 'FeatureCollection', features: f.feats });
    map.getSource('src-enf-gap').setData({ type: 'FeatureCollection', features: gapFeatures() });
    for (const id of ['enf-heat', 'enf-gap']) map.setLayoutProperty(id, 'visibility', 'visible');
    $('[data-total]', btn).innerHTML = `${fmtInt(f.autos + f.emb)}<small>ações</small>`;
    $('[data-note]', btn).textContent = p ? `${fmtInt(f.autos)} autos de infração e ${fmtInt(f.emb)} embargos, ${p.txt}` : 'sem dados para este ano';
    panel(p);
    state.enfPeriod = p;
    state.enfTotals = f;
    if (!state.on.deforestation && !state.on.mining && !state.on.airstrips) $('#lede').innerHTML = lede();
  }

  // frase do topo quando só a fiscalização está ligada
  function lede() {
    const p = state.enfPeriod, f = state.enfTotals;
    if (!p || !f) return 'Fiscalização do Ibama: carregando…';
    return `O Ibama lavrou <b>${fmtInt(f.autos)}</b> autos de infração e <b>${fmtInt(f.emb)}</b> embargos na Amazônia Legal ${p.txt}.`;
  }

  return { draw, lede };
})();
