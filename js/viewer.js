'use strict';

// ── PDF.js setup ─────────────────────────────────────────────────────────────
const pdfjsLib = window['pdfjs-dist/build/pdf'];
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ── Helpers ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  pdf:               null,
  currentPage:       1,
  totalPages:        0,
  scale:             1.0,
  originalImageData: null,   // pixels before separation filter
  separations:       { c: true, m: true, y: true, k: true },
  ocConfig:          null,   // PDF.js OptionalContentConfig (display intent)
  ocConfigPrint:     null,   // PDF.js OptionalContentConfig (print intent — OPP)
  acvOCGId:          null,   // ID of the AcrobatViewCheck OCG (if present)
  ocConfigPrintNoACV:null,   // print config with ACV OCG off (two-pass OPP composite)
  renderTask:        null,   // current RenderTask (so we can cancel it)
  // Sample points placed by the eyedropper click
  samples:           [],     // [{ id, page, pageX, pageY, cmyk }]
  nextSampleId:      1,
  // Prepress tools
  rawPdfBuffer:      null,   // Uint8Array — kept for page-box extraction
  pageBoxes:         null,   // { MediaBox, CropBox, TrimBox, BleedBox, ArtBox } in PDF pts
  showBoxes:         false,  // page box overlay visible
  oppMode:           false,  // overprint preview (print-intent rendering)
  inkStats:          null,   // ink coverage stats computed after each render
  currentPageObj:    null,   // PDF.js PDFPageProxy for the current page
  spotColors:        [],     // [{ name, rgb:[r,g,b], enabled }] — from current PDF
  // Dual-intent render cache (display + print stored separately for instant OPP toggling)
  displayImageData:  null,   // cached display-intent render
  printImageData:    null,   // cached print-intent render
  _renderCacheKey:   null,   // 'page@scale' string — invalidated on page/scale change
  // Per-separation plate renders (one ImageData per ink, composited with multiply)
  separationPlates:    null,     // Map<name,ImageData> | null (null = not yet rendered)
  separationPlatesKey: null,     // 'page@scale@intent' — matches _renderCacheKey + intent
  ocgSpotMap:          new Map(), // OCG id → spot color name (built once per document)
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const fileInput  = $('file-input');
const dropZone   = $('drop-zone');
const canvasWrap = $('canvas-wrap');
const canvas     = $('pdf-canvas');
const ctx        = canvas.getContext('2d');
const pageInfo   = $('page-info');
const prevBtn    = $('prev-page');
const nextBtn    = $('next-page');
const zoomInBtn  = $('zoom-in');
const zoomOutBtn = $('zoom-out');
const zoomFitBtn = $('zoom-fit');
const zoomLabel  = $('zoom-level');
const layersList     = $('layers-list');
const spinner        = $('spinner');
const statusMsg      = $('status-msg');
// Eyedropper / density tool
const eyedropperBtn  = $('eyedropper-btn');
const densityTooltip = $('density-tooltip');
const dtSwatch       = $('dt-swatch');
// Sample points
const marksOverlay   = $('marks-overlay');
const samplesList    = $('samples-list');
// Prepress tools
const oppBtn         = $('opp-btn');
const boxesBtn       = $('boxes-btn');
const zoomPrintBtn   = $('zoom-print');
const boxesOverlay   = $('boxes-overlay');
const inkStatsEl     = $('ink-stats');
const tacBadge       = $('tac-badge');
const oppBar         = $('opp-bar');

// ── Eyedropper state ──────────────────────────────────────────────────────────
let eyedropperActive = false;

// ── Plate-render abort controller ─────────────────────────────────────────────
// Set to a new AbortController each time schedulePlateRender() starts.
// Aborted (and replaced) whenever a new main render starts or a new file loads.
let _plateAbortCtrl = null;

// ── Status / spinner helpers ───────────────────────────────────────────────────
// NOTE: elements with display:flex use the CSS rule `[hidden]{display:none !important}`
// so that the HTML `hidden` attribute correctly hides them regardless of display value.
function setStatus(msg)    { statusMsg.textContent = msg; }
function showSpinner(on)   { spinner.hidden = !on; }

// ── Zoom steps ────────────────────────────────────────────────────────────────
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4];

function applyZoom(scale) {
  state.scale = scale;
  zoomLabel.textContent = `${Math.round(scale * 100)}%`;
  renderPage();
}

function zoomStep(dir) {
  if (dir > 0) {
    const next = ZOOM_STEPS.find(s => s > state.scale);
    if (next !== undefined) applyZoom(next);
  } else {
    const prev = [...ZOOM_STEPS].reverse().find(s => s < state.scale);
    if (prev !== undefined) applyZoom(prev);
  }
}

// ── File loading ──────────────────────────────────────────────────────────────
fileInput.addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) openFile(file);
  e.target.value = ''; // reset so same file can be reopened
});

// Drag-and-drop on the drop zone
dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-active'); });
dropZone.addEventListener('dragenter', e => { e.preventDefault(); dropZone.classList.add('drag-active'); });
dropZone.addEventListener('dragleave', ()  => dropZone.classList.remove('drag-active'));
dropZone.addEventListener('dragend',   ()  => dropZone.classList.remove('drag-active'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-active');
  const file = e.dataTransfer.files[0];
  if (file?.type === 'application/pdf') openFile(file);
});

// Also accept drops on the canvas area when a PDF is already open
const canvasArea = $('canvas-area');
canvasArea.addEventListener('dragover', e => e.preventDefault());
canvasArea.addEventListener('drop', e => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file?.type === 'application/pdf') openFile(file);
});

async function openFile(file) {
  setStatus(`Loading ${file.name}…`);
  showSpinner(true);

  try {
    const buffer = await file.arrayBuffer();
    state.rawPdfBuffer = new Uint8Array(buffer);
    const pdfDoc = await pdfjsLib.getDocument({ data: state.rawPdfBuffer.slice() }).promise;

    state.pdf         = pdfDoc;
    state.currentPage = 1;
    state.totalPages  = pdfDoc.numPages;
    state.scale       = 1.0;
    zoomLabel.textContent = '100%';

    // Fetch Optional Content Groups (layers) config — may not exist
    try {
      state.ocConfig = await pdfDoc.getOptionalContentConfig();
    } catch (_) {
      state.ocConfig = null;
    }

    buildLayersPanel();

    // Build a separate OCG config for print intent (OPP).
    // extractOCGUsageStates() scans /Usage /Print /PrintState in raw PDF bytes
    // so we correctly show/hide the right layers (e.g. View_G / View_O) in OPP.
    const printStates = extractOCGUsageStates(state.rawPdfBuffer);
    try {
      state.ocConfigPrint = await buildPrintOCGConfig(pdfDoc, printStates);
    } catch (_) {
      state.ocConfigPrint = null;
    }

    // Two-pass OPP indicator compositing setup.
    // If the PDF contains an AcrobatViewCheck OCG, we build a second print config
    // with that OCG turned OFF so we can isolate the indicator pixels via a diff.
    state.acvOCGId          = null;
    state.ocConfigPrintNoACV = null;
    if (state.ocConfig) {
      try {
        const groups = state.ocConfig.getGroups();
        if (groups) {
          for (const [id, group] of Object.entries(groups)) {
            if (/AcrobatView/i.test(group.name)) { state.acvOCGId = id; break; }
          }
        }
      } catch (_) {}
    }
    if (state.acvOCGId) {
      try {
        // Fresh independent config: apply same print-state overrides, then hide ACV OCG.
        const noAcv = printStates.size > 0
          ? await buildPrintOCGConfig(pdfDoc, printStates)
          : await pdfDoc.getOptionalContentConfig();
        if (noAcv) {
          noAcv.setVisibility(state.acvOCGId, false);
          state.ocConfigPrintNoACV = noAcv;
        }
      } catch (_) {}
    }

    // Extract page boxes from raw PDF bytes (TrimBox, BleedBox, ArtBox, …)
    state.pageBoxes  = extractPageBoxes(state.rawPdfBuffer);
    state.spotColors = extractSpotColors(state.rawPdfBuffer);
    buildSeparationsPanel();
    // Build the OCG → spot-color-name map now that both ocConfig and spotColors are ready.
    // This is used by schedulePlateRender() to know which OCGs to isolate.
    state.ocgSpotMap = buildOcgSpotMap();

    // Clear any sample points / stats from a previous document
    state.samples      = [];
    state.nextSampleId = 1;
    buildSamplesPanel();
    state.inkStats = null;
    buildInkStatsPanel();
    // Reset dual-intent render cache and plate cache
    state.displayImageData    = null;
    state.printImageData      = null;
    state._renderCacheKey     = null;
    state.separationPlates    = null;
    state.separationPlatesKey = null;
    // Abort any plate renders in progress from a previous document
    if (_plateAbortCtrl) { _plateAbortCtrl.abort(); _plateAbortCtrl = null; }
    // Reset prepress tool toggle states
    state.showBoxes = false;
    boxesBtn.classList.remove('btn-active');
    state.oppMode = false;
    oppBtn.classList.remove('btn-active');
    oppBar.hidden = true;

    // Swap drop zone for canvas
    dropZone.hidden   = true;
    canvasWrap.hidden = false;

    // Enable toolbar controls
    [zoomInBtn, zoomOutBtn, zoomFitBtn, prevBtn, nextBtn, eyedropperBtn,
      oppBtn, boxesBtn, zoomPrintBtn].forEach(b => (b.disabled = false));

    await renderPage();

    const mb = state.pageBoxes?.MediaBox;
    const dimStr = mb
      ? `  ·  ${ptsToMm(mb[2] - mb[0])} × ${ptsToMm(mb[3] - mb[1])} mm`
      : '';
    setStatus(`${file.name}  ·  ${pdfDoc.numPages} page${pdfDoc.numPages !== 1 ? 's' : ''}${dimStr}`);
  } catch (err) {
    setStatus(`Error: ${err.message}`);
    console.error('Failed to open PDF:', err);
  } finally {
    // Always hide spinner — renderPage() hides it too, but this is the safety net
    showSpinner(false);
  }
}

