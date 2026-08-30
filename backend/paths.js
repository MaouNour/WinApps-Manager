'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

const HOME = os.homedir();

// Where WinApps itself expects things (do not change these - WinApps reads them directly).
const WINAPPS_CONF_DIR = path.join(HOME, '.config', 'winapps');
const WINAPPS_CONF_FILE = path.join(WINAPPS_CONF_DIR, 'winapps.conf');
const WINAPPS_APPS_DIR = path.join(HOME, '.local', 'share', 'winapps');
// Where WinApps' own installer writes .desktop launchers + wrapper scripts
// for enabled apps (user-mode install paths, per setup.sh/installer.sh).
// We write/remove files here directly for the in-app app picker so enabling
// or disabling an app has the exact same effect as running winapps-setup.
const DESKTOP_ENTRIES_DIR = path.join(HOME, '.local', 'share', 'applications');
const WINAPPS_BIN_DIR = path.join(HOME, '.local', 'bin');

// Where THIS manager app keeps its own state (cached ISOs, generated seed
// ISOs, scanned-app cache, per-VM metadata). Nothing here is required by
// WinApps itself - it's all this tool's own bookkeeping.
const APP_DATA_DIR = path.join(HOME, '.local', 'share', 'winapps-manager');
const VM_IMAGES_DIR = path.join(APP_DATA_DIR, 'images'); // qcow2 disks live here by default
const SEED_ISO_DIR = path.join(APP_DATA_DIR, 'seed-isos'); // generated autounattend/oem isos per VM
const DOWNLOADS_DIR = path.join(APP_DATA_DIR, 'downloads'); // cached VirtIO iso, script bundle
const VM_META_DIR = path.join(APP_DATA_DIR, 'vms'); // one JSON file per VM this tool created
const LOG_FILE = path.join(APP_DATA_DIR, 'manager.log');
// Local cache of the WinApps "apps/" catalog (icons + info per app), fetched
// once from the repo and reused offline forever after - same pattern as the
// existing oem-file caching in unattend.js.
const APP_CATALOG_DIR = path.join(APP_DATA_DIR, 'app-catalog');
const APP_CATALOG_MANIFEST = path.join(APP_CATALOG_DIR, 'manifest.json');

function ensureDirs() {
  for (const d of [
    APP_DATA_DIR, VM_IMAGES_DIR, SEED_ISO_DIR, DOWNLOADS_DIR, VM_META_DIR,
    WINAPPS_CONF_DIR, APP_CATALOG_DIR, DESKTOP_ENTRIES_DIR, WINAPPS_BIN_DIR
  ]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

// Known locations for the OVMF (UEFI) firmware across distros. We probe these
// at VM-creation time and pick whichever pair exists, so the generated
// domain XML always points at real files on this host.
const OVMF_CANDIDATES = [
  {
    code: '/usr/share/edk2/ovmf/OVMF_CODE_4M.secboot.qcow2',
    vars: '/usr/share/edk2/ovmf/OVMF_VARS_4M.secboot.qcow2',
    format: 'qcow2'
  },
  {
    code: '/usr/share/OVMF/OVMF_CODE_4M.ms.fd',
    vars: '/usr/share/OVMF/OVMF_VARS_4M.ms.fd',
    format: 'raw'
  },
  {
    code: '/usr/share/OVMF/OVMF_CODE.secboot.fd',
    vars: '/usr/share/OVMF/OVMF_VARS.fd',
    format: 'raw'
  },
  {
    code: '/usr/share/edk2-ovmf/x64/OVMF_CODE.secboot.fd',
    vars: '/usr/share/edk2-ovmf/x64/OVMF_VARS.fd',
    format: 'raw'
  }
];

function findOvmf() {
  for (const c of OVMF_CANDIDATES) {
    if (fs.existsSync(c.code) && fs.existsSync(c.vars)) return c;
  }
  return null;
}

module.exports = {
  HOME,
  WINAPPS_CONF_DIR,
  WINAPPS_CONF_FILE,
  WINAPPS_APPS_DIR,
  DESKTOP_ENTRIES_DIR,
  WINAPPS_BIN_DIR,
  APP_DATA_DIR,
  VM_IMAGES_DIR,
  SEED_ISO_DIR,
  DOWNLOADS_DIR,
  VM_META_DIR,
  LOG_FILE,
  APP_CATALOG_DIR,
  APP_CATALOG_MANIFEST,
  ensureDirs,
  findOvmf
};
