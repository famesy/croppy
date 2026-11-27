const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  isSupportedImage,
  toImageEntry,
  collectImagesFromPaths,
} = require('../src/file-utils');

describe('isSupportedImage', () => {
  it('accepts supported image extensions case-insensitively', () => {
    for (const ext of ['.jpg', '.JPEG', '.png', '.WebP', '.bmp', '.avif']) {
      assert.equal(isSupportedImage(`photo${ext}`), true);
    }
  });

  it('rejects unsupported file types', () => {
    for (const name of ['notes.txt', 'video.mp4', 'archive.zip', 'README']) {
      assert.equal(isSupportedImage(name), false);
    }
  });
});

describe('toImageEntry', () => {
  it('returns filePath, basename, and file:// URL', () => {
    const samplePath = path.join(os.tmpdir(), 'sample photo.jpg');
    const entry = toImageEntry(samplePath);
    assert.equal(entry.filePath, samplePath);
    assert.equal(entry.name, 'sample photo.jpg');
    assert.ok(entry.fileUrl.startsWith('file://'));
  });
});

describe('collectImagesFromPaths', () => {
  it('collects supported images recursively in natural sort order and deduplicates', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'croppy-test-'));
    try {
      const sub = path.join(root, 'nested');
      const deep = path.join(sub, 'deep');
      fs.mkdirSync(deep, { recursive: true });

      const img10 = path.join(root, 'img10.jpg');
      const img2 = path.join(root, 'img2.png');
      const txt = path.join(root, 'ignore.txt');
      const subImg = path.join(sub, 'sub.webp');
      const deepImg = path.join(deep, 'deep.avif');

      fs.writeFileSync(img10, '');
      fs.writeFileSync(img2, '');
      fs.writeFileSync(txt, '');
      fs.writeFileSync(subImg, '');
      fs.writeFileSync(deepImg, '');

      const collected = collectImagesFromPaths([root, img2, path.join(root, 'missing.jpg')]);
      const names = collected.map((c) => c.name);
      assert.deepEqual(names, ['img2.png', 'img10.jpg', 'deep.avif', 'sub.webp']);

      const shallow = collectImagesFromPaths([root], 1);
      assert.deepEqual(
        shallow.map((c) => c.name),
        ['img2.png', 'img10.jpg', 'sub.webp']
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
