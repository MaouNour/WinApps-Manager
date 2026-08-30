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

/**
 * Reads the VM's *actual* current configuration straight from libvirt
 * (`virsh dumpxml`), rather than trusting our own saved metadata - so RAM,
 * vCPUs and disk info shown in Details always reflect what the VM really
 * has, even if it was resized outside this app.
 */
async function getVmConfig(name) {
  const { stdout: xml } = await run('virsh', ['dumpxml', name]);
  const memoryKiB = Number((xml.match(/<memory[^>]*>(\d+)<\/memory>/) || [])[1] || 0);
  const currentMemoryKiB = Number((xml.match(/<currentMemory[^>]*>(\d+)<\/currentMemory>/) || [])[1] || 0);
  const vcpus = Number((xml.match(/<vcpu[^>]*>(\d+)<\/vcpu>/) || [])[1] || 0);
  const diskMatch = xml.match(/<disk[^>]*device=['"]disk['"][\s\S]*?<source file=['"]([^'"]+)['"]/);
  const diskPath = diskMatch ? diskMatch[1] : null;

  let diskSizeGiB = null;
  let diskAllocatedGiB = null;
  if (diskPath) {
    try {
      const { stdout: info } = await run('qemu-img', ['info', '--output=json', diskPath], { allowFail: true });
      const j = JSON.parse(info);
      if (j['virtual-size']) diskSizeGiB = Math.round((j['virtual-size'] / 1e9) * 10) / 10;
      if (j['actual-size']) diskAllocatedGiB = Math.round((j['actual-size'] / 1e9) * 10) / 10;
    } catch (_) { /* best effort */ }
  }

  return {
    name,
    memoryMiB: Math.round(memoryKiB / 1024),
    currentMemoryMiB: Math.round(currentMemoryKiB / 1024),
    vcpus,
    diskPath,
    diskSizeGiB,
    diskAllocatedGiB
  };
}

async function deleteVm(name, { deleteDisk = false } = {}) {
  await run('virsh', ['destroy', name], { allowFail: true });
  const flags = deleteDisk
    ? ['undefine', name, '--nvram', '--remove-all-storage']
    : ['undefine', name, '--nvram'];
  return run('virsh', flags);
}

module.exports = { listVms, startVm, shutdownVm, killVm, resetVm, deleteVm, getVmConfig };
