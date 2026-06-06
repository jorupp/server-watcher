const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onServersUpdate: (cb) => ipcRenderer.on('servers-update', (_, data) => cb(data)),
  onConfigError:   (cb) => ipcRenderer.on('config-error',   (_, err)  => cb(err)),
  reloadConfig:    ()   => ipcRenderer.invoke('reload-config'),
  pollNow:         ()   => ipcRenderer.invoke('poll-now'),
  joinServer:      (url) => ipcRenderer.invoke('join-server', url),
  testNotify:      (key) => ipcRenderer.invoke('test-notify', key),
});