// ── Page rendering ────────────────────────────────────────────────────────────
//
// Dual-intent cache design:
//   state.displayImageData — pixels rendered with intent:'display' (OPP OFF)
//   state.printImageData   — pixels rendered with intent:'print'   (OPP ON)
//
// The cache is keyed on page + scale.  When only the OPP toggle changes,
// the already-cached opposite render is used instantly without re-rendering.
//
// Two separate OCG configs are maintained (display + print) so that OPP mode
// shows the correct layer visibility without modifying the user's display config.
// See extractOCGUsageStates() / buildPrintOCGConfig() for how print states are
// extracted from the PDF's /Usage /Print /PrintState dictionaries.
//
async function renderPage() {
  if (!state.pdf) return;

  // Cancel any in-flight render so we don't get stale output
  if (state.renderTask) {
    try { state.renderTask.cancel(); } catch (_) {}
    state.renderTask = null;
  }

  // Abort any in-progress background plate renders — they belong to the previous
  // page/zoom/mode and would produce stale data if allowed to complete.
  if (_plateAbortCtrl) { _plateAbortCtrl.abort(); _plateAbortCtrl = null; }

  showSpinner(true);
  densityTooltip.hidden = true;

  try {
    const page     = await state.pdf.getPage(state.currentPage);
    const viewport = page.getViewport({ scale: state.scale });
    const W = Math.round(viewport.width);
    const H = Math.round(viewport.height);

    state.currentPageObj = page;

    // Invalidate both cached renders (and plate cache) when page or scale changes
    const cacheKey = `${state.currentPage}@${state.scale}`;
    if (state._renderCacheKey !== cacheKey) {
      state.displayImageData    = null;
      state.printImageData      = null;
      state._renderCacheKey     = cacheKey;
      state.separationPlates    = null;
      state.separationPlatesKey = null;
    }

    // Which intent do we need, and which cache slot?
    const intent    = state.oppMode ? 'print' : 'display';
    const cacheSlot = state.oppMode ? 'printImageData' : 'displayImageData';

    if (!state[cacheSlot]) {
      // Render fresh for this intent
      const offscreen  = document.createElement('canvas');
      offscreen.width  = W;
      offscreen.height = H;
      const offCtx     = offscreen.getContext('2d');

      // Select the intent-specific OCG config:
      //   display → state.ocConfig       (document defaults + user layer toggles)
      //   print   → state.ocConfigPrint  (Usage-based print states, built from raw PDF)
      // Parsing print states explicitly is more reliable than relying on PDF.js's
      // incomplete AS-array intent switching when no config is supplied.
      const ocCfg = activeLayerConfig();
      state.renderTask = page.render({
        canvasContext: offCtx,
        viewport,
        intent,
        optionalContentConfigPromise: ocCfg ? Promise.resolve(ocCfg) : undefined,
      });

      await state.renderTask.promise;
      state.renderTask = null;

      state[cacheSlot] = offCtx.getImageData(0, 0, W, H);

      // Two-pass OPP indicator compositing: replace the orange "INCORRECT VIEW"
      // indicator with a solid View_G green — see compositeOPPIndicator() for details.
      if (cacheSlot === 'printImageData' && state.acvOCGId) {
        await compositeOPPIndicator(page, viewport, state.printImageData, W, H);
      }
    }

    // Use cached image data (raw PDF render, unmodified)
    state.originalImageData = state[cacheSlot];

    // Resize the visible canvas (this clears it) then draw filtered output
    canvas.width  = W;
    canvas.height = H;
    applySeparations();

    // Kick off per-OCG plate renders in the background.
    // When ready they call applySeparations() again with full multiply compositing.
    const plateKey = `${cacheKey}@${intent}`;
    if (state.separationPlatesKey !== plateKey) {
      schedulePlateRender(page, viewport, W, H, intent).catch(() => {});
    }

    // Redraw sample-point markers for the current page at the new dimensions
    renderMarks(W, H);
    // Post-render prepress hooks
    computeAndShowInkStats();
    drawBoxes(W, H);

    // Update page navigation controls
    pageInfo.textContent = `${state.currentPage} / ${state.totalPages}`;
    prevBtn.disabled     = state.currentPage <= 1;
    nextBtn.disabled     = state.currentPage >= state.totalPages;

  } catch (err) {
    if (err?.name === 'RenderingCancelledException') return;
    console.error('Render error:', err);
    setStatus(`Render error: ${err.message}`);
  } finally {
    showSpinner(false);
  }
}

// ── CMYK separation filter ────────────────────────────────────────────────────
//
// PDF.js renders to sRGB.  We approximate process-colour separations by
// converting each pixel RGB→CMYK (naïve formula), zeroing disabled channels,
// then converting CMYK→RGB back for display.
//
// In OPP mode, state.originalImageData is the PDF.js print-intent render that
// has already been post-processed by compositeOPPIndicator(): the AcrobatViewCheck
// indicator was replaced with a canvas-drawn "OK ADOBE ACROBAT VIEW CHECK" green
// indicator via a three-pass pixel diff + text overlay.
// No further pixel manipulation is applied here for the OPP render.
//
function applySeparations() {
  if (!state.originalImageData) return;

  const W = state.originalImageData.width;
  const H = state.originalImageData.height;

  // ── Preferred path: per-OCG plate compositing ──────────────────────────────
  // When all plate renders are ready, composite them using multiply blend.
  // This correctly simulates ink overprinting for any combination of enabled
  // separations — far more accurate than single-render channel extraction.
  if (state.separationPlates) {
    const imageData = compositeFromPlates(W, H);
    if (imageData) { ctx.putImageData(imageData, 0, 0); return; }
  }

  // ── Fallback: single-render channel extraction + vector masking ─────────────
  // Used while plate renders are in progress (shows immediately on page load).
  const { c, m, y, k } = state.separations;

  // Fast path: all channels enabled, all spots on — blit source directly.
  // Works for both display and print (OPP) renders without any pixel work.
  if (c && m && y && k && state.spotColors.every(s => s.enabled)) {
    ctx.putImageData(state.originalImageData, 0, 0);
    return;
  }

  const src = state.originalImageData.data;   // Uint8ClampedArray (read-only)
  const out = new Uint8ClampedArray(src.length);

  for (let i = 0; i < src.length; i += 4) {
    const rn = src[i]     / 255;
    const gn = src[i + 1] / 255;
    const bn = src[i + 2] / 255;

    // RGB → CMYK (naïve, no ICC profile)
    const kv = 1 - Math.max(rn, gn, bn);
    let cv, mv, yv;
    if (kv < 1) {
      const d = 1 - kv;
      cv = (1 - rn - kv) / d;
      mv = (1 - gn - kv) / d;
      yv = (1 - bn - kv) / d;
    } else {
      cv = mv = yv = 0; // pure black pixel
    }

    // Channel masking — same logic for both display and OPP renders
    const fc = c ? cv : 0;
    const fm = m ? mv : 0;
    const fy = y ? yv : 0;
    const fk = k ? kv : 0;

    // CMYK → RGB
    const inv    = 1 - fk;
    out[i]     = 255 * (1 - fc) * inv;
    out[i + 1] = 255 * (1 - fm) * inv;
    out[i + 2] = 255 * (1 - fy) * inv;
    out[i + 3] = src[i + 3];  // preserve alpha
  }

  // Spot colour masking — directional vector projection.
  // Pixels that lie in the direction of a disabled spot ink are masked to paper white.
  for (const spot of state.spotColors) {
    if (!spot.enabled) maskSpotColor(out, spot.rgb);
  }

  ctx.putImageData(
    new ImageData(out, state.originalImageData.width, state.originalImageData.height),
    0, 0,
  );
}

