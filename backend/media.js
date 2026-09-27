'use strict';
const { run } = require('./exec');

/** True if the VM is currently running (--live is only valid, and only needed, then). */
async function isRunning(name) {
  try {
    const { stdout } = await run('virsh', ['domstate', name], { allowFail: true, timeoutMs: 5000 });
    return stdout.trim() === 'running';
  } catch (_) {
    return false;
  }
}

function guessLabel(sourceFile) {
  if (!sourceFile) return 'Empty drive';
  const lower = sourceFile.toLowerCase();
  if (lower.includes('virtio')) return 'VirtIO driver ISO';
  if (lower.includes('seed-isos')) return 'WinApps seed ISO (autounattend/oem)';
  if (lower.includes('office')) return 'Office ISO';
  if (lower.includes('win10') || lower.includes('win11') || lower.includes('windows')) return 'Windows install ISO';
  return 'ISO';
}

/**
 * Lists every cdrom drive on the domain (Windows ISO, VirtIO driver ISO,
 * WinApps seed ISO, plus anything attached later - e.g. an Office ISO),
 * straight from `virsh dumpxml` so it reflects the VM's real current state
 * rather than what New VM originally attached. `sourceFile` is null for an
 * already-ejected/empty drive.
 */
async function listMedia(name) {
  const { stdout: xml } = await run('virsh', ['dumpxml', name]);
  const diskBlocks = xml.match(/<disk\b[^>]*device=['"]cdrom['"][\s\S]*?<\/disk>/g) || [];
  return diskBlocks.map((block) => {
    const target = (block.match(/<target[^>]*dev=['"]([^'"]+)['"]/) || [])[1] || '?';
    const sourceFile = (block.match(/<source[^>]*file=['"]([^'"]+)['"]/) || [])[1] || null;
    return { target, sourceFile, label: guessLabel(sourceFile) };
  });
}

/**
 * Ejects the media in `target` permanently: clears it from both the live
 * domain (if running) and the persistent config, so - unlike a plain
 * "Eject" from inside Windows or virt-manager's live-only eject - it does
 * NOT silently reappear on the next reboot. The drive itself is left
 * defined and empty, ready to take a new ISO later via attachToSlot()
 * rather than needing a brand new device. No-ops (rather than erroring) if
 * the drive is already empty.
 */
async function ejectMedia(name, target) {
  const current = (await listMedia(name)).find((d) => d.target === target);
  if (!current || !current.sourceFile) return { alreadyEmpty: true };
  const args = ['change-media', name, target, '--eject', '--config'];
  if (await isRunning(name)) args.push('--live');
  await run('virsh', args);
  return { alreadyEmpty: false };
}

/**
 * Loads `isoPath` into an existing (normally just-ejected) cdrom drive
 * `target` - e.g. reusing the slot the Windows install ISO used to occupy
 * for an Office ISO. Persists to both live and config, same as ejectMedia.
 */
async function attachToSlot(name, target, isoPath) {
  const args = ['change-media', name, target, isoPath, '--config'];
  if (await isRunning(name)) args.push('--live');
  return run('virsh', args);
}

/**
 * Attaches a brand new cdrom drive - for when every existing slot already
 * holds something worth keeping and you want to add one more ISO (e.g. an
 * Office ISO) alongside it, rather than swap. Target dev is the first free
 * sdX letter after whatever's already in use; libvirt picks the controller
 * address itself.
 */
async function attachNewCdrom(name, isoPath) {
  const running = await isRunning(name);
  const used = new Set((await listMedia(name)).map((d) => d.target));
  const letters = 'defghijklmnopqrstuvwxyz'.split(''); // sda/sdb/sdc are New VM's own three slots
  const free = letters.map((l) => `sd${l}`).find((t) => !used.has(t)) || `sd${Date.now()}`;
  const args = [
    'attach-disk', name, isoPath, free,
    '--type', 'cdrom', '--sourcetype', 'file', '--mode', 'readonly', '--config'
  ];
  if (running) args.push('--live');
  await run('virsh', args);
  return { target: free };
}

/** Fully removes a drive (not just its media) - for tidying up a slot you'll never reuse. */
async function detachDrive(name, target) {
  const args = ['detach-disk', name, target, '--config'];
  if (await isRunning(name)) args.push('--live');
  return run('virsh', args);
}

module.exports = { listMedia, ejectMedia, attachToSlot, attachNewCdrom, detachDrive };
