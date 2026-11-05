// Separations prototype: MuPDF (WASM) renders every ink into its own channel
// with overprint simulated, and this script composites the enabled plates.
// Unlike the PDF.js viewer nothing is guessed back from RGB pixels: each
// channel is the real tint of that ink as defined in the PDF.

const $ = (id) => document.getElementById(id);

// Approximate sRGB look of 100 % process inks on coated paper.
const PROCESS = [
  { name: 'Cyan',    rgb: [0 / 255, 158 / 255, 224 / 255] },
  { name: 'Magenta', rgb: [226 / 255, 0 / 255, 122 / 255] },
  { name: 'Yellow',  rgb: [255 / 255, 237 / 255, 0 / 255] },
  { name: 'Black',   rgb: [35 / 255, 31 / 255, 32 / 255] },
];
const TAC_LIMIT = 300;
const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8];

const state = {
  fileName: '',
  pages: 0,
  page: 1,
  zoom: 1,
  usage: 'View',  // optional-content usage; layer visibility is controlled in the Layers panel
  plates: null,   // { W, H, n, data }
  inks: [],       // [{ name, rgb, enabled, coverage }] in channel order
  renderId: 0,
  eyedropper: false,
  showBoxes: false,
  layers: [],     // [{ index, name, visible }]
  boxes: null,    // { TrimBox: [x0,y0,x1,y1], … } of the current page, in points
  bounds: null,   // rendered box (CropBox) in the same space
  samples: [],    // [{ id, page, px, py }] — px/py in PDF points from the page's top-left
  nextSampleId: 1,
};

const canvas = $('mu-canvas');
const ctx2d = canvas.getContext('2d');

// ── Worker ────────────────────────────────────────────────────────────────────
const worker = new Worker(new URL('./mupdf-worker.js', import.meta.url), { type: 'module' });
const pending = new Map();
let nextId = 1;
let workerReady;
const readyPromise = new Promise((res) => { workerReady = res; });

worker.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'ready') { workerReady(); setStatus('Ready. Open a PDF.'); return; }
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.type === 'error') p.reject(new Error(msg.message));
  else p.resolve(msg);
};
worker.onerror = (e) => setStatus(`MuPDF failed to load: ${e.message || 'see console'}`);

function call(msg, transfer = []) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id }, transfer);
  });
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function setStatus(text) { $('mu-status').textContent = text; }
const pct = (v) => `${(v * 100).toFixed(v >= 0.995 || v === 0 ? 0 : 1)} %`;
const mm = (pt) => (pt * 25.4 / 72).toFixed(1);
const css = (rgb) => `rgb(${rgb.map((v) => Math.round(v * 255)).join(',')})`;

function enableControls(on) {
  ['mu-prev', 'mu-next', 'mu-zoom-in', 'mu-zoom-out', 'mu-fit', 'mu-eyedropper', 'mu-boxes']
    .forEach((id) => { $(id).disabled = !on; });
  if (on) {
    $('mu-prev').disabled = state.page <= 1;
    $('mu-next').disabled = state.page >= state.pages;
  }
}

// ── Opening and rendering ─────────────────────────────────────────────────────
async function openFile(file) {
  await readyPromise;
  setStatus(`Loading ${file.name}…`);
  try {
    const buffer = await file.arrayBuffer();
    const r = await call({ type: 'open', buffer }, [buffer]);
    state.fileName = file.name;
    state.pages = r.pages;
    state.page = 1;
    state.inks = [];
    state.plates = null;
    state._fitPage = null;
    state.samples = [];
    state.nextSampleId = 1;
    state.layers = r.layers;
    buildLayersPanel();
    $('mu-drop').hidden = true;
    $('mu-stage').hidden = false;
    await fitZoom();
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  }
}

