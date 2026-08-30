'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  host: {
    check: () => ipcRenderer.invoke('host:check')
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
    reconnect: (net) => ipcRenderer.invoke('net:reconnect', net)
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
    scan: (vmName) => ipcRenderer.invoke('apps:scan', vmName),
    catalogIsCached: () => ipcRenderer.invoke('apps:catalog:isCached'),
    catalogGet: () => ipcRenderer.invoke('apps:catalog:get'),
    catalogSync: (force) => ipcRenderer.invoke('apps:catalog:sync', force),
    onCatalogSyncProgress: (cb) => {
      const listener = (_e, line) => cb(line);
      ipcRenderer.on('apps:catalog:sync:progress', listener);
      return () => ipcRenderer.removeListener('apps:catalog:sync:progress', listener);
    },
    listEnabled: (catalog) => ipcRenderer.invoke('apps:enabled:list', catalog),
    enable: (app) => ipcRenderer.invoke('apps:enable', app),
    disable: (slug) => ipcRenderer.invoke('apps:disable', slug),
    detectMatches: (catalog, installedPrograms) => ipcRenderer.invoke('apps:detectMatches', catalog, installedPrograms)
  }
});
