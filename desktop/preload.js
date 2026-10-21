const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('officeStock', Object.freeze({
  settings: Object.freeze({
    read: () => ipcRenderer.invoke('settings:read'),
    validateAndSave: (config) => ipcRenderer.invoke('settings:validate-and-save', config)
  }),
  secure: Object.freeze({
    readSession: () => ipcRenderer.invoke('secure:read', 'session'),
    saveSession: (session) => ipcRenderer.invoke('secure:write', 'session', session),
    clearSession: () => ipcRenderer.invoke('secure:clear', 'session')
  }),
  auth: Object.freeze({
    onCallback: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, data) => callback(data);
      ipcRenderer.on('auth:callback', listener);
      ipcRenderer.send('auth:callback-ready');
      return () => ipcRenderer.removeListener('auth:callback', listener);
    }
  })
}));