async function renderPage() {
  const myId = ++state.renderId;
  const dpr = window.devicePixelRatio || 1;
  setStatus(`Rendering page ${state.page}…`);
  enableControls(false);
  try {
    const r = await call({
      type: 'render', page: state.page, scale: state.zoom * dpr, usage: state.usage, box: 'CropBox',
    });
    if (myId !== state.renderId) return; // a newer render was requested meanwhile
    state.plates = { W: r.W, H: r.H, n: r.n, data: r.data };
    mergeInks(r.seps);
    computeCoverage();
    buildSepsPanel();

    canvas.width = r.W;
    canvas.height = r.H;
    canvas.style.width = `${r.W / dpr}px`;
    canvas.style.height = `${r.H / dpr}px`;
    composite();
    state.pxPerPt = state.zoom * dpr;
    state.boxes = r.boxes;
    state.bounds = r.bounds;
    drawBoxes();
    renderMarks();
    buildSamplesPanel();

    $('mu-page').textContent = `${state.page} / ${state.pages}`;
    $('mu-zoom').textContent = `${Math.round(state.zoom * 100)}%`;
    const spots = r.seps.length;
    const fmt = r.boxes.TrimBox || r.boxes.CropBox;
    const size = `${mm(fmt[2] - fmt[0])} × ${mm(fmt[3] - fmt[1])} mm${r.boxes.TrimBox ? ' trim' : ''}`;
    setStatus(`${state.fileName} · ${size} · ${4 + spots} inks (${spots} spot) · ` +
      `${r.overprint ? 'overprint used' : 'no overprint'} · ${r.ms} ms`);
  } catch (err) {
    if (myId === state.renderId) setStatus(`Render error: ${err.message}`);
  } finally {
    if (myId === state.renderId) enableControls(true);
  }
}

// Keep the on/off choice of each ink when switching pages or zoom.
function mergeInks(seps) {
  const prev = new Map(state.inks.map((i) => [i.name, i.enabled]));
  state.inks = [...PROCESS, ...seps].map((s) => ({
    name: s.name, rgb: s.rgb, enabled: prev.has(s.name) ? prev.get(s.name) : true, coverage: 0,
  }));
}

function computeCoverage() {
  const { W, H, n, data } = state.plates;
  const sums = new Float64Array(n);
  for (let i = 0, len = W * H * n; i < len; i += n) {
    for (let c = 0; c < n; c++) sums[c] += data[i + c];
  }
  state.inks.forEach((ink, c) => { ink.coverage = sums[c] / (W * H * 255); });
}

// ── Compositing ───────────────────────────────────────────────────────────────
// Each ink acts as a filter on white paper: per channel the remaining light is
// 1 − tint · (1 − inkColour), and inks multiply where they overlap.
function composite() {
  if (!state.plates) return;
  const { W, H, n, data } = state.plates;
  const active = [];
  state.inks.forEach((ink, c) => {
    if (!ink.enabled) return;
    const lut = new Float32Array(256 * 3);
    for (let t = 0; t < 256; t++) {
      lut[t * 3] = 1 - (t / 255) * (1 - ink.rgb[0]);
      lut[t * 3 + 1] = 1 - (t / 255) * (1 - ink.rgb[1]);
      lut[t * 3 + 2] = 1 - (t / 255) * (1 - ink.rgb[2]);
    }
    active.push([c, lut]);
  });

  const img = ctx2d.createImageData(W, H);
  const out = img.data;
  for (let p = 0, s = 0; p < out.length; p += 4, s += n) {
    let r = 1, g = 1, b = 1;
    for (let a = 0; a < active.length; a++) {
      const t = data[s + active[a][0]];
      if (t === 0) continue;
      const lut = active[a][1];
      r *= lut[t * 3]; g *= lut[t * 3 + 1]; b *= lut[t * 3 + 2];
    }
    out[p] = r * 255; out[p + 1] = g * 255; out[p + 2] = b * 255; out[p + 3] = 255;
  }
  ctx2d.putImageData(img, 0, 0);
}

// ── Separations panel ─────────────────────────────────────────────────────────
function buildSepsPanel() {
  const list = $('mu-seps');
  list.textContent = '';
  state.inks.forEach((ink) => {
    const li = document.createElement('li');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = ink.enabled;
    cb.title = `Show or hide ${ink.name}`;
    cb.addEventListener('change', () => { ink.enabled = cb.checked; composite(); });
    const sw = document.createElement('span');
    sw.className = 'mu-swatch';
    sw.style.background = css(ink.rgb);
    const name = document.createElement('span');
    name.className = 'mu-name';
    name.textContent = ink.name;
    name.title = `${ink.name}: click to show only this plate`;
    name.addEventListener('click', () => solo(ink));
    const val = document.createElement('span');
    val.className = 'mu-val';
    val.textContent = pct(ink.coverage);
    val.title = 'Average coverage of this page';
    li.append(cb, sw, name, val);
    list.append(li);
  });
}

