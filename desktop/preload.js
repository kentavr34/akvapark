// Мост «страница -> приложение», в точности повторяющий контракт
// AkvaNative из Android-обёртки (android/.../MainActivity.java) — сама
// игра (index.html) уже умеет с ним работать без каких-либо правок.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('AkvaNative', {
  restart: () => ipcRenderer.invoke('akva:restart'),
  checkUpdate: () => ipcRenderer.invoke('akva:checkUpdate'),
  installedBuild: () => ipcRenderer.invoke('akva:installedBuild'),
  isNative: () => true
});