// ── Separation All / None buttons ─────────────────────────────────────────────
// Per-channel change listeners are added dynamically in buildSeparationsPanel().
$('sep-all').addEventListener('click', () => {
  ['c', 'm', 'y', 'k'].forEach(ch => { state.separations[ch] = true; });
  state.spotColors.forEach(s => { s.enabled = true; });
  $('sep-list').querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = true; });
  applySeparations();
});

$('sep-none').addEventListener('click', () => {
  ['c', 'm', 'y', 'k'].forEach(ch => { state.separations[ch] = false; });
  state.spotColors.forEach(s => { s.enabled = false; });
  $('sep-list').querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = false; });
  applySeparations();
});

// ── Layers / Optional Content Groups (OCGs) ───────────────────────────────────
function buildLayersPanel() {
  layersList.innerHTML = '';

  let groups = null;
  if (state.ocConfig) {
    try { groups = state.ocConfig.getGroups(); } catch (_) {}
  }

  if (!groups || Object.keys(groups).length === 0) {
    layersList.innerHTML = '<p class="empty-hint">No layers in this document</p>';
    return;
  }

  for (const [id, group] of Object.entries(groups)) {
    const label = document.createElement('label');
    label.className = 'layer-row';

    const cb = document.createElement('input');
    cb.type    = 'checkbox';
    cb.checked = group.visible !== false;
    cb.addEventListener('change', () => {
      setLayerVisibility(id, cb.checked);
      invalidateLayerRenders();
      renderPage();
    });

    const nameSpan = document.createElement('span');
    nameSpan.className   = 'layer-name';
    nameSpan.textContent = group.name || `Layer ${id}`;
    nameSpan.title       = group.name || `Layer ${id}`;

    label.append(cb, nameSpan);
    layersList.appendChild(label);
  }
}

$('layer-all').addEventListener('click',  () => setAllLayers(true));
$('layer-none').addEventListener('click', () => setAllLayers(false));

// Applies a layer toggle to every config the viewer renders from, so it holds
// in both normal and OPP mode.  ocConfigPrintNoACV keeps the ACV OCG off: it
// exists to render the page without the indicator.
function setLayerVisibility(id, visible) {
  for (const cfg of [state.ocConfig, state.ocConfigPrint, state.ocConfigPrintNoACV]) {
    if (!cfg || (cfg === state.ocConfigPrintNoACV && id === state.acvOCGId)) continue;
    try { cfg.setVisibility(id, visible); } catch (e) {
      console.warn('setVisibility failed:', e);
    }
  }
}

// Drops every cached render that depends on layer visibility.  With the plates
// gone, applySeparations() uses the fresh single render until new plates land.
function invalidateLayerRenders() {
  state.displayImageData    = null;
  state.printImageData      = null;
  state.separationPlates    = null;
  state.separationPlatesKey = null;
}

// The OCG config for the current mode: print states in OPP when the document
// has them, otherwise the document defaults.  Both include user layer toggles.
function activeLayerConfig() {
  return state.oppMode ? (state.ocConfigPrint || state.ocConfig) : state.ocConfig;
}

function isLayerVisible(id) {
  const groups = activeLayerConfig()?.getGroups();
  return groups?.[id]?.visible !== false;
}

function setAllLayers(visible) {
  if (!state.ocConfig) return;
  let groups;
  try { groups = state.ocConfig.getGroups(); } catch (_) { return; }
  if (!groups) return;
  for (const id of Object.keys(groups)) setLayerVisibility(id, visible);
  layersList.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = visible; });
  invalidateLayerRenders();
  renderPage();
}

// ── Page navigation ───────────────────────────────────────────────────────────
prevBtn.addEventListener('click', () => {
  if (state.currentPage > 1) { state.currentPage--; renderPage(); }
});
nextBtn.addEventListener('click', () => {
  if (state.currentPage < state.totalPages) { state.currentPage++; renderPage(); }
});

// ── Zoom controls ─────────────────────────────────────────────────────────────
zoomInBtn.addEventListener('click',  () => zoomStep(+1));
zoomOutBtn.addEventListener('click', () => zoomStep(-1));

zoomFitBtn.addEventListener('click', () => {
  if (!state.pdf) return;
  state.pdf.getPage(state.currentPage).then(page => {
    const baseVp  = page.getViewport({ scale: 1 });
    const padding = 48; // 2 × canvas-wrap padding
    const scale   = (canvasArea.clientWidth - padding) / baseVp.width;
    applyZoom(Math.max(0.1, Math.round(scale * 100) / 100));
  });
});

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.target.matches('input, select, textarea')) return; // ignore form fields

  switch (e.key) {
    case 'ArrowLeft':
    case 'PageUp':
      prevBtn.click(); e.preventDefault(); break;

    case 'ArrowRight':
    case 'PageDown':
      nextBtn.click(); e.preventDefault(); break;

    case '+': case '=':
      zoomStep(+1); e.preventDefault(); break;

    case '-': case '_':
      zoomStep(-1); e.preventDefault(); break;

    case '0':
      applyZoom(1); e.preventDefault(); break;

    case 'f': case 'F':
      zoomFitBtn.click(); e.preventDefault(); break;

    case 'd': case 'D':
      if (!eyedropperBtn.disabled) eyedropperBtn.click();
      e.preventDefault(); break;

    case 'o': case 'O':
      if (!oppBtn.disabled) oppBtn.click();
      e.preventDefault(); break;

    case 'b': case 'B':
      if (!boxesBtn.disabled) boxesBtn.click();
      e.preventDefault(); break;

    case 'p': case 'P':
      if (!zoomPrintBtn.disabled) applyPrintZoom();
      e.preventDefault(); break;
  }
});

// ── Eyedropper tool ───────────────────────────────────────────────────────────

eyedropperBtn.addEventListener('click', () => {
  eyedropperActive = !eyedropperActive;
  eyedropperBtn.classList.toggle('btn-active', eyedropperActive);
  canvasArea.classList.toggle('eyedropper-active', eyedropperActive);
  if (!eyedropperActive) densityTooltip.hidden = true;
});

// Live readout as the mouse moves over the canvas
canvas.addEventListener('mousemove', e => {
  if (!eyedropperActive || !state.originalImageData) return;
  const cmyk = samplePixel(e);
  if (cmyk) showDensityTooltip(e, cmyk);
});

// Hide tooltip when cursor leaves the canvas
canvas.addEventListener('mouseleave', () => {
  if (eyedropperActive) densityTooltip.hidden = true;
});

/**
 * Read the pixel under the cursor from originalImageData (pre-filter).
 * Returns approximate CMYK ink densities (0–100 integer %) plus the
 * canvas pixel coordinates of the sampled point.
 */
function samplePixel(e) {
  const rect   = canvas.getBoundingClientRect();
  // Map CSS pixels → canvas pixels (accounts for zoom-induced canvas scaling)
  const scaleX = canvas.width  / rect.width;
  const scaleY = canvas.height / rect.height;
  const x = Math.round((e.clientX - rect.left) * scaleX);
  const y = Math.round((e.clientY - rect.top)  * scaleY);

  if (x < 0 || y < 0 || x >= state.originalImageData.width || y >= state.originalImageData.height) return null;

  const d   = state.originalImageData.data;
  const idx = (y * state.originalImageData.width + x) * 4;
  // Also return canvas pixel coords so the click handler can store them
  return { ...rgbToCmykPct(d[idx], d[idx + 1], d[idx + 2]), canvasX: x, canvasY: y };
}

/**
 * Convert sRGB (0–255 each) to approximate CMYK ink densities (0–100 integer %).
 * Uses the standard naïve formula — same model as the separation filter so
 * readings are consistent with what the operator sees on screen.
 */
function rgbToCmykPct(r, g, b) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const k  = 1 - Math.max(rn, gn, bn);

  if (k >= 1) return { c: 0, m: 0, y: 0, k: 100, r, g, b };

  const d = 1 - k;
  return {
    c: Math.round(((1 - rn - k) / d) * 100),
    m: Math.round(((1 - gn - k) / d) * 100),
    y: Math.round(((1 - bn - k) / d) * 100),
    k: Math.round(k * 100),
    r, g, b,
  };
}

/** Update and position the floating density tooltip. */
function showDensityTooltip(e, cmyk) {
  // Position near cursor; flip left/up if near the viewport edge
  const PAD = 16, W = 192, H = 160;
  let left = e.clientX + PAD;
  let top  = e.clientY + PAD;
  if (left + W > window.innerWidth)  left = e.clientX - W - PAD;
  if (top  + H > window.innerHeight) top  = e.clientY - H - PAD;
  densityTooltip.style.left = `${left}px`;
  densityTooltip.style.top  = `${top}px`;

  // Sampled colour swatch
  dtSwatch.style.background = `rgb(${cmyk.r},${cmyk.g},${cmyk.b})`;

  // Channel bars + percentages
  for (const ch of ['c', 'm', 'y', 'k']) {
    const pct = cmyk[ch];
    $(`dt-${ch}`).textContent      = `${pct}%`;
    $(`dt-fill-${ch}`).style.width = `${pct}%`;
  }

  // TAC — Total Area Coverage (sum of all four ink densities)
  $('dt-tac').textContent = `${cmyk.c + cmyk.m + cmyk.y + cmyk.k}%`;

  densityTooltip.hidden = false;
}