function setAll(on) {
  state.inks.forEach((i) => { i.enabled = on; });
  buildSepsPanel();
  composite();
}

function solo(ink) {
  const alreadySolo = ink.enabled && state.inks.every((i) => i === ink || !i.enabled);
  if (alreadySolo) { setAll(true); return; }
  state.inks.forEach((i) => { i.enabled = i === ink; });
  buildSepsPanel();
  composite();
}

// ── Densitometer & eyedropper ─────────────────────────────────────────────────
// Readings come straight from the separation channels, i.e. the real ink
// values of the PDF, not from screen RGB.

// Event → plate pixel coordinates (or null if outside the page).
function eventToPixel(e) {
  if (!state.plates) return null;
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor((e.clientX - rect.left) * (canvas.width / rect.width));
  const y = Math.floor((e.clientY - rect.top) * (canvas.height / rect.height));
  if (x < 0 || y < 0 || x >= state.plates.W || y >= state.plates.H) return null;
  return { x, y };
}

// Ink values (0…1) of every channel at a plate pixel, plus TAC and the
// composite colour of all inks (independent of the plate toggles).
function readAt(x, y) {
  const { W, n, data } = state.plates;
  const base = (y * W + x) * n;
  const values = [];
  let tac = 0, r = 1, g = 1, b = 1;
  state.inks.forEach((ink, c) => {
    const t = data[base + c] / 255;
    values.push(t);
    tac += t;
    r *= 1 - t * (1 - ink.rgb[0]); g *= 1 - t * (1 - ink.rgb[1]); b *= 1 - t * (1 - ink.rgb[2]);
  });
  return { values, tac, rgb: [r, g, b] };
}

function inkRows(values, container, withBars) {
  let any = false;
  state.inks.forEach((ink, c) => {
    const t = values[c];
    if (!t) return;
    any = true;
    const row = document.createElement(withBars ? 'div' : 'li');
    if (withBars) row.className = 'mu-sv';
    const sw = document.createElement('span');
    sw.className = 'mu-swatch';
    sw.style.background = css(ink.rgb);
    const name = document.createElement('span');
    name.className = 'mu-name';
    name.textContent = ink.name;
    name.title = ink.name;
    const val = document.createElement('span');
    val.className = 'mu-val';
    val.textContent = pct(t);
    if (withBars) {
      const bar = document.createElement('div');
      bar.className = 'mu-bar';
      const fill = document.createElement('span');
      fill.style.width = `${t * 100}%`;
      fill.style.background = css(ink.rgb);
      bar.append(fill);
      row.append(sw, name, bar, val);
    } else {
      row.append(sw, name, val);
    }
    container.append(row);
  });
  return any;
}

function showProbe(reading) {
  const list = $('mu-probe');
  list.textContent = '';
  if (!inkRows(reading.values, list, false)) {
    const li = document.createElement('li');
    li.className = 'mu-hint';
    li.textContent = 'No ink (paper white).';
    list.append(li);
  }
  const tacEl = $('mu-tac');
  tacEl.textContent = `TAC ${Math.round(reading.tac * 100)} %`;
  tacEl.classList.toggle('mu-warn', reading.tac * 100 > TAC_LIMIT);
}

function setEyedropper(on) {
  state.eyedropper = on;
  $('mu-eyedropper').classList.toggle('btn-active', on);
  $('mu-stage').classList.toggle('mu-eyedropper', on);
  if (!on) { state.pending = null; renderMarks(); }
}

