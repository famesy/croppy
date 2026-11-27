const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage } = require('electron');
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

function createWindow() {
  const win = new BrowserWindow({
    width: 1420,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: '#111114',
    title: 'InstraCrop Studio',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('dialog:openFiles', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Select Photos',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'avif'] },
    ],
  });
  if (canceled) return [];
  return collectImagesFromPaths(filePaths);
});

ipcMain.handle('dialog:openFolder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Select Photo Folder',
    properties: ['openDirectory'],
  });
  if (canceled || filePaths.length === 0) return [];
  return collectImagesFromPaths(filePaths);
});

ipcMain.handle('files:resolvePaths', async (_event, rawPaths) => {
  if (!Array.isArray(rawPaths)) return [];
  return collectImagesFromPaths(rawPaths);
});

ipcMain.handle('dialog:selectOutputDir', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Choose Export Folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || filePaths.length === 0) return null;
  return filePaths[0];
});

ipcMain.handle('export:saveImage', async (_event, { outputDir, fileName, buffer }) => {
  if (!outputDir || !fileName || !buffer) {
    throw new Error('Missing export parameters');
  }
  await fs.promises.mkdir(outputDir, { recursive: true });
  const targetPath = path.join(outputDir, fileName);
  await fs.promises.writeFile(targetPath, Buffer.from(buffer));
  return targetPath;
});

ipcMain.handle('files:getThumbnail', async (_event, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const thumb = await nativeImage.createThumbnailFromPath(filePath, { width: 128, height: 128 });
    if (!thumb.isEmpty()) {
      return `data:image/jpeg;base64,${thumb.toJPEG(75).toString('base64')}`;
    }
  } catch (_) {}
  try {
    const img = nativeImage.createFromPath(filePath);
    if (!img.isEmpty()) {
      const resized = img.resize({ width: 128 });
      return `data:image/jpeg;base64,${resized.toJPEG(75).toString('base64')}`;
    }
  } catch (_) {}
  return null;
});

ipcMain.handle('shell:openPath', async (_event, targetPath) => {
  if (!targetPath) return;
  await shell.openPath(targetPath);
});
