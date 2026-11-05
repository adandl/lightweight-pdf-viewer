// MuPDF render worker for the separations prototype (mupdf.html).
// Runs the WASM build in vendor/mupdf off the main thread and returns raw
// separation pixmaps: C, M, Y, K, spot1 … spotN, one byte per channel.

import * as mupdf from '../vendor/mupdf/mupdf.js';

let doc = null;

function open(buffer) {
  if (doc) { doc.destroy(); doc = null; }
  doc = mupdf.Document.openDocument(buffer, 'application/pdf');
  if (!(doc instanceof mupdf.PDFDocument)) throw new Error('Not a PDF file');
  return { pages: doc.countPages(), layers: listLayers() };
}

// Optional content groups. Visibility set here applies to both the View and
// Print usage; Print additionally hides OCGs whose /Usage /Print is OFF.
function listLayers() {
  const out = [];
  const n = doc.countLayers();
  for (let i = 0; i < n; i++) out.push({ index: i, name: doc.getLayerName(i), visible: doc.isLayerVisible(i) });
  return out;
}

function setLayers(changes) {
  for (const { index, visible } of changes) doc.setLayerVisible(index, visible);
  return { layers: listLayers() };
}

const BOXES = ['MediaBox', 'CropBox', 'BleedBox', 'TrimBox', 'ArtBox'];

// Page boxes in the same coordinate space as the render (points, origin top-left
// of the page after /Rotate). MuPDF substitutes the CropBox for missing boxes,
// so only boxes that are really in the page dictionary are reported.
function pageBoxes(page) {
  const obj = page.getObject();
  const boxes = {};
  for (const name of BOXES) {
    let present = name === 'MediaBox' || name === 'CropBox';
    if (!present) {
      const v = obj.get(name);
      present = v && !v.isNull();
    }
    if (present) boxes[name] = page.getBounds(name);
  }
  return boxes;
}

function render({ page: pageNo, scale, usage, box }) {
  const t0 = performance.now();
  const page = doc.loadPage(pageNo - 1);
  const pix = page.toSeparationsPixmap(mupdf.Matrix.scale(scale, scale), usage, box);
  const W = pix.getWidth(), H = pix.getHeight();
  const n = pix.getNumberOfComponents();
  const stride = pix.getStride();
  const src = pix.getPixels();

  // Copy out of WASM memory (it can move or be reused) into a tightly packed buffer.
  const data = new Uint8Array(W * H * n);
  const row = W * n;
  for (let y = 0; y < H; y++) data.set(src.subarray(y * stride, y * stride + row), y * row);

  const seps = pix.getSeparations();
  const overprint = page.usesOverprint();
  const bounds = page.getBounds(box);
  const boxes = pageBoxes(page);
  pix.destroy();
  page.destroy();
  return { W, H, n, data, seps, overprint, bounds, boxes, ms: Math.round(performance.now() - t0) };
}

self.onmessage = (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'open') {
      self.postMessage({ type: 'opened', id: msg.id, ...open(msg.buffer) });
    } else if (msg.type === 'layers') {
      self.postMessage({ type: 'layers', id: msg.id, ...setLayers(msg.changes) });
    } else if (msg.type === 'render') {
      const r = render(msg);
      self.postMessage({ type: 'rendered', id: msg.id, ...r }, [r.data.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: String(err?.message || err) });
  }
};

self.postMessage({ type: 'ready' });
