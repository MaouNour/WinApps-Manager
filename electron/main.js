'use strict';
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const { ensureDirs, VM_META_DIR } = require('../backend/paths');
const { checkHost } = require('../backend/hostCheck');
const { createVm } = require('../backend/vmCreate');
const vmctl = require('../backend/vmctl');
const network = require('../backend/network');
const winappsConfig = require('../backend/winappsConfig');
const winappsCli = require('../backend/winappsCli');
const appsScan = require('../backend/appsScan');
const vmStats = require('../backend/vmStats');
const vmResize = require('../backend/vmResize');
const guestControl = require('../backend/guestControl');
const winappsApps = require('../backend/winappsApps');
const hostStats = require('../backend/hostStats');

// Without a real GPU driver behind the display (common when the host is
// itself virtualized, or on some Wayland/Xorg + software-rendering setups),
// Chromium's GPU process repeatedly retries vsync ("GetVSyncParametersIfAvailable()
// failed") instead of falling back cleanly - burning CPU and dragging the
// compositor (gnome-shell/Xwayland) along with it. Disabling GPU acceleration
// drops the separate GPU process entirely and avoids that retry loop.
app.disableHardwareAcceleration();

let mainWindow;

// Without this, launching `npm start` a second time (e.g. once left running
// from earlier, then started again) spins up a whole second copy of every
// background poller (host stats, dashboard, per-VM details) - CPU load
// multiplies with each extra copy and never comes back down on its own,
// since nothing ever tells the older instance to stop. Enforce a single
// instance and just focus the existing window instead.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

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

if (gotLock) {
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
} // end if (gotLock)

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
// Passive/poll-safe: never prompts. Returns 'connected' | 'disconnected' | 'unknown'.
ipcMain.handle('net:status', (_e, networkName) => network.checkNetworkStatus(networkName));
ipcMain.handle('net:disconnect', (_e, networkName) => network.disconnectNetwork(networkName));
ipcMain.handle('net:reconnect', (_e, networkName) => network.reconnectNetwork(networkName));
ipcMain.handle('net:passwordlessStatus', (_e, networkName) => network.isPasswordlessNetworkControlInstalled(networkName));
ipcMain.handle('net:installPasswordless', (_e, networkName) => network.installPasswordlessNetworkControl(networkName));

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

// ---------- IPC: per-VM metadata (what this manager knows about a VM it created) ----------
ipcMain.handle('vm:meta', (_e, name) => {
  const p = path.join(VM_META_DIR, `${name}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
});

// ---------- IPC: live VM stats (CPU/RAM/disk/network) ----------
ipcMain.handle('vm:stats', (_e, name) => vmStats.getVmStats(name));

// ---------- IPC: actual live VM configuration straight from libvirt ----------
ipcMain.handle('vm:config', (_e, name) => vmctl.getVmConfig(name));

// ---------- IPC: host-level CPU/RAM/GPU, for the always-visible perf bar ----------
ipcMain.handle('host:stats', () => hostStats.getHostStats());

// ---------- IPC: resize compute/storage ----------
ipcMain.handle('vm:resizeCompute', (_e, name, opts) => vmResize.resizeCompute(name, opts));
ipcMain.handle('vm:growDisk', (_e, name, diskPath, newSizeGiB) => vmResize.growDisk(name, diskPath, newSizeGiB));
ipcMain.handle('vm:applyLibvirtOptimizations', (_e, name) => vmctl.applyLibvirtOptimizations(name));

// ---------- IPC: live Defender/Updates/Firewall/bloat-services control ----------
ipcMain.handle('guest:status', (_e, name) => guestControl.getGuestControlStatus(name));
ipcMain.handle('guest:toggle', (_e, name, feature, enabled) => guestControl.applyToggle(name, feature, enabled));
ipcMain.handle('guest:applyRecommended', (_e, name) => guestControl.applyRecommended(name));

// ---------- IPC: winboat-style app picker backed by WinApps' own detection ----------
ipcMain.handle('winappsApps:runDetection', async (event, scope) => {
  try {
    await winappsApps.runDetection(scope, (line) => event.sender.send('winappsApps:detectionLine', line));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('winappsApps:list', () => winappsApps.listDetectedApps());
ipcMain.handle('winappsApps:setEnabled', (_e, appId, enabled) => winappsApps.setAppEnabled(appId, enabled));
ipcMain.handle('winappsApps:addManual', (_e, exePath) => winappsApps.addManualApp(exePath));
