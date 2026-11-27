const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const SUPPORTED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.avif']);

function isSupportedImage(filePath) {
  return SUPPORTED_EXTS.has(path.extname(filePath).toLowerCase());
}

function toImageEntry(filePath) {
  return {
    filePath,
    name: path.basename(filePath),
    fileUrl: pathToFileURL(filePath).href,
  };
}

function collectImagesFromPaths(inputPaths, maxDepth = 4) {
  const results = [];
  const seen = new Set();

  function walk(p, depth) {
    if (!p || !fs.existsSync(p)) return;
    let stat;
    try {
      stat = fs.statSync(p);
    } catch (_) {
      return;
    }

    if (stat.isFile() && isSupportedImage(p)) {
      if (!seen.has(p)) {
        seen.add(p);
        results.push(toImageEntry(p));
      }
    } else if (stat.isDirectory() && depth <= maxDepth) {
      let entries;
      try {
        entries = fs.readdirSync(p, { withFileTypes: true });
      } catch (_) {
        return;
      }
      entries.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      );
      for (const e of entries) {
        const full = path.join(p, e.name);
        if (e.isFile() && isSupportedImage(e.name)) {
          if (!seen.has(full)) {
            seen.add(full);
            results.push(toImageEntry(full));
          }
        } else if (e.isDirectory() && depth < maxDepth) {
          walk(full, depth + 1);
        }
      }
    }
  }

  for (const p of inputPaths) {
    walk(p, 0);
  }

  return results;
}

module.exports = {
  SUPPORTED_EXTS,
  isSupportedImage,
  toImageEntry,
  collectImagesFromPaths,
};
