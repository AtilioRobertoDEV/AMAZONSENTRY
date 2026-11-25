// ------------------------------------------------------------------ formas de mostrar a mancha (propostas)
// ?visual=hex      grade de hexágonos com cor em degraus
// ?visual=contorno curvas de nível da pressão (como um mapa topográfico)
// ?visual=pontos   cada ponto vale uma área fixa (densidade de pontos)
// ?visual=misto    curvas de nível de longe, pontos de perto
// sem parâmetro: mapa de calor (atual)
const VISUAL = (() => {
  const KINDS = ['calor', 'hex', 'contorno', 'pontos', 'misto'];
  // degraus de cor: no satélite, tons médios (sem brilho de neon); no mapa claro, escurecem
  const STEPS = {
    sat: {
      deforestation: ['#b8742a', '#d99536', '#ecb84d', '#f6d77c', '#fff0bd'],
      mining: ['#1e7d72', '#279c8d', '#36bba8', '#62d6c3', '#a6efe2'],
    },
    light: {
      deforestation: ['#f3cf8a', '#e8a54e', '#d27a2c', '#ac5219', '#7a330c'],
      mining: ['#9fdccf', '#5fbfad', '#2f9c8a', '#177768', '#0a524a'],
    },
  };
  const OP = { hex: [0.1, 0.42, 0.6, 0.76, 0.9], contorno: [0.1, 0.12, 0.15, 0.18, 0.24] };
  let hexBand = null;
  const cache = {};

  const kind = () => state.visual || 'calor';
  const on = () => kind() !== 'calor';
  const pal = (l) => STEPS[state.base === 'sat' ? 'sat' : 'light'][l];
  const stepExpr = (l, prop, vals) => ['match', ['get', 'k'], ...vals.flatMap((v, i) => [i, v]), vals[0]];

  // pontos de entrada iguais para as duas camadas: [lon, lat, área em ha]
  function pts(r, l) {
    if (l === 'mining') return r.shown.map((it) => [it.x, it.y, it.v]);
    const c = r.cells;
    return c.list.map((q) => [c.ox + (q.x + 0.5) * c.cs, c.oy + (q.y + 0.5) * c.cs, q.v]);
  }
  const mercY = (lat) => (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const latOf = (y) => (360 / Math.PI) * Math.atan(Math.exp((y * Math.PI) / 180)) - 90;
  // classe 0..4 pelo valor relativo (degraus fixos para a cor não "pulsar" entre períodos)
  const klass = (w) => (w < 0.08 ? 0 : w < 0.2 ? 1 : w < 0.4 ? 2 : w < 0.7 ? 3 : 4);

  // ---- hexágonos: lado ~11 px na tela, refeitos quando o zoom muda de faixa
  function hexFeatures(r, l) {
    const z = Math.max(3, Math.min(12, Math.round(map.getZoom())));
    // a mesma grade para as duas camadas: o garimpo vira um hexágono menor dentro do hexágono do desmatamento
    const cs = state.results.deforestation?.cells?.cs || 0;
    const R = Math.max(8 / pxPerDeg(z), cs * 0.75);   // raio em graus (mercator)
    const inset = l === 'mining' ? 0.58 : 0.94;
    const w = Math.sqrt(3) * R, h = 1.5 * R;
    const bins = new Map();
    for (const [x, lat, v] of pts(r, l)) {
      const y = mercY(lat);
      // hexágono de ponta para cima: arredondamento axial
      const qf = (x * Math.sqrt(3) / 3 - y / 3) / R, rf = (2 * y / 3) / R;
      let q = Math.round(qf), rr = Math.round(rf), s = Math.round(-qf - rf);
      const dq = Math.abs(q - qf), dr = Math.abs(rr - rf), ds = Math.abs(s + qf + rf);
      if (dq > dr && dq > ds) q = -rr - s; else if (dr > ds) rr = -q - s;
      const key = `${q},${rr}`;
      bins.set(key, (bins.get(key) || 0) + v);
    }
    const ref = percentile([...bins.values()], 0.95) || 1;
    const feats = [];
    for (const [key, v] of bins) {
      const [q, rr] = key.split(',').map(Number);
      const cx = w * (q + rr / 2), cy = h * rr;
      const ring = [];
      for (let i = 0; i <= 6; i++) {
        const a = (Math.PI / 180) * (60 * i - 30);
        ring.push([cx + R * inset * Math.cos(a), latOf(cy + R * inset * Math.sin(a))]);
      }
      feats.push({ type: 'Feature', properties: { k: klass(v / ref), v }, geometry: { type: 'Polygon', coordinates: [ring] } });
    }
    feats.sort((a, b) => a.properties.k - b.properties.k);
    return feats;
  }

  // ---- curvas de nível: grade de ~5 km, suavizada, cortada em 5 níveis (não depende do zoom)
  function contourFeatures(r, l) {
    const P = pts(r, l);
    if (!P.length) return [];
    const g = l === 'mining' ? 0.04 : Math.max(0.05, r.cells.cs);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of P) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const pad = 6;
    x0 -= pad * g; y0 -= pad * g;
    const W = Math.ceil((x1 - x0) / g) + pad + 1, H = Math.ceil((y1 - y0) / g) + pad + 1;
    const grid = new Float64Array(W * H);
    for (const [x, y, v] of P) grid[Math.floor((y - y0) / g) * W + Math.floor((x - x0) / g)] += v;
    d3.blur2({ data: grid, width: W, height: H }, l === 'mining' ? 3 : 1.6);
    const pos = []; for (const v of grid) if (v > 0) pos.push(v);
    const ref = percentile(pos, 0.995) || 1;
    const levels = [0.025, 0.07, 0.16, 0.32, 0.6].map((t) => t * ref);
    const polys = d3.contours().size([W, H]).thresholds(levels)(grid);
    return polys.map((mp, k) => ({ type: 'Feature', properties: { k },
      geometry: { type: 'MultiPolygon', coordinates: mp.coordinates.map((poly) => poly.map((ring) => ring.map(([cx, cy]) => [x0 + cx * g, y0 + cy * g]))) } }));
  }

  // ---- pontos: cada ponto vale N ha (N redondo, ~12 mil pontos no total)
  function hash(a, b) { let h = (a * 374761393 + b * 668265263) >>> 0; h = ((h ^ (h >>> 13)) * 1274126177) >>> 0; return (h ^ (h >>> 16)) / 4294967296; }
  function niceDot(total, target) {
    const raw = total / target, p = 10 ** Math.floor(Math.log10(raw));
    return [1, 2, 5, 10].map((m) => m * p).find((v) => v >= raw) || raw;
  }
  function dotFeatures(r, l) {
    const P = pts(r, l);
    const total = P.reduce((s, p) => s + p[2], 0);
    const per = niceDot(total, l === 'mining' ? 6000 : 14000);
    const span = l === 'mining' ? 0.012 : r.cells.cs;
    const feats = [];
    P.forEach(([x, y, v], i) => {
      const n0 = v / per, n = Math.floor(n0) + (hash(i, 7) < n0 % 1 ? 1 : 0);
      for (let j = 0; j < n; j++) {
        feats.push({ type: 'Feature', properties: {}, geometry: { type: 'Point',
          coordinates: [x + (hash(i, j * 2 + 1) - 0.5) * span, y + (hash(i, j * 2 + 2) - 0.5) * span] } });
      }
    });
    cache[l + 'per'] = per;
    return feats;
  }

  function addLayers(beforeOf) {
    for (const l of LAYERS) {
      map.addSource(`src-${l}-alt`, { type: 'geojson', data: EMPTY, tolerance: 0.2 });
      const before = beforeOf(l);
      map.addLayer({ id: `alt-${l}-fill`, type: 'fill', source: `src-${l}-alt`, filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-antialias': true } }, before);
      map.addLayer({ id: `alt-${l}-line`, type: 'line', source: `src-${l}-alt`, filter: ['==', ['geometry-type'], 'Polygon'] }, before);
      map.addLayer({ id: `alt-${l}-dot`, type: 'circle', source: `src-${l}-alt`, filter: ['==', ['geometry-type'], 'Point'] }, before);
    }
  }

  function paint(l) {
    const k = kind(), c = pal(l), sat = state.base === 'sat';
    const color = stepExpr(l, 'k', c);
    // o garimpo some no zoom em que aparecem os quadros reais
    const fadeOut = (v) => (l === 'mining' ? ['interpolate', ['linear'], ['zoom'], NEAR.mining - 1, v, NEAR.mining + 1, 0] : v);
    // misto: as curvas saem e os pontos entram entre os zooms 5,5 e 7
    // (um só interpolate por zoom: o MapLibre não aceita um dentro do outro)
    const m = NEAR.mining;
    const away = (v) => (k !== 'misto' ? fadeOut(v) : ['interpolate', ['linear'], ['zoom'], 5.5, v, 7, 0]);
    const near = (v) => (k !== 'misto' ? fadeOut(v) : l === 'mining'
      ? ['interpolate', ['linear'], ['zoom'], 5.5, 0, 7, v, m - 1, v, m + 1, 0]
      : ['interpolate', ['linear'], ['zoom'], 5.5, 0, 7, v]);
    if (k === 'hex') {
      map.setPaintProperty(`alt-${l}-fill`, 'fill-color', color);
      map.setPaintProperty(`alt-${l}-fill`, 'fill-opacity', fadeOut(stepExpr(l, 'k', OP.hex)));
      map.setPaintProperty(`alt-${l}-line`, 'line-color', sat ? 'rgba(20,14,8,0.35)' : 'rgba(255,255,255,0.5)');
      map.setPaintProperty(`alt-${l}-line`, 'line-width', 0);
    }
    if (k === 'contorno' || k === 'misto') {
      map.setPaintProperty(`alt-${l}-fill`, 'fill-color', color);
      map.setPaintProperty(`alt-${l}-fill`, 'fill-opacity', away(stepExpr(l, 'k', OP.contorno)));
      map.setPaintProperty(`alt-${l}-line`, 'line-color', color);
      map.setPaintProperty(`alt-${l}-line`, 'line-width', ['interpolate', ['linear'], ['zoom'], 3, ['match', ['get', 'k'], 0, 0.6, 1.1], 8, ['match', ['get', 'k'], 0, 1, 1.8]]);
      map.setPaintProperty(`alt-${l}-line`, 'line-opacity', away(0.95));
    }
    if (k === 'pontos' || k === 'misto') {
      map.setPaintProperty(`alt-${l}-dot`, 'circle-color', c[l === 'mining' ? 4 : 3]);
      map.setPaintProperty(`alt-${l}-dot`, 'circle-radius', l === 'mining'
        ? ['interpolate', ['linear'], ['zoom'], 3, 1.5, 6, 2, 9, 2.8, 12, 3.6]
        : ['interpolate', ['linear'], ['zoom'], 3, 1.1, 6, 1.6, 9, 2.4, 12, 3.2]);
      map.setPaintProperty(`alt-${l}-dot`, 'circle-opacity', near(0.9));
      map.setPaintProperty(`alt-${l}-dot`, 'circle-stroke-width', 0);
    }
  }

  function draw(l, r) {
    const src = map.getSource(`src-${l}-alt`);
    if (!src) return;
    if (!on() || !r) { src.setData(EMPTY); return; }
    const k = kind();
    const feats = k === 'hex' ? hexFeatures(r, l) : k === 'contorno' ? contourFeatures(r, l)
      : k === 'pontos' ? dotFeatures(r, l) : contourFeatures(r, l).concat(dotFeatures(r, l));
    src.setData({ type: 'FeatureCollection', features: feats });
    paint(l);
    hexBand = Math.round(map.getZoom());
  }

  function zoomed() {
    if (kind() !== 'hex' || Math.round(map.getZoom()) === hexBand) return;
    LAYERS.forEach((l) => draw(l, state.on[l] && state.mode !== 'radar' ? state.results[l] : null));
  }

  return { KINDS, on, kind, addLayers, draw, paint, zoomed, per: (l) => cache[l + 'per'] };
})();
