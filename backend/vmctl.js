'use strict';
const { run } = require('./exec');

async function listVms() {
  const { stdout } = await run('virsh', ['list', '--all', '--name']);
  const names = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const vms = [];
  for (const name of names) {
    const { stdout: state } = await run('virsh', ['domstate', name], { allowFail: true });
    vms.push({ name, state: state.trim() });
  }
  return vms;
}

// Equivalent to: alias winvm-start="virsh start RDPWindows"
async function startVm(name) {
  return run('virsh', ['start', name]);
}

// Equivalent to: alias winvm-stop="virsh shutdown RDPWindows"  (graceful ACPI shutdown)
async function shutdownVm(name) {
  return run('virsh', ['shutdown', name]);
}

// Equivalent to: alias winvm-kill="virsh destroy RDPWindows"  (hard power-off)
async function killVm(name) {
  return run('virsh', ['destroy', name]);
}

// Equivalent to: alias winvm-restart="virsh reset RDPWindows"  (hard reset, like the power button)
async function resetVm(name) {
  return run('virsh', ['reset', name]);
}

async function deleteVm(name, { deleteDisk = false } = {}) {
  await run('virsh', ['destroy', name], { allowFail: true });
  const flags = deleteDisk
    ? ['undefine', name, '--nvram', '--remove-all-storage']
    : ['undefine', name, '--nvram'];
  return run('virsh', flags);
}

module.exports = { listVms, startVm, shutdownVm, killVm, resetVm, deleteVm };