// Pointer handling: mouse hover updates the densitometer; with the eyedropper
// on, a click (mouse) or tap/drag-and-release (finger, pencil) pins a sample.
// While a finger is down the cross follows it, so the point is visible.
canvas.addEventListener('pointermove', (e) => {
  const p = eventToPixel(e);
  if (!p) return;
  if (e.pointerType === 'mouse' && !state.pending) { showProbe(readAt(p.x, p.y)); return; }
  if (state.pending && state.pending.pointerId === e.pointerId) {
    state.pending.x = p.x; state.pending.y = p.y;
    showProbe(readAt(p.x, p.y));
    renderMarks();
  }
});
canvas.addEventListener('pointerdown', (e) => {
  if (!state.eyedropper) return;
  const p = eventToPixel(e);
  if (!p) return;
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  state.pending = { pointerId: e.pointerId, x: p.x, y: p.y };
  showProbe(readAt(p.x, p.y));
  renderMarks();
});
function finishPending(e, keep) {
  if (!state.pending || state.pending.pointerId !== e.pointerId) return;
  const { x, y } = state.pending;
  state.pending = null;
  if (keep) {
    state.samples.push({
      id: state.nextSampleId++, page: state.page,
      px: (x + 0.5) / state.pxPerPt, py: (y + 0.5) / state.pxPerPt,
    });
    buildSamplesPanel();
  }
  renderMarks();
}
canvas.addEventListener('pointerup', (e) => finishPending(e, true));
canvas.addEventListener('pointercancel', (e) => finishPending(e, false));

function sampleToPixel(s) {
  return {
    x: Math.min(state.plates.W - 1, Math.max(0, Math.floor(s.px * state.pxPerPt))),
    y: Math.min(state.plates.H - 1, Math.max(0, Math.floor(s.py * state.pxPerPt))),
  };
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}
function markEl(x, y, label) {
  const g = svg('g', { transform: `translate(${x},${y})` });
  for (const [stroke, w] of [['rgba(0,0,0,.7)', 3], ['#fff', 1.5]]) {
    g.append(svg('line', { x1: -10, y1: 0, x2: 10, y2: 0, stroke, 'stroke-width': w }));
    g.append(svg('line', { x1: 0, y1: -10, x2: 0, y2: 10, stroke, 'stroke-width': w }));
  }
  if (label != null) {
    g.append(svg('circle', { cx: 12, cy: -12, r: 8, fill: '#4dabf7' }));
    const t = svg('text', {
      x: 12, y: -12, 'text-anchor': 'middle', 'dominant-baseline': 'central',
      'font-family': 'sans-serif', 'font-size': label >= 10 ? 7 : 9, 'font-weight': 'bold', fill: '#fff',
    });
    t.textContent = label;
    g.append(t);
  }
  return g;
}

// Marks are drawn in CSS pixels so they keep their size at every zoom.
function renderMarks() {
  const marks = $('mu-marks');
  marks.textContent = '';
  if (!state.plates) return;
  const dpr = window.devicePixelRatio || 1;
  for (const s of state.samples) {
    if (s.page !== state.page) continue;
    marks.append(markEl(s.px * state.zoom, s.py * state.zoom, s.id));
  }
  if (state.pending) marks.append(markEl((state.pending.x + 0.5) / dpr, (state.pending.y + 0.5) / dpr, null));
}

// Samples are re-read from the current render, so values always match what is shown.
function buildSamplesPanel() {
  const box = $('mu-samples');
  box.textContent = '';
  if (!state.samples.length) {
    const hint = document.createElement('div');
    hint.className = 'mu-hint';
    hint.textContent = 'Turn on the eyedropper and tap or click the page to pin a measurement.';
    box.append(hint);
    return;
  }
  for (const s of state.samples) {
    const item = document.createElement('div');
    item.className = 'mu-sample';
    const head = document.createElement('div');
    head.className = 'mu-sample-head';
    const badge = document.createElement('span');
    badge.className = 'mu-badge';
    badge.textContent = s.id;
    head.append(badge);
    let reading = null;
    if (s.page === state.page && state.plates) {
      const p = sampleToPixel(s);
      reading = readAt(p.x, p.y);
      const sw = document.createElement('span');
      sw.className = 'mu-sample-swatch';
      sw.style.background = css(reading.rgb);
      head.append(sw);
    }
    const where = document.createElement('span');
    where.className = 'mu-val';
    where.textContent = `p.${s.page}`;
    head.append(where);
    if (reading) {
      const tac = document.createElement('span');
      tac.className = 'mu-sample-tac';
      tac.textContent = `TAC ${Math.round(reading.tac * 100)} %`;
      tac.classList.toggle('mu-warn', reading.tac * 100 > TAC_LIMIT);
      head.append(tac);
    }
    const del = document.createElement('button');
    del.className = 'mu-del';
    del.title = 'Remove this sample';
    del.textContent = '✕';
    if (!reading) del.style.marginLeft = 'auto';
    del.addEventListener('click', () => {
      state.samples = state.samples.filter((x) => x !== s);
      buildSamplesPanel();
      renderMarks();
    });
    head.append(del);
    item.append(head);
    if (reading) {
      if (!inkRows(reading.values, item, true)) {
        const none = document.createElement('div');
        none.className = 'mu-hint';
        none.textContent = 'No ink (paper white).';
        item.append(none);
      }
    } else {
      const other = document.createElement('div');
      other.className = 'mu-hint';
      other.textContent = `On page ${s.page}.`;
      item.append(other);
    }
    box.append(item);
  }
}

