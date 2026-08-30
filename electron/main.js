'use strict';
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');

const { ensureDirs } = require('../backend/paths');
const { checkHost } = require('../backend/hostCheck');
const { createVm } = require('../backend/vmCreate');
const vmctl = require('../backend/vmctl');
const network = require('../backend/network');
const winappsConfig = require('../backend/winappsConfig');
const winappsCli = require('../backend/winappsCli');
const appsScan = require('../backend/appsScan');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
}

app.whenReady().then(() => {
  ensureDirs();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- IPC: host checks ----------
ipcMain.handle('host:check', () => checkHost());

// ---------- IPC: file pickers ----------
ipcMain.handle('dialog:pickIso', async (_e, opts) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: opts?.title || 'Select ISO',
    properties: ['openFile'],
    filters: [{ name: 'ISO images', extensions: ['iso'] }]
  });
  return res.canceled ? null : res.filePaths[0];
});

// ---------- IPC: VM creation with streamed progress ----------
ipcMain.handle('vm:create', async (event, opts) => {
  try {
    const result = await createVm(opts, (progress) => {
      event.sender.send('vm:create:progress', progress);
    });
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------- IPC: VM lifecycle ----------
ipcMain.handle('vm:list', () => vmctl.listVms());
ipcMain.handle('vm:start', (_e, name) => vmctl.startVm(name));
ipcMain.handle('vm:shutdown', (_e, name) => vmctl.shutdownVm(name));
ipcMain.handle('vm:kill', (_e, name) => vmctl.killVm(name));
ipcMain.handle('vm:reset', (_e, name) => vmctl.resetVm(name));
ipcMain.handle('vm:delete', (_e, name, opts) => vmctl.deleteVm(name, opts));

// ---------- IPC: per-VM network toggle ----------
ipcMain.handle('net:status', (_e, networkName) => network.isNetworkDisconnected(networkName));
ipcMain.handle('net:disconnect', (_e, networkName) => network.disconnectNetwork(networkName));
ipcMain.handle('net:reconnect', (_e, networkName) => network.reconnectNetwork(networkName));

// ---------- IPC: winapps.conf editor ----------
ipcMain.handle('config:get', () => winappsConfig.getConfig());
ipcMain.handle('config:set', (_e, patch) => winappsConfig.setConfig(patch));

// ---------- IPC: WinApps CLI (installer / app refresh) ----------
ipcMain.handle('winapps:isInstalled', () => winappsCli.isWinappsInstalled());
ipcMain.handle('winapps:launchInstaller', () => winappsCli.launchInstaller());
ipcMain.handle('winapps:launchAppRefresh', () => winappsCli.launchAppRefresh());
ipcMain.handle('winapps:check', () => winappsCli.runCheck());

// ---------- IPC: read-only installed-apps preview ----------
ipcMain.handle('apps:scan', (_e, vmName) => appsScan.scanInstalledApps(vmName));