// ── Sample points: click to pin a measurement ─────────────────────────────────

// Click on the canvas while eyedropper is active → add a pinned sample point
canvas.addEventListener('click', e => {
  if (!eyedropperActive || !state.originalImageData) return;

  const sampled = samplePixel(e);
  if (!sampled) return;

  const { canvasX, canvasY, ...cmyk } = sampled;

  const sample = {
    id:    state.nextSampleId++,
    page:  state.currentPage,
    // Store position in PDF page units so it survives zoom changes
    pageX: canvasX / state.scale,
    pageY: canvasY / state.scale,
    cmyk,
  };

  state.samples.push(sample);
  renderMarks(canvas.width, canvas.height);
  buildSamplesPanel();
});

// Clear-all button in the samples panel
$('clear-samples').addEventListener('click', () => {
  state.samples      = [];
  state.nextSampleId = 1;
  renderMarks(canvas.width, canvas.height);
  buildSamplesPanel();
});

// ── SVG mark rendering ────────────────────────────────────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg';

/** (Re)draw all marks for the current page onto the SVG overlay. */
function renderMarks(W, H) {
  // Size the SVG to match canvas pixel dimensions so coordinates are 1 : 1
  marksOverlay.setAttribute('width',   W);
  marksOverlay.setAttribute('height',  H);
  marksOverlay.setAttribute('viewBox', `0 0 ${W} ${H}`);
  marksOverlay.innerHTML = ''; // clear previous

  for (const s of state.samples) {
    if (s.page !== state.currentPage) continue;
    // Convert stored PDF-unit coordinates back to canvas pixels at current scale
    const x = Math.round(s.pageX * state.scale);
    const y = Math.round(s.pageY * state.scale);
    marksOverlay.appendChild(buildMarkEl(s.id, x, y));
  }
}

/** Build one SVG <g> element: a cross + numbered badge. */
function buildMarkEl(id, x, y) {
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('transform', `translate(${x},${y})`);

  // Helper to create a line
  const line = (x1, y1, x2, y2, stroke, sw) => {
    const l = document.createElementNS(SVG_NS, 'line');
    Object.entries({ x1, y1, x2, y2, stroke, 'stroke-width': sw }).forEach(([k, v]) => l.setAttribute(k, v));
    return l;
  };

  // Cross — dark outline then white fill for contrast on any background
  g.append(
    line(-9, 0, 9, 0,  'rgba(0,0,0,0.65)', 3),
    line(0, -9, 0,  9, 'rgba(0,0,0,0.65)', 3),
    line(-9, 0, 9, 0,  '#fff', 1.5),
    line(0, -9, 0,  9, '#fff', 1.5),
  );

  // Badge circle
  const circle = document.createElementNS(SVG_NS, 'circle');
  Object.entries({ cx: 10, cy: -10, r: 8, fill: '#4dabf7', stroke: 'rgba(0,0,0,0.25)', 'stroke-width': 0.5 })
    .forEach(([k, v]) => circle.setAttribute(k, v));
  g.appendChild(circle);

  // Badge number
  const text = document.createElementNS(SVG_NS, 'text');
  Object.entries({
    x: 10, y: -10,
    'text-anchor': 'middle',
    'dominant-baseline': 'central',
    'font-family': 'sans-serif',
    'font-size':   id >= 10 ? 6.5 : 8,
    'font-weight': 'bold',
    fill: '#fff',
  }).forEach(([k, v]) => text.setAttribute(k, v));
  text.textContent = id;
  g.appendChild(text);

  return g;
}

// ── Samples panel list ────────────────────────────────────────────────────────

/** Rebuild the right-panel list from state.samples. */
function buildSamplesPanel() {
  samplesList.innerHTML = '';

  if (state.samples.length === 0) {
    samplesList.innerHTML =
      '<p class="empty-hint">Eyedropper active — click on the PDF to sample ink density at that point.</p>';
    return;
  }

  for (const s of state.samples) {
    const tac = s.cmyk.c + s.cmyk.m + s.cmyk.y + s.cmyk.k;

    const item = document.createElement('div');
    item.className = 'sample-item';

    // ── Header row: badge · swatch · page label · delete button ──
    const header = document.createElement('div');
    header.className = 'sample-header';

    const badge = document.createElement('div');
    badge.className   = 'sample-badge';
    badge.textContent = s.id;

    const swatch = document.createElement('div');
    swatch.className        = 'sample-swatch';
    swatch.style.background = `rgb(${s.cmyk.r},${s.cmyk.g},${s.cmyk.b})`;

    const pageLabel = document.createElement('span');
    pageLabel.className   = 'sample-page';
    pageLabel.textContent = `p.${s.page}`;

    const delBtn = document.createElement('button');
    delBtn.className = 'sample-del';
    delBtn.title     = 'Remove this sample';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', () => deleteSample(s.id));

    header.append(badge, swatch, pageLabel, delBtn);

    // ── Value rows: C / M / Y / K + TAC ──
    const rows = document.createElement('div');
    rows.className = 'sv-rows';

    for (const [ch, label] of [['c','C'],['m','M'],['y','Y'],['k','K']]) {
      const pct = s.cmyk[ch];
      const row = document.createElement('div');
      row.className = 'sv-row';
      row.innerHTML = `
        <span class="sv-ch sv-${ch}">${label}</span>
        <div class="sv-bar-track"><div class="sv-bar-fill sv-bar-${ch}" style="width:${pct}%"></div></div>
        <span class="sv-pct">${pct}%</span>`;
      rows.appendChild(row);
    }

    const tacRow = document.createElement('div');
    tacRow.className = 'sv-row sv-tac';
    tacRow.innerHTML = `<span class="sv-tac-label">TAC</span><span class="sv-pct">${tac}%</span>`;
    rows.appendChild(tacRow);

    item.append(header, rows);
    samplesList.appendChild(item);
  }
}

/** Remove a single sample by id; refresh overlay and panel. */
function deleteSample(id) {
  state.samples = state.samples.filter(s => s.id !== id);
  renderMarks(canvas.width, canvas.height);
  buildSamplesPanel();
}

// ── Prepress: pt ↔ mm conversion ─────────────────────────────────────────────
const PT_TO_MM = 25.4 / 72;
function ptsToMm(pts) { return (Math.round(pts * PT_TO_MM * 10) / 10).toFixed(1); }

// ── Prepress: page box extraction from raw PDF bytes ─────────────────────────
//
// Scans the raw PDF bytes for page box arrays using a simple regex.
// Works for the common case where boxes appear literally in the page dictionary
// (covers ≥ 90 % of standard prepress / packaging PDFs).
// Does NOT follow indirect object references.
//
function extractPageBoxes(uint8Array) {
  // Decode as Latin-1 so binary content doesn't mangle ASCII sequences
  const text = new TextDecoder('latin1').decode(uint8Array);

  function parseBox(name) {
    const re = new RegExp(
      `/${name}\\s*\\[\\s*([+-]?[\\d.]+)\\s+([+-]?[\\d.]+)\\s+([+-]?[\\d.]+)\\s+([+-]?[\\d.]+)\\s*\\]`
    );
    const m = text.match(re);
    return m
      ? [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), parseFloat(m[4])]
      : null;
  }

  return {
    MediaBox: parseBox('MediaBox'),
    CropBox:  parseBox('CropBox'),
    TrimBox:  parseBox('TrimBox'),
    BleedBox: parseBox('BleedBox'),
    ArtBox:   parseBox('ArtBox'),
  };
}

// ── Prepress: page box overlay ────────────────────────────────────────────────
const BOX_STYLES = {
  TrimBox:  { color: '#4dabf7', dash: null,    strokeW: 1.5, label: 'Trim'  },
  BleedBox: { color: '#ff6b6b', dash: '5 3',   strokeW: 1.5, label: 'Bleed' },
  ArtBox:   { color: '#69db7c', dash: '3 3',   strokeW: 1,   label: 'Art'   },
  CropBox:  { color: '#ffd43b', dash: '6 2 2', strokeW: 1,   label: 'Crop'  },
};

