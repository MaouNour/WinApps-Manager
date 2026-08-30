'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

const HOME = os.homedir();

// Where WinApps itself expects things (do not change these - WinApps reads them directly).
const WINAPPS_CONF_DIR = path.join(HOME, '.config', 'winapps');
const WINAPPS_CONF_FILE = path.join(WINAPPS_CONF_DIR, 'winapps.conf');
const WINAPPS_APPS_DIR = path.join(HOME, '.local', 'share', 'winapps');

// Where THIS manager app keeps its own state (cached ISOs, generated seed
// ISOs, scanned-app cache, per-VM metadata). Nothing here is required by
// WinApps itself - it's all this tool's own bookkeeping.
const APP_DATA_DIR = path.join(HOME, '.local', 'share', 'winapps-manager');
const VM_IMAGES_DIR = path.join(APP_DATA_DIR, 'images'); // qcow2 disks live here by default
const SEED_ISO_DIR = path.join(APP_DATA_DIR, 'seed-isos'); // generated autounattend/oem isos per VM
const DOWNLOADS_DIR = path.join(APP_DATA_DIR, 'downloads'); // cached VirtIO iso, script bundle
const VM_META_DIR = path.join(APP_DATA_DIR, 'vms'); // one JSON file per VM this tool created
const BIN_DIR = path.join(APP_DATA_DIR, 'bin'); // our own scripts get copied here so they have a stable, executable, sudoers-friendly path
const LOG_FILE = path.join(APP_DATA_DIR, 'manager.log');

// Where the app ships its bundled scripts from (repo root in dev, or
// process.resourcesPath once packaged - `electron .` runs this unpacked
// either way, so both resolve to a real file on disk).
const RESOURCES_DIR = path.join(__dirname, '..', 'resources');
const BUNDLED_NETWORK_CTL_SCRIPT = path.join(RESOURCES_DIR, 'scripts', 'winapps-ctl.sh');
// Stable, writable copy the app actually invokes (and the one referenced by
// the sudoers NOPASSWD rule) - see backend/network.js.
const NETWORK_CTL_SCRIPT = path.join(BIN_DIR, 'winapps-ctl.sh');

function ensureDirs() {
  for (const d of [APP_DATA_DIR, VM_IMAGES_DIR, SEED_ISO_DIR, DOWNLOADS_DIR, VM_META_DIR, BIN_DIR, WINAPPS_CONF_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
  // Keep the deployed copy of the control script in sync with the bundled
  // one (covers first run and app updates alike).
  try {
    if (fs.existsSync(BUNDLED_NETWORK_CTL_SCRIPT)) {
      const bundled = fs.readFileSync(BUNDLED_NETWORK_CTL_SCRIPT, 'utf8');
      const deployed = fs.existsSync(NETWORK_CTL_SCRIPT) ? fs.readFileSync(NETWORK_CTL_SCRIPT, 'utf8') : null;
      if (bundled !== deployed) fs.writeFileSync(NETWORK_CTL_SCRIPT, bundled);
      fs.chmodSync(NETWORK_CTL_SCRIPT, 0o755);
    }
  } catch (_) { /* best effort - network.js surfaces a clear error if this never lands */ }
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
  APP_DATA_DIR,
  VM_IMAGES_DIR,
  SEED_ISO_DIR,
  DOWNLOADS_DIR,
  VM_META_DIR,
  BIN_DIR,
  RESOURCES_DIR,
  BUNDLED_NETWORK_CTL_SCRIPT,
  NETWORK_CTL_SCRIPT,
  LOG_FILE,
  ensureDirs,
  findOvmf
};
