import {
  IG_RATIOS,
  CROP_ASPECTS,
  CropWorkspace,
  buildRotatedCanvas,
  renderFramedToCanvas,
  exportPhotoBuffer,
  fitCropToAspect,
} from './cropper.js';

// Application State
const state = {
  photos: [], // { id, filePath, name, fileUrl, thumbUrl, naturalWidth, naturalHeight, crop, rotation, igRatio, cropAspect, borderColor, paddingPercent, adjustments, edited }
  activeIndex: -1,
  mode: 'crop', // 'crop' | 'preview'
  defaults: {
    igRatio: '4:5',
    cropAspect: 'free',
    borderColor: '#ffffff',
    paddingPercent: 0,
  },
  exportOptions: {
    format: 'jpeg',
    resolution: '1x',
    quality: 95,
  },
  lastExportDir: null,
};

// Bounded LRU cache for interactive working previews (1280px max, frees RAM on eviction)
const MAX_PREVIEW_CACHE = 8;
const PREVIEW_MAX_DIM = 1280;
const previewCache = new Map(); // key: `${fileUrl}@${rotation}` -> { canvas, naturalWidth, naturalHeight }
const inflightPreviews = new Map(); // key -> Promise

let activeRotatedPreview = null;
let miniPreviewRafId = 0;
let prefetchTimer = null;

// DOM Elements
const els = {
  btnAddPhotos: document.getElementById('btnAddPhotos'),
  btnAddFolder: document.getElementById('btnAddFolder'),
  btnEmptyPhotos: document.getElementById('btnEmptyPhotos'),
  btnEmptyFolder: document.getElementById('btnEmptyFolder'),
  btnClearQueue: document.getElementById('btnClearQueue'),
  btnModeCrop: document.getElementById('btnModeCrop'),
  btnModePreview: document.getElementById('btnModePreview'),
  btnExportCurrent: document.getElementById('btnExportCurrent'),
  btnExportAll: document.getElementById('btnExportAll'),
  photoCounter: document.getElementById('photoCounter'),

  filmstrip: document.getElementById('filmstrip'),
  emptyStage: document.getElementById('emptyStage'),
  canvasWrap: document.getElementById('canvasWrap'),
  mainCanvas: document.getElementById('mainCanvas'),
  stageFooter: document.getElementById('stageFooter'),
  dropOverlay: document.getElementById('dropOverlay'),

  btnPrevPhoto: document.getElementById('btnPrevPhoto'),
  btnNextPhoto: document.getElementById('btnNextPhoto'),
  activeFileName: document.getElementById('activeFileName'),
  cropDimensions: document.getElementById('cropDimensions'),
  btnRotateCCW: document.getElementById('btnRotateCCW'),
  btnRotateCW: document.getElementById('btnRotateCW'),
  btnResetCrop: document.getElementById('btnResetCrop'),

  miniPreviewCanvas: document.getElementById('miniPreviewCanvas'),
  previewResBadge: document.getElementById('previewResBadge'),
  igRatioGrid: document.getElementById('igRatioGrid'),
  cropAspectGrid: document.getElementById('cropAspectGrid'),
  btnResetAdjust: document.getElementById('btnResetAdjust'),
  brightnessSlider: document.getElementById('brightnessSlider'),
  brightnessValue: document.getElementById('brightnessValue'),
  contrastSlider: document.getElementById('contrastSlider'),
  contrastValue: document.getElementById('contrastValue'),
  saturationSlider: document.getElementById('saturationSlider'),
  saturationValue: document.getElementById('saturationValue'),
  swatches: Array.from(document.querySelectorAll('.swatch')),
  customColorInput: document.getElementById('customColorInput'),
  marginSlider: document.getElementById('marginSlider'),
  marginValue: document.getElementById('marginValue'),
  btnApplyFrameAll: document.getElementById('btnApplyFrameAll'),

  exportFormat: document.getElementById('exportFormat'),
  exportResolution: document.getElementById('exportResolution'),
  qualityRow: document.getElementById('qualityRow'),
  qualitySlider: document.getElementById('qualitySlider'),
  qualityValue: document.getElementById('qualityValue'),

  exportModal: document.getElementById('exportModal'),
  exportModalTitle: document.getElementById('exportModalTitle'),
  exportProgressBar: document.getElementById('exportProgressBar'),
  exportStatusText: document.getElementById('exportStatusText'),
  exportModalActions: document.getElementById('exportModalActions'),
  btnOpenExportDir: document.getElementById('btnOpenExportDir'),
  btnCloseExportModal: document.getElementById('btnCloseExportModal'),

  toast: document.getElementById('toast'),
};