function drawBoxes(W, H) {
  boxesOverlay.setAttribute('width',   W);
  boxesOverlay.setAttribute('height',  H);
  boxesOverlay.setAttribute('viewBox', `0 0 ${W} ${H}`);
  boxesOverlay.innerHTML = '';

  if (!state.showBoxes || !state.pageBoxes || !state.currentPageObj) return;

  // page.view = [x, y, x2, y2] in PDF coordinate space (origin bottom-left)
  const [vx, vy, vx2, vy2] = state.currentPageObj.view;
  const viewH = vy2 - vy;
  const sc    = state.scale;

  // Convert a PDF box [bx1,by1,bx2,by2] → canvas pixel rect
  // PDF Y is bottom-up; canvas Y is top-down → flip: canvas_y = viewH - pdf_y
  function toCanvas(box) {
    if (!box) return null;
    const [bx1, by1, bx2, by2] = box;
    return {
      x: (bx1 - vx) * sc,
      y: (viewH - (by2 - vy)) * sc,
      w: (bx2 - bx1) * sc,
      h: (by2 - by1) * sc,
    };
  }

  for (const [name, style] of Object.entries(BOX_STYLES)) {
    const box = state.pageBoxes[name];
    if (!box) continue;
    const r = toCanvas(box);
    if (!r || r.w <= 0 || r.h <= 0) continue;

    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x',            r.x.toFixed(1));
    rect.setAttribute('y',            r.y.toFixed(1));
    rect.setAttribute('width',        r.w.toFixed(1));
    rect.setAttribute('height',       r.h.toFixed(1));
    rect.setAttribute('fill',         'none');
    rect.setAttribute('stroke',       style.color);
    rect.setAttribute('stroke-width', style.strokeW);
    if (style.dash) rect.setAttribute('stroke-dasharray', style.dash);

    // Dimension label showing box name + size in mm
    const mmW  = ptsToMm(box[2] - box[0]);
    const mmH  = ptsToMm(box[3] - box[1]);
    const lx   = r.x + 4;
    const ly   = r.y > 14 ? r.y - 3 : r.y + 12; // flip above/below if near top
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x',           lx.toFixed(1));
    text.setAttribute('y',           ly.toFixed(1));
    text.setAttribute('font-size',   '9');
    text.setAttribute('fill',        style.color);
    text.setAttribute('font-family', 'monospace');
    text.textContent = `${style.label}  ${mmW}×${mmH}mm`;

    boxesOverlay.append(rect, text);
  }
}

// ── Prepress: ink coverage statistics ────────────────────────────────────────
const TAC_LIMIT = 300; // Total Area Coverage warning threshold (%)

function computeAndShowInkStats() {
  if (!state.originalImageData) { state.inkStats = null; buildInkStatsPanel(); return; }

  const d    = state.originalImageData.data;
  const STEP = 4; // sample every 4th pixel (1/16 of data) for speed
  let sumC = 0, sumM = 0, sumY = 0, sumK = 0;
  let maxTAC = 0, tacOver = 0, count = 0;

  for (let i = 0; i < d.length; i += 4 * STEP) {
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    const k = 1 - Math.max(r, g, b);
    let c = 0, m = 0, y = 0;
    if (k < 1) {
      const den = 1 - k;
      c = (1 - r - k) / den;
      m = (1 - g - k) / den;
      y = (1 - b - k) / den;
    }
    sumC += c; sumM += m; sumY += y; sumK += k;
    const tac = (c + m + y + k) * 100;
    if (tac > maxTAC) maxTAC = tac;
    if (tac > TAC_LIMIT) tacOver++;
    count++;
  }

  state.inkStats = count ? {
    avgC:       Math.round(sumC / count * 100),
    avgM:       Math.round(sumM / count * 100),
    avgY:       Math.round(sumY / count * 100),
    avgK:       Math.round(sumK / count * 100),
    maxTAC:     Math.round(maxTAC),
    tacOverPct: +(tacOver / count * 100).toFixed(1),
  } : null;

  buildInkStatsPanel();
}

function buildInkStatsPanel() {
  if (!state.inkStats) {
    inkStatsEl.innerHTML = '<p class="empty-hint">Open a PDF to see coverage.</p>';
    tacBadge.hidden = true;
    return;
  }

  const s    = state.inkStats;
  const warn = s.maxTAC > TAC_LIMIT;

  tacBadge.textContent = warn ? `TAC ${s.maxTAC}%` : '';
  tacBadge.hidden      = !warn;
  tacBadge.className   = 'tac-badge' + (warn ? ' tac-badge-warn' : '');

  const channels = [
    { ch: 'c', label: 'C', avg: s.avgC },
    { ch: 'm', label: 'M', avg: s.avgM },
    { ch: 'y', label: 'Y', avg: s.avgY },
    { ch: 'k', label: 'K', avg: s.avgK },
  ];

  let html = '<div class="ink-ch-rows">';
  for (const { ch, label, avg } of channels) {
    html += `
      <div class="ink-ch-row">
        <span class="ink-ch-label sv-${ch}">${label}</span>
        <div class="ink-ch-track"><div class="ink-ch-fill sv-bar-${ch}" style="width:${Math.min(avg, 100)}%"></div></div>
        <span class="ink-ch-pct">${avg}%</span>
      </div>`;
  }
  html += '</div>';

  const tacAvg = s.avgC + s.avgM + s.avgY + s.avgK;
  const tacCls = s.maxTAC > TAC_LIMIT ? ' tac-warn' : '';
  html += `
    <div class="ink-tac-block${tacCls}">
      <div class="ink-tac-row"><span>TAC avg</span><strong>${tacAvg}%</strong></div>
      <div class="ink-tac-row"><span>TAC max</span><strong>${s.maxTAC}%</strong></div>
      ${s.tacOverPct > 0
        ? `<div class="ink-tac-row ink-tac-over"><span>Area &gt; ${TAC_LIMIT}%</span><strong>${s.tacOverPct}%</strong></div>`
        : ''}
    </div>`;

  inkStatsEl.innerHTML = html;
}

// ── Prepress: print-size zoom ─────────────────────────────────────────────────
// Scale the page so that 1 PDF point = 1/72 inch = 1 CSS pixel at 96 CSS DPI.
// 96 CSS px/inch ÷ 72 pt/inch ≈ 1.333 — the page renders at actual print size.
function applyPrintZoom() {
  const scale = Math.round((96 / 72) * 1000) / 1000;
  applyZoom(scale);
}

// ── Overprint Preview toggle ───────────────────────────────────────────────────
//
// When toggling OPP:
//  1. Update UI state immediately.
//  2. Drop the separation plates: they belong to the previous intent.
//  3. renderPage() reuses the cached render for this intent if there is one, so
//     the swap stays instant, then rebuilds the plates in the background.
//
oppBtn.addEventListener('click', async () => {
  state.oppMode = !state.oppMode;
  oppBtn.classList.toggle('btn-active', state.oppMode);
  oppBar.hidden = !state.oppMode;

  state.separationPlates    = null;
  state.separationPlatesKey = null;
  await renderPage();
});

// ── Boxes overlay toggle ──────────────────────────────────────────────────────
boxesBtn.addEventListener('click', () => {
  state.showBoxes = !state.showBoxes;
  boxesBtn.classList.toggle('btn-active', state.showBoxes);
  drawBoxes(canvas.width, canvas.height);
});

// ── Print-size zoom button ────────────────────────────────────────────────────
zoomPrintBtn.addEventListener('click', applyPrintZoom);

// ── Spot colour extraction from raw PDF bytes ─────────────────────────────────
//
// Scans for /Separation and /DeviceN colour spaces using the same raw-byte
// approach as extractPageBoxes().  Covers the vast majority of prepress PDFs
// including complex packaging files with 10+ custom inks.
//
// Standard PDF process-colour aliases that should NOT appear in the panel:
const SEP_STANDARD = new Set(['All', 'None', 'Black', 'Cyan', 'Magenta', 'Yellow']);

function extractSpotColors(uint8Array) {
  const text  = new TextDecoder('latin1').decode(uint8Array);
  const names = new Set();

  // /Separation /Name ...  or  /Separation (Name with spaces) ...
  for (const m of text.matchAll(/\/Separation\s+(?:\/([A-Za-z0-9_.+\-]+)|\(([^)]+)\))/g))
    names.add(m[1] ?? m[2]);

  // /DeviceN [/Name1 /Name2 ...]  — extract every name from the array
  for (const m of text.matchAll(/\/DeviceN\s*\[([^\]]+)\]/g))
    for (const n of m[1].matchAll(/\/([A-Za-z0-9_.+\-]+)/g))
      names.add(n[1]);

  return [...names]
    .filter(n => !SEP_STANDARD.has(n))
    .map(name => ({ name, rgb: spotNameToRgb(name), enabled: true }));
}

