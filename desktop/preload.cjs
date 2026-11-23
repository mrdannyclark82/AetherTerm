// Exposes a small, fixed API to the AetherTerm page. No token, no Node access.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('aetherDesktop', {
  isDesktop: true,
  folders: () => ipcRenderer.invoke('aether:folders'),
  pickFolder: () => ipcRenderer.invoke('aether:pick-folder'),
  removeFolder: (folder) => ipcRenderer.invoke('aether:remove-folder', String(folder)),
  trash: (root, rel) => ipcRenderer.invoke('aether:trash', String(root), String(rel)),
});