// ── Layers (optional content) ─────────────────────────────────────────────────
function buildLayersPanel() {
  const list = $('mu-layers');
  list.textContent = '';
  if (!state.layers.length) {
    const li = document.createElement('li');
    li.className = 'mu-hint';
    li.textContent = 'No layers in this document.';
    list.append(li);
    return;
  }
  for (const layer of state.layers) {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = layer.visible;
    cb.addEventListener('change', () => setLayers([{ index: layer.index, visible: cb.checked }]));
    const name = document.createElement('span');
    name.className = 'mu-name';
    name.textContent = layer.name || `Layer ${layer.index + 1}`;
    name.title = name.textContent;
    label.append(cb, name);
    li.append(label);
    list.append(li);
  }
}

async function setLayers(changes) {
  if (!changes.length) return;
  try {
    const r = await call({ type: 'layers', changes });
    state.layers = r.layers;
    buildLayersPanel();
    await renderPage();
  } catch (err) {
    setStatus(`Layer error: ${err.message}`);
  }
}

// ── Page boxes ────────────────────────────────────────────────────────────────
const BOX_STYLES = {
  // place: where the label sits so neighbouring boxes don't overlap their labels
  TrimBox:  { color: '#4dabf7', dash: null,    width: 1.5, label: 'Trim',  place: 'inside-top' },
  BleedBox: { color: '#ff6b6b', dash: '5 3',   width: 1.5, label: 'Bleed', place: 'outside-top' },
  ArtBox:   { color: '#69db7c', dash: '3 3',   width: 1,   label: 'Art',   place: 'inside-bottom' },
  CropBox:  { color: '#ffd43b', dash: '6 2 2', width: 1,   label: 'Crop',  place: 'inside-top' },
};

function drawBoxes() {
  const overlay = $('mu-boxes-overlay');
  overlay.textContent = '';
  if (!state.showBoxes || !state.boxes || !state.bounds) return;
  const [ox, oy] = state.bounds;
  const z = state.zoom;
  for (const [name, style] of Object.entries(BOX_STYLES)) {
    const b = state.boxes[name];
    if (!b) continue;
    const x = (b[0] - ox) * z, y = (b[1] - oy) * z;
    const w = (b[2] - b[0]) * z, h = (b[3] - b[1]) * z;
    if (w <= 0 || h <= 0) continue;
    const rect = svg('rect', {
      x: x.toFixed(1), y: y.toFixed(1), width: w.toFixed(1), height: h.toFixed(1),
      fill: 'none', stroke: style.color, 'stroke-width': style.width,
    });
    if (style.dash) rect.setAttribute('stroke-dasharray', style.dash);
    let ty = style.place === 'inside-bottom' ? y + h - 5 : style.place === 'outside-top' && y > 14 ? y - 4 : y + 13;
    const text = svg('text', { x: (x + 4).toFixed(1), y: ty.toFixed(1), fill: style.color });
    text.textContent = `${style.label}  ${mm(b[2] - b[0])}×${mm(b[3] - b[1])} mm`;
    overlay.append(rect, text);
  }
}

