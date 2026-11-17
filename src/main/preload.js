'use strict';
/**
 * The renderer runs with context isolation and no Node access; this is the
 * entire surface it gets.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hud', {
  onState: (handler) => {
    ipcRenderer.on('hud:state', (_e, payload) => handler(payload));
  },
  ready: () => ipcRenderer.send('hud:ready'),
  setHeight: (h) => ipcRenderer.send('hud:height', h),
  setCollapsed: (v) => ipcRenderer.send('hud:collapsed', v),
  open: (target) => ipcRenderer.send('hud:open', target),
  hide: () => ipcRenderer.send('hud:hide'),
  quit: () => ipcRenderer.send('hud:quit'),
  setBudget: (v) => ipcRenderer.invoke('hud:budget', v),
});
