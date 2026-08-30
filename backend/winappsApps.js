'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { run, which } = require('./exec');
const { WINAPPS_APPS_DIR } = require('./paths');

const HOME = os.homedir();
const USER_APPLICATIONS_DIR = path.join(HOME, '.local', 'share', 'applications');
const SYSTEM_APPLICATIONS_DIR = '/usr/share/applications';

const SRC_DIR_CANDIDATES = [
  path.join(HOME, '.local', 'bin', 'winapps-src'),
  '/usr/local/bin/winapps-src',
  path.join(HOME, '.winapps'),
  path.join(HOME, 'winapps')
];

async function findInstallerScript() {
  for (const dir of SRC_DIR_CANDIDATES) {
    const p = path.join(dir, 'installer.sh');
    if (fs.existsSync(p)) return p;
  }
  // Fall back to resolving via the `winapps` binary's location, per the
  // winapps-launcher docs (bin/winapps sits under WINAPPS_SRC_DIR/bin/).
  const winappsBin = await which('winapps');
  if (winappsBin) {
    const guessSrc = path.resolve(path.dirname(winappsBin), '..');
    const p = path.join(guessSrc, 'installer.sh');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Runs WinApps' own detection/installer non-interactively, exactly per the
 * documented flags:
 *   ./installer.sh --user     # current-user shortcuts
 *   ./installer.sh --system   # system-wide shortcuts
 * This is the real RDP-based scan (it boots a hidden RDP session running
 * ExtractPrograms.ps1 inside Windows) - we don't reimplement it, we just
 * drive it and stream its output as progress lines.
 */
async function runDetection(scope = 'user', onLine) {
  const script = await findInstallerScript();
  if (!script) {
    throw new Error('Could not locate installer.sh - is WinApps installed? Use the "Install WinApps" button first.');
  }
  const flag = scope === 'system' ? '--system' : '--user';
  await run('bash', [script, flag], { onLine, allowFail: false });
}

/** Adds a single arbitrary (not community-configured) app by its in-guest exe path. */
async function addManualApp(exePath) {
  const bin = await which('winapps');
  if (!bin) throw new Error('winapps CLI not found on PATH.');
  return run(bin, ['manual', exePath]);
}

function parseDesktopEntry(text) {
  const fields = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Za-z]+)=(.*)$/);
    if (m) fields[m[1]] = m[2];
  }
  return fields;
}

/** Reads every app WinApps has already detected/cached (icon.png + info), regardless of whether it's currently shown in the launcher. */
function listDetectedApps() {
  const appsRoot = path.join(WINAPPS_APPS_DIR, 'apps');
  if (!fs.existsSync(appsRoot)) return [];
  const out = [];
  for (const dirName of fs.readdirSync(appsRoot)) {
    const dir = path.join(appsRoot, dirName);
    const infoPath = path.join(dir, 'info');
    const iconPath = path.join(dir, 'icon.png');
    if (!fs.existsSync(infoPath)) continue;
    const fields = parseDesktopEntry(fs.readFileSync(infoPath, 'utf8'));
    let iconDataUri = null;
    if (fs.existsSync(iconPath)) {
      iconDataUri = 'data:image/png;base64,' + fs.readFileSync(iconPath).toString('base64');
    }
    out.push({
      id: dirName,
      name: fields.Name || dirName,
      comment: fields.Comment || '',
      exec: fields.Exec || '',
      iconDataUri,
      enabled: isShortcutEnabled(dirName, fields)
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function findDesktopFile(appId, fields) {
  for (const dir of [USER_APPLICATIONS_DIR, SYSTEM_APPLICATIONS_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.desktop')) continue;
      const full = path.join(dir, f);
      let text;
      try {
        text = fs.readFileSync(full, 'utf8');
      } catch (_) {
        continue;
      }
      // Match by exe id in the Exec= line (winapps' desktop files invoke
      // the wrapper with the app id / exe name as an argument).
      if (text.includes(appId) || (fields.Exec && text.includes(fields.Exec.split(' ')[0]))) {
        return full;
      }
    }
  }
  return null;
}

function isShortcutEnabled(appId, fields) {
  const desktopFile = findDesktopFile(appId, fields);
  if (!desktopFile) return false;
  const text = fs.readFileSync(desktopFile, 'utf8');
  return !/^NoDisplay=true/m.test(text);
}

/** Toggles visibility of an already-detected app's launcher without deleting anything WinApps generated. */
function setAppEnabled(appId, enabled) {
  const appsRoot = path.join(WINAPPS_APPS_DIR, 'apps');
  const infoPath = path.join(appsRoot, appId, 'info');
  if (!fs.existsSync(infoPath)) throw new Error(`Unknown app '${appId}'`);
  const fields = parseDesktopEntry(fs.readFileSync(infoPath, 'utf8'));
  const desktopFile = findDesktopFile(appId, fields);
  if (!desktopFile) {
    throw new Error(`Could not find "${fields.Name || appId}"'s launcher under ${USER_APPLICATIONS_DIR} - try running "Detect apps" again.`);
  }
  let text = fs.readFileSync(desktopFile, 'utf8');
  text = text.replace(/^NoDisplay=.*\n?/m, '');
  if (!enabled) {
    text = text.trimEnd() + '\nNoDisplay=true\n';
  }
  fs.writeFileSync(desktopFile, text);
  return true;
}

module.exports = { runDetection, addManualApp, listDetectedApps, setAppEnabled, findInstallerScript };