// Known approximate sRGB values for common prepress spot colour conventions
const SPOT_KNOWN_RGB = {
  // Pantone abbreviations (P### or P###C)
  P485: [214,  43,  43],  P485C: [214,  43,  43],  // Pantone 485  — red
  P431: [108, 122, 137],  P431C: [108, 122, 137],  // Pantone 431  — cool grey
  P286: [  0,  61, 165],  P286C: [  0,  61, 165],  // Pantone 286  — blue
  P032: [239,  51,  64],  P032C: [239,  51,  64],  // Pantone 032  — warm red
  P021: [255, 102,   0],  P021C: [255, 102,   0],  // Pantone 021  — orange
  P355: [  0, 168,  89],  P355C: [  0, 168,  89],  // Pantone 355  — green
  P109: [255, 209,   0],  P109C: [255, 209,   0],  // Pantone 109  — yellow
  // OPP test-marker inks (common SIG/packaging convention)
  View_O: [232,  99,  10],  // orange → "INCORRECT VIEW"
  View_G: [ 45, 140,  78],  // green  → "OK"
  View_K: [ 30,  30,  30],  // near-black key
  View_W: [255, 255, 255],  // white (will be skipped in masking — len < 10)
  // Structural / die-cut layers
  kontur: [200,   0, 200],  // magenta-like — common for die-cut outlines
};

function hslToRgb(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = n => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

function spotNameToRgb(name) {
  if (SPOT_KNOWN_RGB[name]) return SPOT_KNOWN_RGB[name];
  // Deterministic hue from name hash — gives each unknown ink a distinct colour
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = Math.imul(hash * 31 + name.charCodeAt(i), 1) | 0;
  return hslToRgb(((hash >>> 0) % 360), 0.78, 0.46);
}

// ── Dynamic separations panel ─────────────────────────────────────────────────

const PROCESS_CHANNELS = [
  { id: 'c', label: 'Cyan',    cls: 'swatch-c' },
  { id: 'm', label: 'Magenta', cls: 'swatch-m' },
  { id: 'y', label: 'Yellow',  cls: 'swatch-y' },
  { id: 'k', label: 'Black',   cls: 'swatch-k' },
];

/** Rebuild the full sep-list: 4 CMYK rows + all spot colour rows. */
function buildSeparationsPanel() {
  const list = $('sep-list');
  list.innerHTML = '';

  // Process colours (always present)
  for (const { id, label, cls } of PROCESS_CHANNELS) {
    list.appendChild(makeSepRow(
      `sep-${id}`, label, null, cls,
      state.separations[id],
      checked => { state.separations[id] = checked; applySeparations(); },
    ));
  }

  // Spot colours (from current PDF — empty if no PDF loaded)
  if (state.spotColors.length > 0) {
    const divider = document.createElement('li');
    divider.className = 'sep-divider';
    list.appendChild(divider);

    for (const spot of state.spotColors) {
      const [r, g, b] = spot.rgb;
      const safeId = `sep-spot-${CSS.escape(spot.name)}`;
      list.appendChild(makeSepRow(
        safeId, spot.name, `rgb(${r},${g},${b})`, null,
        spot.enabled,
        checked => { spot.enabled = checked; applySeparations(); },
      ));
    }
  }
}

function makeSepRow(id, label, color, swatchCls, checked, onChange) {
  const li  = document.createElement('li');
  li.className = 'sep-item';

  const lbl = document.createElement('label');
  lbl.className = 'sep-label';

  const cb  = document.createElement('input');
  cb.type    = 'checkbox';
  cb.id      = id;
  cb.checked = checked;
  cb.addEventListener('change', e => onChange(e.target.checked));

  const sw  = document.createElement('span');
  sw.className = 'swatch' + (swatchCls ? ` ${swatchCls}` : '');
  if (color) sw.style.background = color;
  if (!swatchCls && !color) sw.classList.add('swatch-spot-unknown');

  const nm  = document.createElement('span');
  nm.className   = 'sep-name';
  nm.textContent = label;

  lbl.append(cb, sw, nm);
  li.appendChild(lbl);
  return li;
}

// ── Spot colour pixel masking ─────────────────────────────────────────────────
//
// Directional vector projection: for a disabled spot colour with approximate
// sRGB (r₀,g₀,b₀), we find the unit vector from paper-white (255,255,255)
// toward that colour.  Any pixel that lies within a 35° cone of that direction
// AND has a non-trivial distance from white is masked to paper white.
//
// This handles 100% tint AND lighter tints, works well for flat packaging
// areas, and is an approximation (may leave artefacts where spot inks overlap).
//
const _COS35 = Math.cos(35 * Math.PI / 180);

function maskSpotColor(out, rgb) {
  const [r0, g0, b0] = rgb;
  const dr = r0 - 255, dg = g0 - 255, db = b0 - 255;
  const len = Math.sqrt(dr * dr + dg * dg + db * db);
  if (len < 10) return;  // too close to white (e.g. View_W) — unmaskable
  const nx = dr / len, ny = dg / len, nz = db / len;
  const minProj = len * 0.06;  // ignore pixels below ~6% tint

  for (let i = 0; i < out.length; i += 4) {
    const pr = out[i] - 255, pg = out[i + 1] - 255, pb = out[i + 2] - 255;
    const pl = Math.sqrt(pr * pr + pg * pg + pb * pb);
    if (pl < minProj) continue;
    const cos = (pr * nx + pg * ny + pb * nz) / pl;
    if (cos >= _COS35) { out[i] = out[i + 1] = out[i + 2] = 255; }
  }
}

// ── OPP: extract per-OCG print-intent visibility from raw PDF bytes ───────────
//
// PDF OCGs (Optional Content Groups) can declare intent-specific visibility
// via a /Usage dictionary, e.g.:
//
//   << /Type /OCG /Name /View_O
//      /Usage << /View  << /ViewState  /ON  >>
//               /Print << /PrintState /OFF >> >> >>
//
// This function scans for those /Usage /Print /PrintState entries so we can
// build an OCG config that correctly shows the "OK" (green) and hides the
// "INCORRECT VIEW" (orange) marker when OPP / print intent is active.
//
// Returns a Map<name, boolean>  (true = visible in print, false = hidden).
//
function extractOCGUsageStates(uint8Array) {
  const text   = new TextDecoder('latin1').decode(uint8Array);
  const states = new Map();
  const ocgRe  = /\/Type\s*\/OCG\b/g;
  let m;

  while ((m = ocgRe.exec(text)) !== null) {
    // Scan ±600 bytes around /Type /OCG to find /Name and /Usage in the same object
    const chunk = text.slice(Math.max(0, m.index - 400), m.index + 600);

    const nameM = chunk.match(/\/Name\s*(?:\/([A-Za-z0-9_.+\-]+)|\(([^)]+)\))/);
    if (!nameM) continue;
    const name = nameM[1] ?? nameM[2];

    // /Print << /PrintState /ON|OFF >>  (allow embedded whitespace / newlines)
    const psM = chunk.match(/\/Print\s*<<[\s\S]{0,150}?\/PrintState\s*\/(ON|OFF)/);
    if (psM) states.set(name, psM[1] === 'ON');
  }

  return states;
}

// Two-pass OPP indicator compositing.
//
// Problem: PDF.js ignores the OP (overprint) flag.  Inside the AcrobatViewCheck
// OCG the drawing order is:
//   ① View_G  (green, OP=off)  — the "OK" background rect
//   ② View_K  (dark,  OP=on)   — "OK ADOBE ACROBAT VIEW CHECK" text
//   ③ View_O  (orange,OP=on)   — same rect ON TOP, knocks out ①+② in PDF.js
//   ④ View_W  (CMYK=0,OP=on)   — "INCORRECT VIEW CHECK" white text over ③
// Without overprint simulation PDF.js shows: orange "INCORRECT VIEW CHECK".
//
// Fix (three passes):
//   1. Render again with the AcrobatViewCheck OCG turned OFF  → no indicator.
//   2. Diff the two renders: differing pixels belong to the indicator region.
//      Find bounding box of all differing pixels.
//   3. Draw the correct "OK / ADOBE ACROBAT VIEW CHECK" indicator onto a
//      temporary canvas (View_G green background, View_K dark text), then
//      blit only the diff pixels from that canvas into printImgData.
// Result: green "OK ADOBE ACROBAT VIEW CHECK" indicator in OPP mode.
//
async function compositeOPPIndicator(page, viewport, printImgData, W, H) {
  if (!state.ocConfigPrintNoACV) return;

  // Pass 2: render without the AcrobatViewCheck OCG.
  let noAcvData;
  try {
    const off2  = document.createElement('canvas');
    off2.width  = W;
    off2.height = H;
    const ctx2  = off2.getContext('2d');
    await page.render({
      canvasContext: ctx2,
      viewport,
      intent: 'print',
      optionalContentConfigPromise: Promise.resolve(state.ocConfigPrintNoACV),
    }).promise;
    noAcvData = ctx2.getImageData(0, 0, W, H);
  } catch (_) {
    return;  // second render failed — leave original orange indicator as-is
  }

  // View_G / View_K colours: prefer values parsed from the document's spot
  // colour list (state.spotColors); fall back to SPOT_KNOWN_RGB defaults.
  const vgSpot = state.spotColors.find(s => s.name === 'View_G');
  const [vgR, vgG, vgB] = vgSpot ? vgSpot.rgb : [45, 140, 78];
  const vkSpot = state.spotColors.find(s => s.name === 'View_K');
  const [vkR, vkG, vkB] = vkSpot ? vkSpot.rgb : [30, 30, 30];

  const p = printImgData.data;
  const n = noAcvData.data;

  // Pass 3a: locate the indicator bounding box from the pixel diff.
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let i = 0; i < p.length; i += 4) {
    if (p[i] !== n[i] || p[i + 1] !== n[i + 1] || p[i + 2] !== n[i + 2]) {
      const px = (i >> 2) % W;
      const py = Math.floor((i >> 2) / W);
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
  }
  if (maxX < 0) return;  // no differing pixels — nothing to do

  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;

  // Pass 3b: draw the correct indicator onto a temporary canvas.
  const tmp = document.createElement('canvas');
  tmp.width  = bw;
  tmp.height = bh;
  const tc = tmp.getContext('2d');

  // Green background
  tc.fillStyle = `rgb(${vgR},${vgG},${vgB})`;
  tc.fillRect(0, 0, bw, bh);

  // Dark text — "OK" large, "ADOBE ACROBAT VIEW CHECK" smaller below
  tc.fillStyle    = `rgb(${vkR},${vkG},${vkB})`;
  tc.textBaseline = 'middle';
  const margin = Math.max(2, Math.round(bh * 0.10));
  tc.font = `bold ${Math.round(bh * 0.58)}px sans-serif`;
  tc.fillText('OK', margin, bh * 0.38);
  tc.font = `${Math.round(bh * 0.27)}px sans-serif`;
  tc.fillText('ADOBE ACROBAT VIEW CHECK', margin, bh * 0.76);

  const ov = tc.getImageData(0, 0, bw, bh).data;

  // Pass 3c: blit overlay pixels into printImgData for every diff pixel.
  for (let i = 0; i < p.length; i += 4) {
    if (p[i] !== n[i] || p[i + 1] !== n[i + 1] || p[i + 2] !== n[i + 2]) {
      const px = (i >> 2) % W;
      const py = Math.floor((i >> 2) / W);
      const oi = ((py - minY) * bw + (px - minX)) * 4;
      p[i]     = ov[oi];
      p[i + 1] = ov[oi + 1];
      p[i + 2] = ov[oi + 2];
      // alpha [i+3] remains 255
    }
  }
}

