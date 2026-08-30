'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  app: {
    onVisibilityChange: (cb) => {
      const listener = (_e, visible) => cb(visible);
      ipcRenderer.on('window:visibility', listener);
      return () => ipcRenderer.removeListener('window:visibility', listener);
    }
  },
  host: {
    check: () => ipcRenderer.invoke('host:check'),
    stats: () => ipcRenderer.invoke('host:stats')
  },
  dialogs: {
    pickIso: (opts) => ipcRenderer.invoke('dialog:pickIso', opts)
  },
  vm: {
    create: (opts) => ipcRenderer.invoke('vm:create', opts),
    onCreateProgress: (cb) => {
      const listener = (_e, progress) => cb(progress);
      ipcRenderer.on('vm:create:progress', listener);
      return () => ipcRenderer.removeListener('vm:create:progress', listener);
    },
    list: () => ipcRenderer.invoke('vm:list'),
    start: (name) => ipcRenderer.invoke('vm:start', name),
    shutdown: (name) => ipcRenderer.invoke('vm:shutdown', name),
    kill: (name) => ipcRenderer.invoke('vm:kill', name),
    reset: (name) => ipcRenderer.invoke('vm:reset', name),
    delete: (name, opts) => ipcRenderer.invoke('vm:delete', name, opts)
  },
  net: {
    status: (net) => ipcRenderer.invoke('net:status', net),
    disconnect: (net) => ipcRenderer.invoke('net:disconnect', net),
    reconnect: (net) => ipcRenderer.invoke('net:reconnect', net),
    passwordlessStatus: (net) => ipcRenderer.invoke('net:passwordlessStatus', net),
    installPasswordless: (net) => ipcRenderer.invoke('net:installPasswordless', net)
  },
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (patch) => ipcRenderer.invoke('config:set', patch)
  },
  winapps: {
    isInstalled: () => ipcRenderer.invoke('winapps:isInstalled'),
    launchInstaller: () => ipcRenderer.invoke('winapps:launchInstaller'),
    launchAppRefresh: () => ipcRenderer.invoke('winapps:launchAppRefresh'),
    check: () => ipcRenderer.invoke('winapps:check')
  },
  apps: {
    scan: (vmName) => ipcRenderer.invoke('apps:scan', vmName)
  },
  vmExtra: {
    meta: (name) => ipcRenderer.invoke('vm:meta', name),
    stats: (name) => ipcRenderer.invoke('vm:stats', name),
    config: (name) => ipcRenderer.invoke('vm:config', name),
    resizeCompute: (name, opts) => ipcRenderer.invoke('vm:resizeCompute', name, opts),
    growDisk: (name, diskPath, newSizeGiB) => ipcRenderer.invoke('vm:growDisk', name, diskPath, newSizeGiB),
    applyLibvirtOptimizations: (name) => ipcRenderer.invoke('vm:applyLibvirtOptimizations', name)
  },
  guest: {
    status: (name) => ipcRenderer.invoke('guest:status', name),
    toggle: (name, feature, enabled) => ipcRenderer.invoke('guest:toggle', name, feature, enabled),
    applyRecommended: (name) => ipcRenderer.invoke('guest:applyRecommended', name)
  },
  winappsApps: {
    runDetection: (scope) => ipcRenderer.invoke('winappsApps:runDetection', scope),
    onDetectionLine: (cb) => {
      const listener = (_e, line) => cb(line);
      ipcRenderer.on('winappsApps:detectionLine', listener);
      return () => ipcRenderer.removeListener('winappsApps:detectionLine', listener);
    },
    list: () => ipcRenderer.invoke('winappsApps:list'),
    setEnabled: (appId, enabled) => ipcRenderer.invoke('winappsApps:setEnabled', appId, enabled),
    addManual: (exePath) => ipcRenderer.invoke('winappsApps:addManual', exePath)
  },
  appsCatalog: {
    status: () => ipcRenderer.invoke('appsCatalog:status'),
    sync: (force) => ipcRenderer.invoke('appsCatalog:sync', force),
    onSyncLine: (cb) => {
      const listener = (_e, line) => cb(line);
      ipcRenderer.on('appsCatalog:syncLine', listener);
      return () => ipcRenderer.removeListener('appsCatalog:syncLine', listener);
    },
    list: () => ipcRenderer.invoke('appsCatalog:list'),
    setEnabled: (slug, enabled) => ipcRenderer.invoke('appsCatalog:setEnabled', slug, enabled),
    detectMatches: (vmName) => ipcRenderer.invoke('appsCatalog:detectMatches', vmName)
  }
});
