const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  resolvePaths: (paths) => ipcRenderer.invoke('files:resolvePaths', paths),
  selectOutputDir: () => ipcRenderer.invoke('dialog:selectOutputDir'),
  saveImage: (payload) => ipcRenderer.invoke('export:saveImage', payload),
  openPath: (targetPath) => ipcRenderer.invoke('shell:openPath', targetPath),
  getThumbnail: (filePath) => ipcRenderer.invoke('files:getThumbnail', filePath),
  getPathForFile: (file) => webUtils.getPathForFile(file),
});