// Build a fresh OptionalContentConfig starting from the document defaults,
// then override each OCG whose /PrintState was found by extractOCGUsageStates().
// Returns null if there are no print states or if the config cannot be built.
async function buildPrintOCGConfig(pdfDoc, printStates) {
  if (printStates.size === 0) return null;

  let config;
  try { config = await pdfDoc.getOptionalContentConfig(); } catch (_) { return null; }
  if (!config) return null;

  let groups;
  try { groups = config.getGroups(); } catch (_) { return null; }
  if (!groups) return null;

  for (const [id, group] of Object.entries(groups)) {
    const vis = printStates.get(group.name);
    if (vis !== undefined) {
      try { config.setVisibility(id, vis); } catch (_) {}
    }
  }
  return config;
}

// ── Per-separation plate rendering ────────────────────────────────────────────
//
// Overview
// --------
// PDF.js renders every page to a single composited sRGB canvas.  It ignores the
// OP (overprint) flag in ExtGState, so spot colours and CMYK inks that should
// overprint (multiply) each other are instead drawn with source-over (knockout).
//
// This section implements a plate-based compositing pipeline that:
//   1. Renders the "base" plate: all spot-colour OCGs OFF, process CMYK visible.
//   2. Renders one plate per spot-colour OCG: only that OCG ON.
//   3. Composites all enabled plates onto white paper using the multiply blend,
//      which correctly simulates ink overprinting.
//   4. For OPP mode: also renders the AcrobatViewCheck (ACV) OCG and replaces the
//      PDF.js orange "INCORRECT VIEW" result with a synthesised green "OK" indicator.
//
// Plates are rendered asynchronously after the main render and cached until the
// page, zoom level, or OPP mode changes.  applySeparations() upgrades to the
// plate composite automatically once it is ready.
//
// OCG mapping
// -----------
// buildOcgSpotMap() matches each OCG by name to a known spot colour entry in
// state.spotColors.  Only matched OCGs get individual plate renders; unmatched
// OCGs (structural layers, die-cut lines, etc.) remain in the base plate.
// Spot colours not found in any OCG fall back to the vector-masking approach
// already implemented in maskSpotColor().
//

/** Returns a Map<ocgId, spotColorName> for OCGs whose name matches a spot colour. */
function buildOcgSpotMap() {
  const map = new Map();
  if (!state.ocConfig) return map;
  let groups;
  try { groups = state.ocConfig.getGroups(); } catch (_) { return map; }
  if (!groups) return map;

  for (const [id, group] of Object.entries(groups)) {
    if (id === state.acvOCGId) continue;  // ACV handled separately
    const spot = state.spotColors.find(s => s.name === group.name);
    if (spot) map.set(id, spot.name);
  }
  return map;
}

/**
 * Creates an OCG config where all spot-colour OCGs are OFF so only the base
 * process-CMYK + non-spot-OCG content is rendered.  In OPP mode the ACV OCG
 * is also turned off (the ACV plate is rendered separately via makeSpotPlateConfig).
 */
async function makeBasePlateConfig() {
  let cfg;
  try { cfg = await state.pdf.getOptionalContentConfig(); } catch (_) { return null; }
  if (!cfg) return null;
  let groups;
  try { groups = cfg.getGroups(); } catch (_) { return null; }
  // Start from the layer visibility of the current mode, user toggles included
  for (const id of Object.keys(groups || {})) {
    try { cfg.setVisibility(id, isLayerVisible(id)); } catch (_) {}
  }
  for (const [ocgId] of state.ocgSpotMap) {
    try { cfg.setVisibility(ocgId, false); } catch (_) {}
  }
  // In OPP mode also hide the ACV OCG — it gets its own corrected plate
  if (state.oppMode && state.acvOCGId) {
    try { cfg.setVisibility(state.acvOCGId, false); } catch (_) {}
  }
  return cfg;
}

/**
 * Creates an OCG config with ALL OCGs off except the one specified.
 * Pass null to leave every OCG off, which renders only the page content that
 * sits outside any OCG.
 */
async function makeSpotPlateConfig(ocgId) {
  let cfg;
  try { cfg = await state.pdf.getOptionalContentConfig(); } catch (_) { return null; }
  if (!cfg) return null;
  let groups;
  try { groups = cfg.getGroups(); } catch (_) { return null; }
  if (!groups) return null;
  for (const id of Object.keys(groups)) {
    try { cfg.setVisibility(id, false); } catch (_) {}
  }
  if (ocgId !== null) {
    try { cfg.setVisibility(ocgId, true); } catch (_) {}
  }
  return cfg;
}

/** Renders a page to an ImageData using the given OCG config and intent. */
async function renderToImageData(page, viewport, intent, ocgCfg, W, H) {
  const off = document.createElement('canvas');
  off.width  = W;
  off.height = H;
  const offCtx = off.getContext('2d');
  await page.render({
    canvasContext: offCtx,
    viewport,
    intent,
    optionalContentConfigPromise: ocgCfg ? Promise.resolve(ocgCfg) : undefined,
  }).promise;
  return offCtx.getImageData(0, 0, W, H);
}

/**
 * Builds a corrected ACV plate as an ImageData.
 *
 * acvRender  — ImageData from rendering with only the ACV OCG on (PDF.js gives
 *              the orange "INCORRECT VIEW" result here because it ignores OP).
 * noOcgRender — ImageData from rendering with every OCG off.  Both renders
 *              contain the same non-OCG content, so their diff is exactly the
 *              indicator.  (Diffing against the base plate would not work: it
 *              holds the page artwork, so the diff would span the whole page.)
 *
 * Returns an ImageData (same W×H) with white everywhere except the indicator
 * region, which shows a synthesised green "OK / ADOBE ACROBAT VIEW CHECK" banner.
 * Returns null if no differing pixels are found.
 */
