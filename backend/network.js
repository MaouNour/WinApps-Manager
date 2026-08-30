'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const { run } = require('./exec');
const { NETWORK_CTL_SCRIPT } = require('./paths');

const SUDOERS_FILE = '/etc/sudoers.d/90-winapps-manager-network';

/** Reads the <ip address=".." netmask=".."/> of a libvirt network and returns CIDR, e.g. 192.168.122.0/24. */
async function getNetworkCidr(networkName = 'default') {
  const { stdout } = await run('virsh', ['net-dumpxml', networkName]);
  const m = stdout.match(/<ip address='([^']+)'\s+netmask='([^']+)'/) ||
    stdout.match(/<ip address="([^"]+)"\s+netmask="([^"]+)"/);
  if (!m) throw new Error(`Could not determine subnet for libvirt network '${networkName}'.`);
  const [, addr, mask] = m;
  const cidr = netmaskToCidr(mask);
  const network = addr.split('.').map(Number);
  network[3] = 0; // assume the doc's typical /24; good enough for the default NAT network
  return `${network.join('.')}/${cidr}`;
}

function netmaskToCidr(mask) {
  return mask
    .split('.')
    .map(Number)
    .reduce((acc, octet) => acc + octet.toString(2).split('1').length - 1, 0);
}

/**
 * Non-interactive only - runs `winapps-ctl.sh network <action> <subnet>` via
 * `sudo -n`. Never prompts, never falls back to pkexec. Rejects immediately
 * if the NOPASSWD rule isn't installed (or sudo isn't configured that way).
 *
 * This is the ONLY thing the background poller is allowed to call. A passive
 * status poll must never trigger an interactive auth prompt - if it did,
 * every polling tick (e.g. every 4s) would pop a graphical pkexec dialog,
 * which is exactly the "prompts every 5 seconds" bug.
 */
async function runNetScriptQuiet(action, subnet) {
  if (!fs.existsSync(NETWORK_CTL_SCRIPT)) {
    throw new Error(`Bundled control script missing at ${NETWORK_CTL_SCRIPT} (reinstall/reopen the app to redeploy it).`);
  }
  const { stdout } = await run('sudo', ['-n', NETWORK_CTL_SCRIPT, 'network', action, subnet]);
  return stdout;
}

/**
 * Runs `winapps-ctl.sh network <action> <subnet>` as root, for an explicit
 * user-initiated action (Connect/Disconnect button, or Setup Check). Tries
 * non-interactive `sudo -n` first (instant, no prompt, once
 * installPasswordlessNetworkControl() / install.sh has been run once). If
 * that's not set up yet, falls back to a one-off graphical `pkexec` prompt
 * so the button still works out of the box - but this path is only ever
 * reached from a direct user click, never from background polling.
 */
async function runNetScriptInteractive(action, subnet) {
  if (!fs.existsSync(NETWORK_CTL_SCRIPT)) {
    throw new Error(`Bundled control script missing at ${NETWORK_CTL_SCRIPT} (reinstall/reopen the app to redeploy it).`);
  }
  try {
    return await runNetScriptQuiet(action, subnet);
  } catch (_) {
    const { stdout } = await run('pkexec', [NETWORK_CTL_SCRIPT, 'network', action, subnet]);
    return stdout;
  }
}

// Equivalent to: alias stop-win-network="sudo iptables -A FORWARD -s <subnet> -d 0.0.0.0/0 -j DROP"
async function disconnectNetwork(networkName = 'default') {
  const subnet = await getNetworkCidr(networkName);
  await runNetScriptInteractive('stop', subnet);
  return { subnet };
}

// Equivalent to: alias connect-win-network="sudo iptables -D FORWARD -s <subnet> -d 0.0.0.0/0 -j DROP"
async function reconnectNetwork(networkName = 'default') {
  const subnet = await getNetworkCidr(networkName);
  await runNetScriptInteractive('start', subnet);
  return { subnet };
}

/**
 * Passive status check for the background poller. Returns 'connected',
 * 'disconnected', or 'unknown' - NEVER throws, NEVER prompts (no pkexec
 * fallback). 'unknown' means the passwordless rule isn't installed yet
 * (or sudo/the script isn't reachable) - the UI should show a "set up
 * passwordless toggle" hint in that case, not retry with an auth dialog.
 */
async function checkNetworkStatus(networkName = 'default') {
  let subnet;
  try {
    subnet = await getNetworkCidr(networkName);
  } catch (_) {
    return 'unknown';
  }
  try {
    const out = await runNetScriptQuiet('status', subnet);
    if (/state=disconnected/.test(out)) return 'disconnected';
    if (/state=connected/.test(out)) return 'connected';
    return 'unknown';
  } catch (_) {
    return 'unknown';
  }
}

/** True if the DROP rule for this network's subnet currently exists. 'unknown' reads as false (connected/unblocked assumed). */
async function isNetworkDisconnected(networkName = 'default') {
  return (await checkNetworkStatus(networkName)) === 'disconnected';
}

/**
 * Whether the passwordless (NOPASSWD) sudoers rule for this exact script +
 * subnet is in place, i.e. whether network toggling will run with no sudo
 * prompt at all. Checked with a non-interactive `sudo -n` call (never
 * prompts - fails immediately if a password would be required).
 */
async function isPasswordlessNetworkControlInstalled(networkName = 'default') {
  return (await checkNetworkStatus(networkName)) !== 'unknown';
}

/**
 * One-time setup: installs a NOPASSWD sudoers rule scoped to exactly the
 * three commands network toggling needs (status/stop/start on this VM's
 * subnet, running only our own bundled script - never a raw iptables
 * grant). Requires one graphical authorization (pkexec); after this,
 * connect/disconnect/status never prompt again.
 */
async function installPasswordlessNetworkControl(networkName = 'default') {
  if (!fs.existsSync(NETWORK_CTL_SCRIPT)) {
    throw new Error(`Bundled control script missing at ${NETWORK_CTL_SCRIPT}.`);
  }
  const subnet = await getNetworkCidr(networkName);
  const user = os.userInfo().username;
  const line = (action) => `${NETWORK_CTL_SCRIPT} network ${action} ${subnet}`;
  const content =
    `# Installed by WinApps Manager - passwordless network isolation toggle.\n` +
    `# Scoped to exactly this script and this VM subnet; never grants raw iptables.\n` +
    `${user} ALL=(root) NOPASSWD: ${line('status')}, ${line('stop')}, ${line('start')}\n`;

  const tmpFile = path.join(os.tmpdir(), `winapps-manager-sudoers-${Date.now()}`);
  fs.writeFileSync(tmpFile, content, { mode: 0o440 });

  try {
    // Validate syntax before it ever touches /etc/sudoers.d - a broken
    // sudoers file can lock sudo out system-wide, so this check is mandatory.
    await run('visudo', ['-c', '-f', tmpFile]);
    // Install it as root, with the correct mode, via a single graphical prompt.
    await run('pkexec', ['install', '-m', '0440', '-o', 'root', '-g', 'root', tmpFile, SUDOERS_FILE]);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
  return { subnet };
}

module.exports = {
  getNetworkCidr,
  disconnectNetwork,
  reconnectNetwork,
  isNetworkDisconnected,
  checkNetworkStatus,
  isPasswordlessNetworkControlInstalled,
  installPasswordlessNetworkControl
};
