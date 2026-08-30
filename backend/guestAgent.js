'use strict';
const { run } = require('./exec');

async function agentCommand(vmName, qmpJson) {
  const { stdout } = await run('virsh', ['qemu-agent-command', vmName, JSON.stringify(qmpJson), '--pretty']);
  return JSON.parse(stdout);
}

async function ping(vmName) {
  try {
    await agentCommand(vmName, { execute: 'guest-ping' });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Runs a PowerShell one-liner inside the guest via guest-exec and returns
 * its captured stdout once finished. Used only for read-only inventory
 * (e.g. listing installed programs) - never for anything destructive,
 * since that's WinApps' own `winapps-setup`'s job.
 */
async function runPowerShell(vmName, script, timeoutMs = 20000) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const exec = await agentCommand(vmName, {
    execute: 'guest-exec',
    arguments: {
      path: 'powershell.exe',
      arg: ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      'capture-output': true
    }
  });
  const pid = exec.return.pid;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 500));
    const status = await agentCommand(vmName, {
      execute: 'guest-exec-status',
      arguments: { pid }
    });
    if (status.return.exited) {
      const outB64 = status.return['out-data'] || '';
      return Buffer.from(outB64, 'base64').toString('utf8');
    }
  }
  throw new Error('Timed out waiting for guest-exec to finish.');
}

module.exports = { agentCommand, ping, runPowerShell };
