export const IG_RATIOS = {
  '4:5': { label: '4:5 Portrait', width: 1080, height: 1350, ratio: 4 / 5 },
  '1:1': { label: '1:1 Square', width: 1080, height: 1080, ratio: 1 },
  '1.91:1': { label: '1.91:1 Landscape', width: 1080, height: 566, ratio: 1.91 },
  '9:16': { label: '9:16 Story', width: 1080, height: 1920, ratio: 9 / 16 },
};

export const CROP_ASPECTS = {
  free: null,
  original: 'original',
  '1:1': 1,
  '4:5': 4 / 5,
  '5:4': 5 / 4,
  '3:2': 3 / 2,
  '2:3': 2 / 3,
  '4:3': 4 / 3,
  '3:4': 3 / 4,
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '1.91:1': 1.91,
};

export function buildFilterString(adjustments) {
  if (!adjustments) return 'none';
  const b = adjustments.brightness || 0;
  const c = adjustments.contrast || 0;
  const s = adjustments.saturation || 0;
  if (b === 0 && c === 0 && s === 0) return 'none';
  return `brightness(${100 + b}%) contrast(${100 + c}%) saturate(${100 + s}%)`;
}

/**
 * Create a rotated canvas copy of an HTMLImageElement or ImageBitmap.
 * If maxDim > 0, downscales for fast interactive rendering.
 */
export function buildRotatedCanvas(source, rotation = 0, maxDim = 0) {
  const srcW = source.naturalWidth || source.width;
  const srcH = source.naturalHeight || source.height;
  const rot = ((rotation % 360) + 360) % 360;
  const swap = rot === 90 || rot === 270;
  let w = swap ? srcH : srcW;
  let h = swap ? srcW : srcH;

  if (maxDim > 0 && Math.max(w, h) > maxDim) {
    const scale = maxDim / Math.max(w, h);
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
  }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate((rot * Math.PI) / 180);
  const drawW = swap ? h : w;
  const drawH = swap ? w : h;
  ctx.drawImage(source, -drawW / 2, -drawH / 2, drawW, drawH);
  ctx.restore();

  return canvas;
}

/**
 * Render the cropped photo inside an Instagram-ratio bordered frame onto a target canvas.
 */
export function renderFramedToCanvas(targetCanvas, rotatedSource, settings, highQuality = true) {
  const { crop, borderColor, paddingPercent, adjustments } = settings;
  const outW = targetCanvas.width;
  const outH = targetCanvas.height;
  const ctx = targetCanvas.getContext('2d');

  const srcFullW = rotatedSource.naturalWidth || rotatedSource.width;
  const srcFullH = rotatedSource.naturalHeight || rotatedSource.height;

  ctx.save();
  ctx.fillStyle = borderColor || '#ffffff';
  ctx.fillRect(0, 0, outW, outH);

  const srcX = Math.max(0, Math.min(srcFullW - 1, Math.round(crop.x * srcFullW)));
  const srcY = Math.max(0, Math.min(srcFullH - 1, Math.round(crop.y * srcFullH)));
  const srcW = Math.min(srcFullW - srcX, Math.max(1, Math.round(crop.w * srcFullW)));
  const srcH = Math.min(srcFullH - srcY, Math.max(1, Math.round(crop.h * srcFullH)));

  const padFraction = Math.max(0, Math.min(0.4, (paddingPercent || 0) / 100));
  const padPx = Math.round(Math.min(outW, outH) * padFraction);
  const availW = Math.max(1, outW - padPx * 2);
  const availH = Math.max(1, outH - padPx * 2);

  const fitScale = Math.min(availW / srcW, availH / srcH);
  const drawW = Math.max(1, Math.round(srcW * fitScale));
  const drawH = Math.max(1, Math.round(srcH * fitScale));
  const drawX = Math.round((outW - drawW) / 2);
  const drawY = Math.round((outH - drawH) / 2);

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = highQuality ? 'high' : 'medium';
  const filter = buildFilterString(adjustments);
  if (filter !== 'none') {
    ctx.filter = filter;
  }
  ctx.drawImage(rotatedSource, srcX, srcY, srcW, srcH, drawX, drawY, drawW, drawH);
  if (filter !== 'none') {
    ctx.filter = 'none';
  }
  ctx.restore();
}

/**
 * Export a photo item at target Instagram resolution as a Uint8Array.
 * Avoids allocating a full-resolution intermediate canvas when rotation === 0.
 */