function buildACVPlate(acvRender, noOcgRender, W, H) {
  const vgSpot = state.spotColors.find(s => s.name === 'View_G');
  const [vgR, vgG, vgB] = vgSpot ? vgSpot.rgb : [45, 140, 78];
  const vkSpot = state.spotColors.find(s => s.name === 'View_K');
  const [vkR, vkG, vkB] = vkSpot ? vkSpot.rgb : [30, 30, 30];

  const a = acvRender.data;
  const b = noOcgRender.data;

  // Find bounding box of the pixels the ACV OCG adds to the page
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) {
      const px = (i >> 2) % W;
      const py = Math.floor((i >> 2) / W);
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
  }
  if (maxX < 0) return null;  // ACV OCG produced no visible pixels

  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;

  // Draw the correct green indicator on a temporary canvas
  const tmp  = document.createElement('canvas');
  tmp.width  = bw;
  tmp.height = bh;
  const tc   = tmp.getContext('2d');
  tc.fillStyle = `rgb(${vgR},${vgG},${vgB})`;
  tc.fillRect(0, 0, bw, bh);
  tc.fillStyle    = `rgb(${vkR},${vkG},${vkB})`;
  tc.textBaseline = 'middle';
  const margin = Math.max(2, Math.round(bh * 0.10));
  tc.font = `bold ${Math.round(bh * 0.58)}px sans-serif`;
  tc.fillText('OK', margin, bh * 0.38);
  tc.font = `${Math.round(bh * 0.27)}px sans-serif`;
  tc.fillText('ADOBE ACROBAT VIEW CHECK', margin, bh * 0.76);
  const ov = tc.getImageData(0, 0, bw, bh).data;

  // Build full-page result: white background with green indicator at the right spot
  const result = new Uint8ClampedArray(W * H * 4).fill(255);
  for (let iy = minY; iy <= maxY; iy++) {
    for (let ix = minX; ix <= maxX; ix++) {
      const ri = (iy * W + ix) * 4;
      const oi = ((iy - minY) * bw + (ix - minX)) * 4;
      result[ri]     = ov[oi];
      result[ri + 1] = ov[oi + 1];
      result[ri + 2] = ov[oi + 2];
      result[ri + 3] = 255;
    }
  }
  return new ImageData(result, W, H);
}

/**
 * In-place multiply blend: dest[i] = round(dest[i] * src[i] / 255).
 *
 * Starting from white paper (255,255,255):
 *   • first multiply → dest becomes the first plate  (255 * plate / 255 = plate)
 *   • subsequent multiplies → correct overprint simulation of additional inks
 *
 * Uses the exact integer formula  (n + (n >>> 8) + 1) >>> 8  which equals
 * round(a*b/255) for all 8-bit input pairs without floating-point arithmetic.
 */
function multiplyInto(dest, src) {
  for (let i = 0; i < dest.length; i += 4) {
    let n;
    n = dest[i]     * src[i];     dest[i]     = (n + (n >>> 8) + 1) >>> 8;
    n = dest[i + 1] * src[i + 1]; dest[i + 1] = (n + (n >>> 8) + 1) >>> 8;
    n = dest[i + 2] * src[i + 2]; dest[i + 2] = (n + (n >>> 8) + 1) >>> 8;
    // alpha [i+3]: leave as-is
  }
}

/**
 * Applies CMYK channel filtering to a raw plate render.
 * Identical logic to the fallback in applySeparations() but returns a new
 * Uint8ClampedArray rather than writing to the canvas.
 */
function filterCmykFromPlate(src, c, m, y, k) {
  const out = new Uint8ClampedArray(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const rn = src[i]     / 255;
    const gn = src[i + 1] / 255;
    const bn = src[i + 2] / 255;

    const kv = 1 - Math.max(rn, gn, bn);
    let cv, mv, yv;
    if (kv < 1) {
      const d = 1 - kv;
      cv = (1 - rn - kv) / d;
      mv = (1 - gn - kv) / d;
      yv = (1 - bn - kv) / d;
    } else {
      cv = mv = yv = 0;
    }

    const fc = c ? cv : 0;
    const fm = m ? mv : 0;
    const fy = y ? yv : 0;
    const fk = k ? kv : 0;
    const inv = 1 - fk;
    out[i]     = 255 * (1 - fc) * inv;
    out[i + 1] = 255 * (1 - fm) * inv;
    out[i + 2] = 255 * (1 - fy) * inv;
    out[i + 3] = src[i + 3];
  }
  return out;
}

/**
 * Composites all enabled separation plates onto white paper using multiply blend.
 * Returns a new ImageData ready for ctx.putImageData(), or null if plates aren't set.
 */
function compositeFromPlates(W, H) {
  const plates = state.separationPlates;
  if (!plates) return null;

  const { c, m, y, k } = state.separations;

  // Start with white paper — multiply blend identity (255 * x / 255 = x)
  const out = new Uint8ClampedArray(W * H * 4).fill(255);

  // ── Base plate: process CMYK + non-spot-OCG content ──────────────────────
  const basePlate = plates.get('_base');
  if (basePlate) {
    if (c && m && y && k) {
      // All CMYK channels enabled: multiply entire base directly
      multiplyInto(out, basePlate.data);
    } else if (c || m || y || k) {
      // Only some CMYK channels: filter first, then multiply
      multiplyInto(out, filterCmykFromPlate(basePlate.data, c, m, y, k));
    }
    // All CMYK off: skip base plate entirely (paper stays white)
  }

  // ── Spot colour plates: one multiply per enabled ink ─────────────────────
  for (const spot of state.spotColors) {
    if (!spot.enabled) continue;
    const plate = plates.get(spot.name);
    if (plate) {
      multiplyInto(out, plate.data);
    }
    // Spots without a plate are baked into the base plate and can't be hidden
    // individually; fall through to the vector-masking pass below.
  }

  // ── Vector masking fallback for spots that have no plate ─────────────────
  // (Spot colours not mapped to any OCG remain in the base render.  If the user
  // disables such a spot we apply the approximate directional-projection mask.)
  for (const spot of state.spotColors) {
    if (!spot.enabled && !plates.has(spot.name)) {
      maskSpotColor(out, spot.rgb);
    }
  }

  // ── OPP mode: overlay corrected ACV green indicator ───────────────────────
  // The ACV indicator (AcrobatViewCheck OCG) is excluded from the base plate
  // in OPP mode.  A synthesised green "OK" plate is blitted source-over here.
  if (state.oppMode) {
    const acvPlate = plates.get('_acv');
    if (acvPlate) {
      const av = acvPlate.data;
      for (let i = 0; i < out.length; i += 4) {
        // Copy every non-white pixel from the ACV plate onto the composite
        if (av[i] !== 255 || av[i + 1] !== 255 || av[i + 2] !== 255) {
          out[i]     = av[i];
          out[i + 1] = av[i + 1];
          out[i + 2] = av[i + 2];
        }
      }
    }
  }

  return new ImageData(out, W, H);
}

/**
 * Renders all separation plates for the current page asynchronously.
 * Stores results in state.separationPlates and calls applySeparations() once done.
 * Any in-progress render from a previous call is aborted before starting.
 */
async function schedulePlateRender(page, viewport, W, H, intent) {
  const plateKey = `${state._renderCacheKey}@${intent}`;
  if (state.separationPlatesKey === plateKey) return;  // already up-to-date

  // Replace any existing abort controller so a stale render stops itself
  if (_plateAbortCtrl) _plateAbortCtrl.abort();
  const ctrl   = new AbortController();
  _plateAbortCtrl = ctrl;

  const plates = new Map();

  try {
    // ── Base plate ────────────────────────────────────────────────────────
    const baseCfg = await makeBasePlateConfig();
    if (ctrl.signal.aborted) return;
    plates.set('_base',
      await renderToImageData(page, viewport, intent, baseCfg, W, H));
    if (ctrl.signal.aborted) return;

    // ── Per-spot-colour OCG plates ────────────────────────────────────────
    for (const [ocgId, spotName] of state.ocgSpotMap) {
      // Layer hidden: keep an empty entry so the ink contributes nothing and
      // compositeFromPlates() doesn't treat it as a spot with no plate.
      if (!isLayerVisible(ocgId)) { plates.set(spotName, null); continue; }
      const spotCfg = await makeSpotPlateConfig(ocgId);
      if (ctrl.signal.aborted) return;
      plates.set(spotName,
        await renderToImageData(page, viewport, intent, spotCfg, W, H));
      if (ctrl.signal.aborted) return;
    }

    // ── ACV green indicator plate (OPP mode only) ─────────────────────────
    if (state.oppMode && state.acvOCGId && isLayerVisible(state.acvOCGId)) {
      const acvCfg = await makeSpotPlateConfig(state.acvOCGId);
      if (ctrl.signal.aborted) return;
      const acvRender = await renderToImageData(
        page, viewport, intent, acvCfg, W, H);
      if (ctrl.signal.aborted) return;
      const noOcgCfg = await makeSpotPlateConfig(null);
      if (ctrl.signal.aborted) return;
      const noOcgRender = await renderToImageData(
        page, viewport, intent, noOcgCfg, W, H);
      if (ctrl.signal.aborted) return;
      const acvPlate = buildACVPlate(acvRender, noOcgRender, W, H);
      if (acvPlate) plates.set('_acv', acvPlate);
    }

    if (ctrl.signal.aborted) return;

    // Commit results and refresh the canvas
    state.separationPlates    = plates;
    state.separationPlatesKey = plateKey;
    applySeparations();

  } catch (e) {
    // AbortError is expected when page/zoom/mode changes during render
    if (ctrl.signal.aborted || e?.name === 'AbortError') return;
    console.warn('Plate render error:', e);
  }
}

// ── Initial panel build (no PDF loaded → shows CMYK rows only) ───────────────
buildSeparationsPanel();
