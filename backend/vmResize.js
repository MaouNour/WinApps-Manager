'use strict';
const { run, which } = require('./exec');

async function getDomState(name) {
  const { stdout } = await run('virsh', ['domstate', name], { allowFail: true });
  return stdout.trim();
}

/**
 * Changes vCPU count and/or max memory. Requires the VM to be shut off
 * (libvirt allows live vcpu/mem changes only within pre-declared
 * hotpluggable ranges, which our generated XML doesn't set up, so we keep
 * this simple and reliable: edit while off, then the caller can restart).
 */
async function resizeCompute(name, { vcpus, memoryMiB }) {
  const state = await getDomState(name);
  if (state !== 'shut off') {
    throw new Error(`VM must be shut off to resize CPU/RAM (currently: ${state}). Shut it down first.`);
  }
  const hasVirtXml = await which('virt-xml');
  if (!hasVirtXml) throw new Error("'virt-xml' not found (part of virtinst/virt-manager).");

  const args = [name, '--edit'];
  if (vcpus) args.push('--vcpus', String(vcpus));
  if (memoryMiB) args.push('--memory', String(memoryMiB));
  if (args.length === 2) return; // nothing to change

  await run('virt-xml', args);
}

/**
 * Grows the VM's qcow2 disk. This only extends the virtual disk file - the
 * NTFS partition inside Windows still needs "Extend Volume" in Disk
 * Management (or diskpart) afterwards to actually use the new space; we
 * surface that as a note in the UI rather than silently repartitioning.
 */
async function growDisk(name, diskPath, newSizeGiB) {
  const state = await getDomState(name);
  if (state !== 'shut off') {
    throw new Error(`VM must be shut off to resize its disk (currently: ${state}). Shut it down first.`);
  }
  await run('qemu-img', ['resize', diskPath, `${newSizeGiB}G`]);
}

module.exports = { resizeCompute, growDisk, getDomState };