export async function exportPhotoBuffer(img, item, exportOptions) {
  const preset = IG_RATIOS[item.igRatio] || IG_RATIOS['4:5'];
  const multiplier = exportOptions.resolution === '2x' ? 2 : 1;
  const outW = Math.round(preset.width * multiplier);
  const outH = Math.round(preset.height * multiplier);

  const outCanvas = document.createElement('canvas');
  outCanvas.width = outW;
  outCanvas.height = outH;

  const rot = ((item.rotation % 360) + 360) % 360;
  let sourceForDraw = img;
  let tempRotated = null;

  if (rot !== 0) {
    // Cap intermediate rotated canvas to at most 2x output size (more than enough for sharp downsampling)
    const maxNeeded = Math.max(outW, outH) * 2;
    tempRotated = buildRotatedCanvas(img, rot, maxNeeded);
    sourceForDraw = tempRotated;
  }

  renderFramedToCanvas(outCanvas, sourceForDraw, item, true);

  // Release temporary rotated canvas promptly
  if (tempRotated) {
    tempRotated.width = 0;
    tempRotated.height = 0;
  }

  const mime = exportOptions.format === 'png' ? 'image/png' : 'image/jpeg';
  const quality = Math.max(0.5, Math.min(1, (exportOptions.quality || 95) / 100));

  const blob = await new Promise((resolve, reject) => {
    outCanvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Failed to encode image'))),
      mime,
      quality
    );
  });

  // Release export canvas memory
  outCanvas.width = 0;
  outCanvas.height = 0;

  const arrayBuffer = await blob.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}

/**
 * Compute a centered normalized crop matching targetAspectRatio (width/height) within [0..1].
 */
export function fitCropToAspect(currentCrop, imgW, imgH, targetAspect) {
  if (!targetAspect || targetAspect <= 0) return { ...currentCrop };

  const curPxW = currentCrop.w * imgW;
  const curPxH = currentCrop.h * imgH;
  const centerX = (currentCrop.x + currentCrop.w / 2) * imgW;
  const centerY = (currentCrop.y + currentCrop.h / 2) * imgH;

  let newPxW = curPxW;
  let newPxH = curPxW / targetAspect;

  if (newPxH > curPxH) {
    newPxH = curPxH;
    newPxW = curPxH * targetAspect;
  }

  if (newPxW > imgW) {
    newPxW = imgW;
    newPxH = newPxW / targetAspect;
  }
  if (newPxH > imgH) {
    newPxH = imgH;
    newPxW = newPxH * targetAspect;
  }

  let newX = (centerX - newPxW / 2) / imgW;
  let newY = (centerY - newPxH / 2) / imgH;
  const newW = newPxW / imgW;
  const newH = newPxH / imgH;

  newX = Math.max(0, Math.min(1 - newW, newX));
  newY = Math.max(0, Math.min(1 - newH, newY));

  return { x: newX, y: newY, w: newW, h: newH };
}

/**
 * High-performance Interactive Crop & Preview Canvas controller.
 * Uses rAF scheduling and a cached filtered display layer so crop dragging runs at 60/120fps.
 */
export class CropWorkspace {
  constructor(canvas, onCropChange) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.onCropChange = onCropChange;

    this.rotatedSource = null;
    this.item = null;
    this.mode = 'crop'; // 'crop' | 'preview'

    this.imgRect = { x: 0, y: 0, w: 0, h: 0 };
    this.dragState = null;
    this.hoverHandle = null;

    // Cached pre-scaled & filtered image layer for crop mode
    this._displayLayer = document.createElement('canvas');
    this._displayLayerKey = '';

    // Reusable offscreen canvas for preview mode
    this._previewOffscreen = document.createElement('canvas');