function setShowBoxes(on) {
  state.showBoxes = on;
  $('mu-boxes').classList.toggle('btn-active', on);
  drawBoxes();
}

// ── Zoom & navigation ─────────────────────────────────────────────────────────
function setZoom(z) {
  state.zoom = Math.min(8, Math.max(0.1, z));
  renderPage();
}
function zoomStep(dir) {
  const z = state.zoom;
  const next = dir > 0 ? ZOOMS.find((s) => s > z + 1e-3) : [...ZOOMS].reverse().find((s) => s < z - 1e-3);
  if (next) setZoom(next);
}
async function fitZoom() {
  // Render once at 100 % to learn the page size, then fit if it differs.
  const area = $('mu-area');
  if (!state.plates || state.page !== state._fitPage) {
    state.zoom = 1;
    await renderPage();
    state._fitPage = state.page;
  }
  if (!state.plates) return;
  const dpr = window.devicePixelRatio || 1;
  const pageW = state.plates.W / dpr / state.zoom;
  const pageH = state.plates.H / dpr / state.zoom;
  const fit = Math.min((area.clientWidth - 48) / pageW, (area.clientHeight - 48) / pageH);
  if (Math.abs(fit - state.zoom) > 0.01) setZoom(fit);
}
function goto(p) {
  if (p < 1 || p > state.pages || p === state.page) return;
  state.page = p;
  renderPage();
}

// ── Events ────────────────────────────────────────────────────────────────────
$('mu-file').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) openFile(f); });
$('mu-prev').addEventListener('click', () => goto(state.page - 1));
$('mu-next').addEventListener('click', () => goto(state.page + 1));
$('mu-zoom-in').addEventListener('click', () => zoomStep(1));
$('mu-zoom-out').addEventListener('click', () => zoomStep(-1));
$('mu-fit').addEventListener('click', () => { state._fitPage = null; fitZoom(); });
$('mu-all').addEventListener('click', () => setAll(true));
$('mu-none').addEventListener('click', () => setAll(false));
$('mu-boxes').addEventListener('click', () => setShowBoxes(!state.showBoxes));
$('mu-layers-all').addEventListener('click', () =>
  setLayers(state.layers.filter((l) => !l.visible).map((l) => ({ index: l.index, visible: true }))));
$('mu-layers-none').addEventListener('click', () =>
  setLayers(state.layers.filter((l) => l.visible).map((l) => ({ index: l.index, visible: false }))));
$('mu-eyedropper').addEventListener('click', () => setEyedropper(!state.eyedropper));
$('mu-clear-samples').addEventListener('click', () => {
  state.samples = [];
  state.nextSampleId = 1;
  buildSamplesPanel();
  renderMarks();
});

const area = $('mu-area');
area.addEventListener('dragover', (e) => { e.preventDefault(); area.classList.add('mu-dragover'); });
area.addEventListener('dragleave', () => area.classList.remove('mu-dragover'));
area.addEventListener('drop', (e) => {
  e.preventDefault();
  area.classList.remove('mu-dragover');
  const f = e.dataTransfer.files[0];
  if (f) openFile(f);
});

document.addEventListener('keydown', (e) => {
  if (!state.pages || e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') goto(state.page - 1);
  else if (e.key === 'ArrowRight' || e.key === 'PageDown') goto(state.page + 1);
  else if (e.key === '+' || e.key === '=') zoomStep(1);
  else if (e.key === '-') zoomStep(-1);
  else if (e.key === '0') { state._fitPage = null; fitZoom(); }
  else if (e.key === 'd' || e.key === 'D') { if (state.plates) setEyedropper(!state.eyedropper); }
  else if (e.key === 'Escape') setEyedropper(false);
  else if (e.key === 'b' || e.key === 'B') { if (state.plates) setShowBoxes(!state.showBoxes); }
});

// Allow ?file=samples/xyz.pdf for quick testing from the same origin.
const qp = new URLSearchParams(location.search).get('file');
if (qp) {
  fetch(qp).then((r) => {
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.blob();
  }).then((b) => openFile(new File([b], qp.split('/').pop()))).catch((err) => setStatus(`Error: ${err.message}`));
}
