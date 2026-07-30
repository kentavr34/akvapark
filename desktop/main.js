// Windows-обёртка игры: одно окно, локальная копия index.html внутри
// приложения (никогда не показывает витрину сайта — только саму игру,
// как и Android-версия), плюс тот же тихий фоновый апдейтер.
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { Updater } = require('./updater');

const BUNDLED_GAME = app.isPackaged
  ? path.join(process.resourcesPath, 'game', 'index.html')
  : path.join(__dirname, 'resources', 'game', 'index.html');

function bundledBuild() {
  try {
    const text = fs.readFileSync(BUNDLED_GAME, 'utf8');
    const m = /const AKVA_BUILD = (\d+);/.exec(text);
    return m ? parseInt(m[1], 10) : 0;
  } catch (_) { return 0; }
}

let win = null;
let updater = null;
let lastCheck = 0;

function currentGameUrl() {
  const p = updater.currentGamePath(BUNDLED_GAME, bundledBuild());
  return 'file://' + p.replace(/\\/g, '/');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#04121c',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  win.setMenuBarVisibility(false);
  win.loadURL(currentGameUrl());
  if (process.env.AKVA_SMOKE_TEST) {
    win.webContents.on('did-finish-load', () => {
      win.webContents.executeJavaScript(
        '({title:document.title, hasG: typeof G, akvaNative: typeof window.AkvaNative, mode: (typeof G!=="undefined"?G.mode:null)})'
      ).then((r) => { console.log('SMOKE_RESULT ' + JSON.stringify(r)); setTimeout(() => app.quit(), 500); });
    });
  }
  return win;
}

function checkForUpdate(delayMs) {
  const now = Date.now();
  if (now - lastCheck < 30000) return;
  lastCheck = now;
  setTimeout(async () => {
    const have = updater.installedBuild(bundledBuild());
    const result = await updater.check(have);
    if (result && win && !win.isDestroyed()) {
      const js = `(function(){try{if(window.AkvaApp&&AkvaApp.nativeUpdateReady)` +
        `AkvaApp.nativeUpdateReady(${result.build},'${String(result.version).replace(/'/g, '')}');}catch(e){}})()`;
      win.webContents.executeJavaScript(js).catch(() => {});
    }
  }, delayMs);
}

app.whenReady().then(() => {
  updater = new Updater(path.join(app.getPath('userData'), 'live'));

  ipcMain.handle('akva:restart', () => {
    if (win && !win.isDestroyed()) win.loadURL(currentGameUrl());
  });
  ipcMain.handle('akva:checkUpdate', () => {
    lastCheck = 0;
    checkForUpdate(0);
  });
  ipcMain.handle('akva:installedBuild', () => updater.installedBuild(bundledBuild()));

  createWindow();
  checkForUpdate(1200);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('browser-window-focus', () => checkForUpdate(2500));

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
