import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  IG_RATIOS,
  CROP_ASPECTS,
  buildFilterString,
  fitCropToAspect,
} from '../src/renderer/cropper.js';

describe('IG_RATIOS and CROP_ASPECTS', () => {
  it('defines expected Instagram aspect ratio presets', () => {
    assert.deepEqual(Object.keys(IG_RATIOS), ['4:5', '1:1', '1.91:1', '9:16']);
    assert.equal(IG_RATIOS['4:5'].width, 1080);
    assert.equal(IG_RATIOS['4:5'].height, 1350);
    assert.equal(IG_RATIOS['1:1'].ratio, 1);
  });

  it('defines expected crop aspect options', () => {
    assert.equal(CROP_ASPECTS.free, null);
    assert.equal(CROP_ASPECTS.original, 'original');
    assert.equal(CROP_ASPECTS['4:5'], 4 / 5);
  });
});

describe('buildFilterString', () => {
  it('returns "none" when adjustments are missing or all zero', () => {
    assert.equal(buildFilterString(null), 'none');
    assert.equal(buildFilterString(undefined), 'none');
    assert.equal(buildFilterString({}), 'none');
    assert.equal(
      buildFilterString({ brightness: 0, contrast: 0, saturation: 0 }),
      'none'
    );
  });

  it('builds a CSS filter string from non-zero adjustments', () => {
    assert.equal(
      buildFilterString({ brightness: 10, contrast: -5, saturation: 20 }),
      'brightness(110%) contrast(95%) saturate(120%)'
    );
  });
});

describe('fitCropToAspect', () => {
  it('returns a shallow copy unchanged when targetAspect is invalid', () => {
    const crop = { x: 0.1, y: 0.2, w: 0.5, h: 0.5 };
    const result = fitCropToAspect(crop, 1000, 1000, null);
    assert.deepEqual(result, crop);
    assert.notEqual(result, crop);
  });

  it('fits a 4:5 crop centered inside a 3:2 landscape image', () => {
    const crop = { x: 0, y: 0, w: 1, h: 1 };
    const result = fitCropToAspect(crop, 1500, 1000, 4 / 5);

    const outAspect = (result.w * 1500) / (result.h * 1000);
    assert.ok(Math.abs(outAspect - 4 / 5) < 1e-6);
    assert.ok(result.x >= 0 && result.y >= 0);
    assert.ok(result.x + result.w <= 1 + 1e-9);
    assert.ok(result.y + result.h <= 1 + 1e-9);
    assert.ok(Math.abs(result.x + result.w / 2 - 0.5) < 1e-6);
    assert.ok(Math.abs(result.y + result.h / 2 - 0.5) < 1e-6);
  });

  it('clamps crop bounds within [0..1] when near an edge', () => {
    const crop = { x: 0.6, y: 0.6, w: 0.4, h: 0.4 };
    const result = fitCropToAspect(crop, 1000, 1000, 16 / 9);

    assert.ok(result.x >= 0 && result.y >= 0);
    assert.ok(result.x + result.w <= 1 + 1e-9);
    assert.ok(result.y + result.h <= 1 + 1e-9);
    const outAspect = (result.w * 1000) / (result.h * 1000);
    assert.ok(Math.abs(outAspect - 16 / 9) < 1e-6);
  });
});
