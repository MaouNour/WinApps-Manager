'use strict';
const { spawn } = require('child_process');
const { which, run } = require('./exec');

const TERMINALS = [
  ['x-terminal-emulator', ['-e']],
  ['gnome-terminal', ['--']],
  ['konsole', ['-e']],
  ['xfce4-terminal', ['-e']],
  ['xterm', ['-e']]
];

async function findTerminal() {
  for (const [bin, prefixArgs] of TERMINALS) {
    const p = await which(bin);
    if (p) return { bin, prefixArgs };
  }
  return null;
}

async function isWinappsInstalled() {
  const p = await which('winapps') || await which('winapps-setup');
  return !!p;
}

/** Runs `bash <(curl .../setup.sh)` (the exact command docs/libvirt.md tells you to run) in a visible terminal window. */
async function launchInstaller() {
  const term = await findTerminal();
  const cmd = 'bash <(curl -fsSL https://raw.githubusercontent.com/winapps-org/winapps/main/setup.sh); echo; read -p "Press Enter to close..."';
  if (!term) {
    throw new Error('No terminal emulator found (tried x-terminal-emulator, gnome-terminal, konsole, xfce4-terminal, xterm). Run manually: ' + cmd);
  }
  spawn(term.bin, [...term.prefixArgs, 'bash', '-lc', cmd], { detached: true, stdio: 'ignore' }).unref();
}

/** Re-runs the setup wizard's app-detection step (the officially supported way to refresh the app menu with newly installed Windows programs), in manual mode so the user gets checkboxes. */
async function launchAppRefresh() {
  const term = await findTerminal();
  const bin = (await which('winapps-setup')) || (await which('winapps'));
  if (!bin) throw new Error('WinApps is not installed yet - run the installer first.');
  const cmd = `"${bin}"; echo; read -p "Press Enter to close..."`;
  if (!term) {
    throw new Error('No terminal emulator found. Run manually: ' + bin);
  }
  spawn(term.bin, [...term.prefixArgs, 'bash', '-lc', cmd], { detached: true, stdio: 'ignore' }).unref();
}

/** `winapps check` if available - verifies RDP connectivity per the README. */
async function runCheck() {
  const bin = await which('winapps');
  if (!bin) throw new Error('winapps CLI not found on PATH.');
  return run(bin, ['check'], { allowFail: true });
}

module.exports = { isWinappsInstalled, launchInstaller, launchAppRefresh, runCheck, findTerminal };