    this._rafId = 0;
    this._bindEvents();
  }

  setSource(rotatedSource, item) {
    this.rotatedSource = rotatedSource;
    this.item = item;
    this._displayLayerKey = '';
    this.scheduleRender();
  }

  invalidateImageLayer() {
    this._displayLayerKey = '';
    this.scheduleRender();
  }

  setMode(mode) {
    this.mode = mode;
    this.dragState = null;
    this.canvas.style.cursor = 'default';
    this.scheduleRender();
  }

  resize() {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.dpr = dpr;
    this.cssW = rect.width;
    this.cssH = rect.height;
    this._displayLayerKey = '';
    this.scheduleRender();
  }

  scheduleRender() {
    if (this._rafId) return;
    this._rafId = requestAnimationFrame(() => {
      this._rafId = 0;
      this.render();
    });
  }

  _bindEvents() {
    this.canvas.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    this.canvas.addEventListener('pointermove', (e) => this._onPointerMove(e));
    this.canvas.addEventListener('pointerup', (e) => this._onPointerUp(e));
    this.canvas.addEventListener('pointercancel', (e) => this._onPointerUp(e));
  }

  _getCanvasPoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }

  _getCropBoxPx() {
    const { x, y, w, h } = this.imgRect;
    const c = this.item.crop;
    return {
      x: x + c.x * w,
      y: y + c.y * h,
      w: c.w * w,
      h: c.h * h,
    };
  }

  _hitTest(px, py) {
    if (!this.item || !this.rotatedSource || this.mode !== 'crop') return null;
    const box = this._getCropBoxPx();
    const r = 12;

    const corners = [
      { id: 'nw', x: box.x, y: box.y },
      { id: 'ne', x: box.x + box.w, y: box.y },
      { id: 'sw', x: box.x, y: box.y + box.h },
      { id: 'se', x: box.x + box.w, y: box.y + box.h },
    ];
    for (const c of corners) {
      if (Math.hypot(px - c.x, py - c.y) <= r) return c.id;
    }

    const edges = [
      { id: 'n', x: box.x + box.w / 2, y: box.y },
      { id: 's', x: box.x + box.w / 2, y: box.y + box.h },
      { id: 'w', x: box.x, y: box.y + box.h / 2 },
      { id: 'e', x: box.x + box.w, y: box.y + box.h / 2 },
    ];
    for (const ed of edges) {
      if (Math.hypot(px - ed.x, py - ed.y) <= r) return ed.id;
    }

    const nearLeft = Math.abs(px - box.x) <= 8 && py >= box.y && py <= box.y + box.h;
    const nearRight = Math.abs(px - (box.x + box.w)) <= 8 && py >= box.y && py <= box.y + box.h;
    const nearTop = Math.abs(py - box.y) <= 8 && px >= box.x && px <= box.x + box.w;
    const nearBottom = Math.abs(py - (box.y + box.h)) <= 8 && px >= box.x && px <= box.x + box.w;

    if (nearTop) return 'n';
    if (nearBottom) return 's';
    if (nearLeft) return 'w';
    if (nearRight) return 'e';

    if (px >= box.x && px <= box.x + box.w && py >= box.y && py <= box.y + box.h) {
      return 'move';
    }
    return null;
  }

  _cursorForHandle(handle) {
    const map = {
      nw: 'nwse-resize',
      se: 'nwse-resize',
      ne: 'nesw-resize',
      sw: 'nesw-resize',
      n: 'ns-resize',
      s: 'ns-resize',
      e: 'ew-resize',
      w: 'ew-resize',
      move: 'grab',
    };
    return map[handle] || 'default';
  }

  _getLockedAspect() {
    if (!this.item || !this.rotatedSource) return null;
    const key = this.item.cropAspect;
    if (!key || key === 'free') return null;
    if (key === 'original') {
      return this.rotatedSource.width / this.rotatedSource.height;
    }
    return CROP_ASPECTS[key] || null;
  }

  _onPointerDown(e) {
    if (this.mode !== 'crop' || !this.item || !this.rotatedSource) return;
    const pt = this._getCanvasPoint(e);
    const handle = this._hitTest(pt.x, pt.y);
    if (!handle) return;

    this.canvas.setPointerCapture(e.pointerId);
    this.dragState = {
      handle,
      startPt: pt,
      startCrop: { ...this.item.crop },
    };
    if (handle === 'move') {
      this.canvas.style.cursor = 'grabbing';
    }
    this.scheduleRender();
  }

  _onPointerMove(e) {
    if (this.mode !== 'crop' || !this.item || !this.rotatedSource) return;
    const pt = this._getCanvasPoint(e);

    if (!this.dragState) {
      const handle = this._hitTest(pt.x, pt.y);
      if (handle !== this.hoverHandle) {
        this.hoverHandle = handle;
        this.canvas.style.cursor = this._cursorForHandle(handle);
      }
      return;
    }

    const { handle, startPt, startCrop } = this.dragState;
    const { w: imgDrawW, h: imgDrawH } = this.imgRect;
    if (imgDrawW <= 0 || imgDrawH <= 0) return;

    const dx = (pt.x - startPt.x) / imgDrawW;
    const dy = (pt.y - startPt.y) / imgDrawH;
    const minSize = 0.05;
    const lockedAspect = this._getLockedAspect();
    const imgAspect = this.rotatedSource.width / this.rotatedSource.height;

    let { x, y, w, h } = startCrop;

    if (handle === 'move') {
      x = Math.max(0, Math.min(1 - w, x + dx));
      y = Math.max(0, Math.min(1 - h, y + dy));
      this.item.crop = { x, y, w, h };
      this.scheduleRender();
      this.onCropChange(this.item.crop, false);
      return;
    }

    let left = startCrop.x;
    let right = startCrop.x + startCrop.w;
    let top = startCrop.y;
    let bottom = startCrop.y + startCrop.h;

    if (handle.includes('w')) left = Math.max(0, Math.min(right - minSize, left + dx));
    if (handle.includes('e')) right = Math.min(1, Math.max(left + minSize, right + dx));
    if (handle.includes('n')) top = Math.max(0, Math.min(bottom - minSize, top + dy));
    if (handle.includes('s')) bottom = Math.min(1, Math.max(top + minSize, bottom + dy));

    if (lockedAspect) {
      const normRatio = lockedAspect / imgAspect;
      let newW = right - left;
      let newH = bottom - top;

      if (handle === 'n' || handle === 's') {
        newW = newH * normRatio;
        const cx = (startCrop.x + startCrop.x + startCrop.w) / 2;
        left = cx - newW / 2;
        right = cx + newW / 2;
        if (left < 0) {
          left = 0;
          right = newW;
        }
        if (right > 1) {
          right = 1;
          left = 1 - newW;
        }
        if (left < 0) {
          left = 0;
          right = 1;
          newW = 1;
          newH = newW / normRatio;
          if (handle === 'n') top = bottom - newH;
          else bottom = top + newH;
        }
      } else if (handle === 'e' || handle === 'w') {
        newH = newW / normRatio;
        const cy = (startCrop.y + startCrop.y + startCrop.h) / 2;
        top = cy - newH / 2;
        bottom = cy + newH / 2;
        if (top < 0) {
          top = 0;
          bottom = newH;
        }
        if (bottom > 1) {
          bottom = 1;
          top = 1 - newH;
        }
        if (top < 0) {
          top = 0;
          bottom = 1;
          newH = 1;
          newW = newH * normRatio;
          if (handle === 'w') left = right - newW;
          else right = left + newW;
        }
      } else {
        const anchorX = handle.includes('w') ? right : left;
        const anchorY = handle.includes('n') ? bottom : top;

        if (newW / newH > normRatio) {
          newW = newH * normRatio;
        } else {
          newH = newW / normRatio;
        }

        const maxW = handle.includes('w') ? anchorX : 1 - anchorX;
        const maxH = handle.includes('n') ? anchorY : 1 - anchorY;
        if (newW > maxW) {
          newW = maxW;
          newH = newW / normRatio;
        }
        if (newH > maxH) {
          newH = maxH;
          newW = newH * normRatio;
        }

        if (handle.includes('w')) left = anchorX - newW;
        else right = anchorX + newW;

        if (handle.includes('n')) top = anchorY - newH;
        else bottom = anchorY + newH;
      }
    }

    this.item.crop = {
      x: Math.max(0, left),
      y: Math.max(0, top),
      w: Math.max(minSize, Math.min(1, right - left)),
      h: Math.max(minSize, Math.min(1, bottom - top)),
    };
    this.scheduleRender();
    this.onCropChange(this.item.crop, false);
  }

  _onPointerUp(e) {
    if (!this.dragState) return;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch (_) {}
    this.dragState = null;
    this.canvas.style.cursor = this._cursorForHandle(this.hoverHandle);
    this.scheduleRender();
    this.onCropChange(this.item.crop, true);
  }

  _ensureDisplayLayer(drawW, drawH, dpr) {
    const pixelW = Math.max(1, Math.round(drawW * dpr));
    const pixelH = Math.max(1, Math.round(drawH * dpr));
    const filter = buildFilterString(this.item.adjustments);
    const key = `${this.item.id}|${this.item.rotation}|${pixelW}x${pixelH}|${filter}`;

    if (this._displayLayerKey === key) return;

    this._displayLayer.width = pixelW;
    this._displayLayer.height = pixelH;
    const dctx = this._displayLayer.getContext('2d', { alpha: false });
    dctx.imageSmoothingEnabled = true;
    dctx.imageSmoothingQuality = 'medium';
    if (filter !== 'none') {
      dctx.filter = filter;
    }
    dctx.drawImage(this.rotatedSource, 0, 0, pixelW, pixelH);
    if (filter !== 'none') {
      dctx.filter = 'none';
    }
    this._displayLayerKey = key;
  }

  render() {
    const ctx = this.ctx;
    const dpr = this.dpr || 1;
    const cw = this.cssW || this.canvas.width / dpr;
    const ch = this.cssH || this.canvas.height / dpr;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#111115';
    ctx.fillRect(0, 0, cw, ch);

    if (!this.rotatedSource || !this.item) {
      ctx.restore();
      return;
    }

    const pad = 28;
    const availW = Math.max(1, cw - pad * 2);
    const availH = Math.max(1, ch - pad * 2);

    if (this.mode === 'preview') {
      const preset = IG_RATIOS[this.item.igRatio] || IG_RATIOS['4:5'];
      const scale = Math.min(availW / preset.width, availH / preset.height);
      const frameW = Math.max(1, Math.round(preset.width * scale));
      const frameH = Math.max(1, Math.round(preset.height * scale));
      const frameX = Math.round((cw - frameW) / 2);
      const frameY = Math.round((ch - frameH) / 2);

      const offW = Math.max(1, Math.round(frameW * dpr));
      const offH = Math.max(1, Math.round(frameH * dpr));
      if (this._previewOffscreen.width !== offW || this._previewOffscreen.height !== offH) {
        this._previewOffscreen.width = offW;
        this._previewOffscreen.height = offH;
      }
      renderFramedToCanvas(this._previewOffscreen, this.rotatedSource, this.item, false);

      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
      ctx.shadowBlur = 24;
      ctx.shadowOffsetY = 6;
      ctx.drawImage(this._previewOffscreen, frameX, frameY, frameW, frameH);
      ctx.restore();

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
      ctx.lineWidth = 1;
      ctx.strokeRect(frameX + 0.5, frameY + 0.5, frameW - 1, frameH - 1);

      ctx.restore();
      return;
    }

    // Crop mode: blit cached pre-scaled & filtered display layer (no filter recomputation!)
    const imgW = this.rotatedSource.width;
    const imgH = this.rotatedSource.height;
    const scale = Math.min(availW / imgW, availH / imgH);
    const drawW = imgW * scale;
    const drawH = imgH * scale;
    const drawX = (cw - drawW) / 2;
    const drawY = (ch - drawH) / 2;
    this.imgRect = { x: drawX, y: drawY, w: drawW, h: drawH };

    this._ensureDisplayLayer(drawW, drawH, dpr);
    ctx.drawImage(this._displayLayer, drawX, drawY, drawW, drawH);

    const box = this._getCropBoxPx();

    // Dimmed overlay outside crop box
    ctx.fillStyle = 'rgba(0, 0, 0, 0.62)';
    ctx.beginPath();
    ctx.rect(drawX, drawY, drawW, drawH);
    ctx.rect(box.x, box.y, box.w, box.h);
    ctx.fill('evenodd');

    // Rule-of-thirds grid
    ctx.strokeStyle = this.dragState ? 'rgba(255, 255, 255, 0.42)' : 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i <= 2; i++) {
      const gx = box.x + (box.w * i) / 3;
      const gy = box.y + (box.h * i) / 3;
      ctx.moveTo(gx, box.y);
      ctx.lineTo(gx, box.y + box.h);
      ctx.moveTo(box.x, gy);
      ctx.lineTo(box.x + box.w, gy);
    }
    ctx.stroke();

    // Crop border
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(box.x, box.y, box.w, box.h);

    // Corner L-brackets
    const len = Math.min(18, box.w / 3, box.h / 3);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(box.x, box.y + len);
    ctx.lineTo(box.x, box.y);
    ctx.lineTo(box.x + len, box.y);

    ctx.moveTo(box.x + box.w - len, box.y);
    ctx.lineTo(box.x + box.w, box.y);
    ctx.lineTo(box.x + box.w, box.y + len);

    ctx.moveTo(box.x, box.y + box.h - len);
    ctx.lineTo(box.x, box.y + box.h);
    ctx.lineTo(box.x + len, box.y + box.h);

    ctx.moveTo(box.x + box.w - len, box.y + box.h);
    ctx.lineTo(box.x + box.w, box.y + box.h);
    ctx.lineTo(box.x + box.w, box.y + box.h - len);
    ctx.stroke();

    // Edge midpoint pills
    ctx.fillStyle = '#ffffff';
    const edgeHandles = [
      { x: box.x + box.w / 2 - 10, y: box.y - 2, w: 20, h: 4 },
      { x: box.x + box.w / 2 - 10, y: box.y + box.h - 2, w: 20, h: 4 },
      { x: box.x - 2, y: box.y + box.h / 2 - 10, w: 4, h: 20 },
      { x: box.x + box.w - 2, y: box.y + box.h / 2 - 10, w: 4, h: 20 },
    ];
    for (const h of edgeHandles) {
      ctx.fillRect(h.x, h.y, h.w, h.h);
    }

    ctx.restore();
  }
}