const workspace = new CropWorkspace(els.mainCanvas, (_crop, isFinal) => {
  markPhotoEdited(state.activeIndex);
  updateCropInfo();
  scheduleMiniPreview(isFinal);
});

let toastTimer = null;
function showToast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 2400);
}

/**
 * Load an HTMLImageElement transiently (not cached globally to keep RAM low).
 */
function loadImageElement(fileUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${fileUrl}`));
    img.src = fileUrl;
  });
}

function lruGet(key) {
  if (!previewCache.has(key)) return null;
  const val = previewCache.get(key);
  previewCache.delete(key);
  previewCache.set(key, val);
  return val;
}

function lruSet(key, val) {
  if (previewCache.has(key)) {
    previewCache.delete(key);
  }
  previewCache.set(key, val);
  while (previewCache.size > MAX_PREVIEW_CACHE) {
    const oldestKey = previewCache.keys().next().value;
    const evicted = previewCache.get(oldestKey);
    previewCache.delete(oldestKey);
    if (evicted && evicted.canvas && evicted.canvas !== activeRotatedPreview) {
      evicted.canvas.width = 0;
      evicted.canvas.height = 0;
    }
  }
}

function clearPreviewCache() {
  for (const entry of previewCache.values()) {
    if (entry && entry.canvas) {
      entry.canvas.width = 0;
      entry.canvas.height = 0;
    }
  }
  previewCache.clear();
  inflightPreviews.clear();
}

/**
 * Decode & downscale a photo into a lightweight interactive working canvas,
 * cached in a small LRU cache. Releases the full-resolution decoded bitmap immediately.
 */
async function getWorkingPreview(photo) {
  const key = `${photo.fileUrl}@${photo.rotation}`;
  const cached = lruGet(key);
  if (cached) {
    photo.naturalWidth = cached.naturalWidth;
    photo.naturalHeight = cached.naturalHeight;
    return cached;
  }

  if (inflightPreviews.has(key)) {
    return inflightPreviews.get(key);
  }

  const promise = (async () => {
    const img = await loadImageElement(photo.fileUrl);
    const naturalWidth = img.naturalWidth;
    const naturalHeight = img.naturalHeight;
    const canvas = buildRotatedCanvas(img, photo.rotation, PREVIEW_MAX_DIM);
    // Allow GC of the full-res HTMLImageElement immediately
    img.src = '';

    const entry = { canvas, naturalWidth, naturalHeight };
    lruSet(key, entry);
    photo.naturalWidth = naturalWidth;
    photo.naturalHeight = naturalHeight;
    return entry;
  })();

  inflightPreviews.set(key, promise);
  try {
    return await promise;
  } finally {
    inflightPreviews.delete(key);
  }
}

function scheduleNeighborPrefetch(currentIndex) {
  clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(() => {
    const neighbors = [currentIndex + 1, currentIndex - 1];
    for (const idx of neighbors) {
      if (idx >= 0 && idx < state.photos.length) {
        getWorkingPreview(state.photos[idx]).catch(() => {});
      }
    }
  }, 150);
}

// Lazy tiny thumbnail generator (keeps filmstrip memory <2MB even for 500+ 24MP photos)
const THUMB_SIZE = 96;
const thumbQueue = [];
let activeThumbWorkers = 0;
const MAX_THUMB_WORKERS = 3;

async function generateTinyThumb(photo) {
  if (photo.thumbUrl) return photo.thumbUrl;
  try {
    const dataUrl = await window.api.getThumbnail(photo.filePath);
    if (dataUrl) {
      photo.thumbUrl = dataUrl;
      return dataUrl;
    }
  } catch (_) {}
  return photo.fileUrl;
}

function pumpThumbQueue() {
  while (activeThumbWorkers < MAX_THUMB_WORKERS && thumbQueue.length > 0) {
    const task = thumbQueue.shift();
    if (!task.imgEl.isConnected) continue;
    activeThumbWorkers++;
    generateTinyThumb(task.photo)
      .then((url) => {
        if (task.imgEl.isConnected) {
          task.imgEl.src = url;
        }
      })
      .finally(() => {
        activeThumbWorkers--;
        pumpThumbQueue();
      });
  }
}

const thumbObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const imgEl = entry.target;
      thumbObserver.unobserve(imgEl);
      const photoId = imgEl.dataset.photoId;
      const photo = state.photos.find((p) => p.id === photoId);
      if (!photo) continue;
      if (photo.thumbUrl) {
        imgEl.src = photo.thumbUrl;
      } else {
        thumbQueue.push({ photo, imgEl });
        pumpThumbQueue();
      }
    }
  },
  { root: els.filmstrip, rootMargin: '200px 0px' }
);

function getActivePhoto() {
  if (state.activeIndex < 0 || state.activeIndex >= state.photos.length) return null;
  return state.photos[state.activeIndex];
}

function addPhotoEntries(entries) {
  if (!entries || entries.length === 0) return;

  const existingPaths = new Set(state.photos.map((p) => p.filePath));
  let addedCount = 0;

  for (const entry of entries) {
    if (existingPaths.has(entry.filePath)) continue;
    existingPaths.add(entry.filePath);
    state.photos.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      filePath: entry.filePath,
      name: entry.name,
      fileUrl: entry.fileUrl,
      thumbUrl: null,
      naturalWidth: 0,
      naturalHeight: 0,
      crop: { x: 0, y: 0, w: 1, h: 1 },
      rotation: 0,
      igRatio: state.defaults.igRatio,
      cropAspect: state.defaults.cropAspect,
      borderColor: state.defaults.borderColor,
      paddingPercent: state.defaults.paddingPercent,
      adjustments: { brightness: 0, contrast: 0, saturation: 0 },
      edited: false,
    });
    addedCount++;
  }

  if (addedCount === 0) {
    showToast('Those photos are already in the batch queue.');
    return;
  }

  if (state.activeIndex === -1) {
    state.activeIndex = 0;
  }

  renderFilmstrip();
  updateGlobalControls();
  selectPhoto(state.activeIndex);
  showToast(`Added ${addedCount} photo${addedCount > 1 ? 's' : ''}`);
}

function updateGlobalControls() {
  const count = state.photos.length;
  els.photoCounter.textContent = `${count} photo${count === 1 ? '' : 's'}`;
  const hasPhotos = count > 0;
  els.btnClearQueue.disabled = !hasPhotos;
  els.btnExportCurrent.disabled = !hasPhotos;
  els.btnExportAll.disabled = !hasPhotos;
  els.btnApplyFrameAll.disabled = count < 2;

  els.emptyStage.classList.toggle('hidden', hasPhotos);
  els.canvasWrap.classList.toggle('hidden', !hasPhotos);
  els.stageFooter.classList.toggle('hidden', !hasPhotos);

  if (hasPhotos) {
    requestAnimationFrame(() => workspace.resize());
  }
}

function renderFilmstrip() {
  thumbObserver.disconnect();
  thumbQueue.length = 0;

  if (state.photos.length === 0) {
    els.filmstrip.innerHTML =
      '<div class="empty-queue">No photos yet.<br />Drag &amp; drop photos or a folder here.</div>';
    return;
  }

  const frag = document.createDocumentFragment();
  state.photos.forEach((photo, idx) => {
    const card = document.createElement('div');
    card.className = `thumb-card${idx === state.activeIndex ? ' active' : ''}`;
    card.dataset.index = String(idx);

    const imgWrap = document.createElement('div');
    imgWrap.className = 'thumb-img-wrap';
    const img = document.createElement('img');
    img.draggable = false;
    img.dataset.photoId = photo.id;
    if (photo.thumbUrl) {
      img.src = photo.thumbUrl;
    } else {
      thumbObserver.observe(img);
    }
    imgWrap.appendChild(img);

    const meta = document.createElement('div');
    meta.className = 'thumb-meta';

    const name = document.createElement('div');
    name.className = 'thumb-name';
    name.textContent = photo.name;
    name.title = photo.name;

    const sub = document.createElement('div');
    sub.className = 'thumb-sub';
    const ratioSpan = document.createElement('span');
    ratioSpan.className = 'thumb-ratio';
    ratioSpan.textContent = photo.igRatio;
    sub.appendChild(ratioSpan);

    const dot = document.createElement('span');
    dot.className = `edited-dot${photo.edited ? '' : ' hidden'}`;
    dot.title = 'Edited';
    sub.appendChild(dot);

    meta.appendChild(name);
    meta.appendChild(sub);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'thumb-remove';
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove from queue';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removePhotoAt(idx);
    });

    card.appendChild(imgWrap);
    card.appendChild(meta);
    card.appendChild(removeBtn);

    card.addEventListener('click', () => selectPhoto(idx));
    frag.appendChild(card);
  });

  els.filmstrip.innerHTML = '';
  els.filmstrip.appendChild(frag);
}

function markPhotoEdited(index) {
  const photo = state.photos[index];
  if (!photo || photo.edited) return;
  photo.edited = true;
  const card = els.filmstrip.querySelector(`.thumb-card[data-index="${index}"]`);
  const dot = card?.querySelector('.edited-dot');
  if (dot) dot.classList.remove('hidden');
}

function updateFilmstripRatioBadge(index) {
  const photo = state.photos[index];
  if (!photo) return;
  const card = els.filmstrip.querySelector(`.thumb-card[data-index="${index}"]`);
  const ratioEl = card?.querySelector('.thumb-ratio');
  if (ratioEl) ratioEl.textContent = photo.igRatio;
}

function removePhotoAt(idx) {
  state.photos.splice(idx, 1);
  if (state.photos.length === 0) {
    state.activeIndex = -1;
    activeRotatedPreview = null;
    clearPreviewCache();
    workspace.setSource(null, null);
    clearMiniPreview();
  } else if (idx < state.activeIndex) {
    state.activeIndex--;
  } else if (state.activeIndex >= state.photos.length) {
    state.activeIndex = state.photos.length - 1;
  }
  renderFilmstrip();
  updateGlobalControls();
  if (state.activeIndex >= 0) {
    selectPhoto(state.activeIndex);
  }
}

async function selectPhoto(index) {
  if (index < 0 || index >= state.photos.length) return;
  state.activeIndex = index;
  const photo = state.photos[index];

  els.filmstrip.querySelectorAll('.thumb-card').forEach((el, i) => {
    el.classList.toggle('active', i === index);
  });
  const activeCard = els.filmstrip.querySelector(`.thumb-card[data-index="${index}"]`);
  if (activeCard) {
    activeCard.scrollIntoView({ block: 'nearest' });
  }

  els.activeFileName.textContent = photo.name;
  els.btnPrevPhoto.disabled = index === 0;
  els.btnNextPhoto.disabled = index === state.photos.length - 1;

  syncInspectorFromPhoto(photo);

  try {
    const entry = await getWorkingPreview(photo);
    if (getActivePhoto() !== photo) return;

    activeRotatedPreview = entry.canvas;
    workspace.setSource(activeRotatedPreview, photo);
    updateCropInfo();
    scheduleMiniPreview(true);
    scheduleNeighborPrefetch(index);
  } catch (err) {
    console.error(err);
    showToast(`Could not load ${photo.name}`);
  }
}

function syncInspectorFromPhoto(photo) {
  els.igRatioGrid.querySelectorAll('.preset-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.ratio === photo.igRatio);
  });

  const aspectKey = photo.cropAspect || 'free';
  els.cropAspectGrid.querySelectorAll('.chip-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.aspect === aspectKey);
  });

  const adj = photo.adjustments || { brightness: 0, contrast: 0, saturation: 0 };
  els.brightnessSlider.value = String(adj.brightness);
  els.brightnessValue.textContent = adj.brightness > 0 ? `+${adj.brightness}` : String(adj.brightness);
  els.contrastSlider.value = String(adj.contrast);
  els.contrastValue.textContent = adj.contrast > 0 ? `+${adj.contrast}` : String(adj.contrast);
  els.saturationSlider.value = String(adj.saturation);
  els.saturationValue.textContent = adj.saturation > 0 ? `+${adj.saturation}` : String(adj.saturation);

  const hex = (photo.borderColor || '#ffffff').toLowerCase();
  els.swatches.forEach((sw) => {
    sw.classList.toggle('active', sw.dataset.color.toLowerCase() === hex);
  });
  els.customColorInput.value = hex;

  els.marginSlider.value = String(photo.paddingPercent || 0);
  els.marginValue.textContent = `${photo.paddingPercent || 0}%`;

  updateResBadge();
}

function updateResBadge() {
  const photo = getActivePhoto();
  const ratioKey = photo ? photo.igRatio : state.defaults.igRatio;
  const preset = IG_RATIOS[ratioKey] || IG_RATIOS['4:5'];
  const mult = state.exportOptions.resolution === '2x' ? 2 : 1;
  els.previewResBadge.textContent = `${Math.round(preset.width * mult)} × ${Math.round(preset.height * mult)}`;
}

function updateCropInfo() {
  const photo = getActivePhoto();
  if (!photo || !photo.naturalWidth) {
    els.cropDimensions.textContent = '—';
    return;
  }
  const swap = photo.rotation % 180 !== 0;
  const fullW = swap ? photo.naturalHeight : photo.naturalWidth;
  const fullH = swap ? photo.naturalWidth : photo.naturalHeight;
  const cropW = Math.round(photo.crop.w * fullW);
  const cropH = Math.round(photo.crop.h * fullH);
  els.cropDimensions.textContent = `Crop: ${cropW} × ${cropH}px`;
}

function clearMiniPreview() {
  const c = els.miniPreviewCanvas;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
}

function renderMiniPreview(highQuality = false) {
  const photo = getActivePhoto();
  if (!photo || !activeRotatedPreview) {
    clearMiniPreview();
    return;
  }

  const preset = IG_RATIOS[photo.igRatio] || IG_RATIOS['4:5'];
  const maxBox = 240;
  const scale = Math.min(maxBox / preset.width, maxBox / preset.height);
  const w = Math.max(1, Math.round(preset.width * scale));
  const h = Math.max(1, Math.round(preset.height * scale));

  const c = els.miniPreviewCanvas;
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  renderFramedToCanvas(c, activeRotatedPreview, photo, highQuality);
}

function scheduleMiniPreview(highQuality = false) {
  if (miniPreviewRafId) return;
  miniPreviewRafId = requestAnimationFrame(() => {
    miniPreviewRafId = 0;
    renderMiniPreview(highQuality);
  });
}

function setMode(mode) {
  state.mode = mode;
  els.btnModeCrop.classList.toggle('active', mode === 'crop');
  els.btnModePreview.classList.toggle('active', mode === 'preview');
  workspace.setMode(mode);
}

function rotateActivePhoto(deltaDeg) {
  const photo = getActivePhoto();
  if (!photo) return;

  photo.rotation = (((photo.rotation + deltaDeg) % 360) + 360) % 360;
  const { x, y, w, h } = photo.crop;
  if (deltaDeg === 90) {
    photo.crop = { x: 1 - y - h, y: x, w: h, h: w };
  } else if (deltaDeg === -90) {
    photo.crop = { x: y, y: 1 - x - w, w: h, h: w };
  }
  markPhotoEdited(state.activeIndex);
  selectPhoto(state.activeIndex);
}

function resetActiveCrop() {
  const photo = getActivePhoto();
  if (!photo) return;
  photo.crop = { x: 0, y: 0, w: 1, h: 1 };
  photo.cropAspect = 'free';
  els.cropAspectGrid.querySelectorAll('.chip-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.aspect === 'free');
  });
  workspace.scheduleRender();
  updateCropInfo();
  scheduleMiniPreview(true);
}

async function runExport(itemsToExport) {
  if (!itemsToExport || itemsToExport.length === 0) return;

  const outputDir = await window.api.selectOutputDir();
  if (!outputDir) return;

  state.lastExportDir = outputDir;
  els.exportModal.classList.remove('hidden');
  els.exportModalActions.classList.add('hidden');
  els.exportModalTitle.textContent = `Exporting ${itemsToExport.length} Photo${itemsToExport.length > 1 ? 's' : ''}…`;
  els.exportProgressBar.style.width = '0%';

  const ext = state.exportOptions.format === 'png' ? '.png' : '.jpg';
  const usedNames = new Set();
  let successCount = 0;

  for (let i = 0; i < itemsToExport.length; i++) {
    const photo = itemsToExport[i];
    els.exportStatusText.textContent = `Processing ${i + 1} of ${itemsToExport.length}: ${photo.name}`;
    // Yield to keep progress UI responsive
    await new Promise((r) => setTimeout(r, 0));

    try {
      const img = await loadImageElement(photo.fileUrl);
      const buffer = await exportPhotoBuffer(img, photo, state.exportOptions);
      img.src = '';

      const baseName = photo.name.replace(/\.[^/.]+$/, '');
      const ratioTag = photo.igRatio.replace(':', 'x').replace('.', '_');
      let outFileName = `${baseName}_ig_${ratioTag}${ext}`;
      let suffix = 2;
      while (usedNames.has(outFileName.toLowerCase())) {
        outFileName = `${baseName}_ig_${ratioTag}_${suffix}${ext}`;
        suffix++;
      }
      usedNames.add(outFileName.toLowerCase());

      await window.api.saveImage({
        outputDir,
        fileName: outFileName,
        buffer,
      });
      successCount++;
    } catch (err) {
      console.error('Export failed for', photo.name, err);
    }

    const pct = Math.round(((i + 1) / itemsToExport.length) * 100);
    els.exportProgressBar.style.width = `${pct}%`;
  }

  els.exportModalTitle.textContent = 'Export Complete';
  els.exportStatusText.textContent = `Saved ${successCount} of ${itemsToExport.length} photo${itemsToExport.length > 1 ? 's' : ''} to ${outputDir}`;
  els.exportModalActions.classList.remove('hidden');
}

// Event Listeners
async function handleOpenFiles() {
  const entries = await window.api.openFiles();
  addPhotoEntries(entries);
}

async function handleOpenFolder() {
  const entries = await window.api.openFolder();
  addPhotoEntries(entries);
}

els.btnAddPhotos.addEventListener('click', handleOpenFiles);
els.btnEmptyPhotos.addEventListener('click', handleOpenFiles);
els.btnAddFolder.addEventListener('click', handleOpenFolder);
els.btnEmptyFolder.addEventListener('click', handleOpenFolder);

els.btnClearQueue.addEventListener('click', () => {
  state.photos = [];
  state.activeIndex = -1;
  activeRotatedPreview = null;
  clearPreviewCache();
  workspace.setSource(null, null);
  clearMiniPreview();
  renderFilmstrip();
  updateGlobalControls();
});

els.btnModeCrop.addEventListener('click', () => setMode('crop'));
els.btnModePreview.addEventListener('click', () => setMode('preview'));

els.btnPrevPhoto.addEventListener('click', () => {
  if (state.activeIndex > 0) selectPhoto(state.activeIndex - 1);
});
els.btnNextPhoto.addEventListener('click', () => {
  if (state.activeIndex < state.photos.length - 1) selectPhoto(state.activeIndex + 1);
});

els.btnRotateCCW.addEventListener('click', () => rotateActivePhoto(-90));
els.btnRotateCW.addEventListener('click', () => rotateActivePhoto(90));
els.btnResetCrop.addEventListener('click', resetActiveCrop);

// Instagram ratio buttons
els.igRatioGrid.addEventListener('click', (e) => {
  const btn = e.target.closest('.preset-btn');
  if (!btn) return;
  const ratio = btn.dataset.ratio;
  state.defaults.igRatio = ratio;

  const photo = getActivePhoto();
  if (photo) {
    photo.igRatio = ratio;
    markPhotoEdited(state.activeIndex);
    updateFilmstripRatioBadge(state.activeIndex);
    syncInspectorFromPhoto(photo);
    workspace.scheduleRender();
    scheduleMiniPreview(true);
  } else {
    els.igRatioGrid.querySelectorAll('.preset-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.ratio === ratio);
    });
    updateResBadge();
  }
});

// Crop aspect ratio chips
els.cropAspectGrid.addEventListener('click', (e) => {
  const btn = e.target.closest('.chip-btn');
  if (!btn) return;
  const val = btn.dataset.aspect;
  state.defaults.cropAspect = val;

  els.cropAspectGrid.querySelectorAll('.chip-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.aspect === val);
  });

  const photo = getActivePhoto();
  if (!photo || !activeRotatedPreview) return;

  photo.cropAspect = val;
  if (val !== 'free') {
    const targetAspect =
      val === 'original'
        ? activeRotatedPreview.width / activeRotatedPreview.height
        : CROP_ASPECTS[val];
    photo.crop = fitCropToAspect(
      photo.crop,
      activeRotatedPreview.width,
      activeRotatedPreview.height,
      targetAspect
    );
    markPhotoEdited(state.activeIndex);
  }
  workspace.scheduleRender();
  updateCropInfo();
  scheduleMiniPreview(true);
});

// Simple Photo Adjustments (Brightness, Contrast, Saturation)
function handleAdjustmentInput(key, valueEl, rawValue) {
  const val = Number(rawValue);
  valueEl.textContent = val > 0 ? `+${val}` : String(val);
  const photo = getActivePhoto();
  if (!photo) return;
  if (!photo.adjustments) {
    photo.adjustments = { brightness: 0, contrast: 0, saturation: 0 };
  }
  photo.adjustments[key] = val;
  markPhotoEdited(state.activeIndex);
  workspace.invalidateImageLayer();
  scheduleMiniPreview(false);
}

els.brightnessSlider.addEventListener('input', (e) =>
  handleAdjustmentInput('brightness', els.brightnessValue, e.target.value)
);
els.contrastSlider.addEventListener('input', (e) =>
  handleAdjustmentInput('contrast', els.contrastValue, e.target.value)
);
els.saturationSlider.addEventListener('input', (e) =>
  handleAdjustmentInput('saturation', els.saturationValue, e.target.value)
);

els.btnResetAdjust.addEventListener('click', () => {
  const photo = getActivePhoto();
  if (photo) {
    photo.adjustments = { brightness: 0, contrast: 0, saturation: 0 };
    syncInspectorFromPhoto(photo);
    workspace.invalidateImageLayer();
    scheduleMiniPreview(true);
  } else {
    els.brightnessSlider.value = '0';
    els.brightnessValue.textContent = '0';
    els.contrastSlider.value = '0';
    els.contrastValue.textContent = '0';
    els.saturationSlider.value = '0';
    els.saturationValue.textContent = '0';
  }
});

// Border colors
function applyBorderColor(color) {
  state.defaults.borderColor = color;
  const photo = getActivePhoto();
  if (photo) {
    photo.borderColor = color;
    markPhotoEdited(state.activeIndex);
    syncInspectorFromPhoto(photo);
    workspace.scheduleRender();
    scheduleMiniPreview(true);
  } else {
    els.swatches.forEach((sw) => {
      sw.classList.toggle('active', sw.dataset.color.toLowerCase() === color.toLowerCase());
    });
    els.customColorInput.value = color;
  }
}

els.swatches.forEach((sw) => {
  sw.addEventListener('click', () => applyBorderColor(sw.dataset.color));
});

els.customColorInput.addEventListener('input', (e) => {
  applyBorderColor(e.target.value);
});

// Extra margin slider
els.marginSlider.addEventListener('input', (e) => {
  const val = Number(e.target.value);
  state.defaults.paddingPercent = val;
  els.marginValue.textContent = `${val}%`;
  const photo = getActivePhoto();
  if (photo) {
    photo.paddingPercent = val;
    markPhotoEdited(state.activeIndex);
    workspace.scheduleRender();
    scheduleMiniPreview(false);
  }
});

// Apply frame settings to all photos (updates badges in-place without rebuilding DOM)
els.btnApplyFrameAll.addEventListener('click', () => {
  const active = getActivePhoto();
  if (!active || state.photos.length < 2) return;

  state.photos.forEach((p, idx) => {
    p.igRatio = active.igRatio;
    p.borderColor = active.borderColor;
    p.paddingPercent = active.paddingPercent;
    updateFilmstripRatioBadge(idx);
  });
  showToast(`Applied ${active.igRatio} & border style to all ${state.photos.length} photos`);
});

// Export options
els.exportFormat.addEventListener('change', (e) => {
  state.exportOptions.format = e.target.value;
  els.qualityRow.classList.toggle('hidden', state.exportOptions.format === 'png');
});

els.exportResolution.addEventListener('change', (e) => {
  state.exportOptions.resolution = e.target.value;
  updateResBadge();
});

els.qualitySlider.addEventListener('input', (e) => {
  const val = Number(e.target.value);
  state.exportOptions.quality = val;
  els.qualityValue.textContent = `${val}%`;
});

els.btnExportCurrent.addEventListener('click', () => {
  const active = getActivePhoto();
  if (active) runExport([active]);
});

els.btnExportAll.addEventListener('click', () => {
  if (state.photos.length > 0) runExport(state.photos);
});

els.btnOpenExportDir.addEventListener('click', () => {
  if (state.lastExportDir) window.api.openPath(state.lastExportDir);
});

els.btnCloseExportModal.addEventListener('click', () => {
  els.exportModal.classList.add('hidden');
});

// Drag & Drop anywhere in window (file drops only, zero flicker, never stuck)
function isFileDrag(e) {
  return Array.from(e.dataTransfer?.types || []).includes('Files');
}

let hideDropTimer = null;

function showDropOverlay() {
  clearTimeout(hideDropTimer);
  els.dropOverlay.classList.remove('hidden');
}

function hideDropOverlay() {
  clearTimeout(hideDropTimer);
  els.dropOverlay.classList.add('hidden');
}

window.addEventListener('dragenter', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  showDropOverlay();
});

window.addEventListener('dragover', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  showDropOverlay();
});

window.addEventListener('dragleave', (e) => {
  if (!isFileDrag(e)) return;
  // Only hide when leaving the window boundary (relatedTarget is null)
  if (!e.relatedTarget) {
    clearTimeout(hideDropTimer);
    hideDropTimer = setTimeout(hideDropOverlay, 60);
  }
});

window.addEventListener('blur', hideDropOverlay);

window.addEventListener('drop', async (e) => {
  e.preventDefault();
  hideDropOverlay();
  if (!isFileDrag(e)) return;

  const files = Array.from(e.dataTransfer?.files || []);
  const paths = files
    .map((f) => {
      try {
        return window.api.getPathForFile(f);
      } catch (_) {
        return f.path || '';
      }
    })
    .filter(Boolean);

  if (paths.length > 0) {
    const entries = await window.api.resolvePaths(paths);
    if (entries.length === 0) {
      showToast('No supported images found (JPG, PNG, WebP, BMP, AVIF).');
    } else {
      addPhotoEntries(entries);
    }
  }
});

// Keyboard shortcuts
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (!els.exportModal.classList.contains('hidden')) return;

  if (e.key === 'ArrowLeft') {
    if (state.activeIndex > 0) selectPhoto(state.activeIndex - 1);
  } else if (e.key === 'ArrowRight') {
    if (state.activeIndex < state.photos.length - 1) selectPhoto(state.activeIndex + 1);
  } else if (e.key === ' ' || e.key.toLowerCase() === 'p') {
    e.preventDefault();
    setMode(state.mode === 'crop' ? 'preview' : 'crop');
  } else if (e.key.toLowerCase() === 'c') {
    setMode('crop');
  } else if (e.key.toLowerCase() === 'r') {
    rotateActivePhoto(90);
  }
});

// Handle window resize
window.addEventListener('resize', () => {
  workspace.resize();
});

updateResBadge();
