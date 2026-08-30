'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { run, which } = require('./exec');

// This whole module is only ever invoked from a VM Details "full" fetch
// (on first expand, or right after a user clicks an attach/detach/enable
// button) - see src/app.js refreshVmDetailsData(). NEVER wire any of this
// into the 3s/5s background pollers: PCI topology, IOMMU state, and what's
// attached to a VM's definition don't change on their own between ticks,
// so polling them would just be extra virsh/lspci subprocesses for no
// benefit - exactly the kind of thing the rest of this app already avoids.

const PCI_DEVICES_DIR = '/sys/bus/pci/devices';
const VGA_CLASS_PREFIX = '0300'; // "VGA compatible controller"
const GPU_3D_CLASS_PREFIX = '0302'; // "3D controller" (secondary/headless GPUs, some Optimus setups)

/**
 * Lists every VGA/3D-controller PCI device on the host, with the sysfs
 * facts needed to judge passthrough safety: current kernel driver, IOMMU
 * group (and every other device sharing that group - a GPU can only be
 * safely handed to a VM if nothing else the host needs shares its group),
 * whether firmware picked it as the boot display device, and SR-IOV
 * virtual-function capacity if any.
 */
async function listGpus() {
  if (!(await which('lspci'))) {
    throw new Error("'lspci' not found (pciutils package) - needed to detect GPUs for passthrough.");
  }
  const { stdout } = await run('lspci', ['-Dnnmm'], { timeoutMs: 5000 });
  const gpus = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    // Machine-readable format, e.g.:
    // 0000:01:00.0 "VGA compatible controller [0300]" "NVIDIA Corporation [10de]" "GA104 [2504]" -ra1 "Vendor [1234]" "Device [5678]"
    const m = line.match(/^(\S+)\s+"([^"[]+)\s*\[([0-9a-f]{4})\]"\s+"([^"[]+)\s*\[([0-9a-f]{4})\]"\s+"([^"[]+)\s*\[([0-9a-f]{4})\]"/i);
    if (!m) continue;
    const [, address, , classCode, vendorName, vendorId, deviceName, deviceId] = m;
    if (!classCode.startsWith(VGA_CLASS_PREFIX) && !classCode.startsWith(GPU_3D_CLASS_PREFIX)) continue;
    gpus.push(describeDevice(address, { vendorName: vendorName.trim(), vendorId, deviceName: deviceName.trim(), deviceId }));
  }
  return gpus;
}

function describeDevice(address, base) {
  const devDir = path.join(PCI_DEVICES_DIR, address);
  const driver = readDriver(devDir);
  const iommuGroup = readIommuGroup(devDir);
  const bootVga = readBootVga(devDir);
  const sriovTotalVfs = readSriovTotalVfs(devDir);
  const groupMembers = iommuGroup != null ? getIommuGroupMembers(iommuGroup) : [];
  // Sibling PCI functions on the same physical card (same domain:bus:slot,
  // different .function) - e.g. the HDMI/DP audio function at .1 - these
  // have to travel with the GPU for passthrough to work.
  const siblingFunctions = groupMembers.filter((addr) => addr !== address && sameSlot(addr, address));
  return {
    address,
    vendorId: base.vendorId,
    deviceId: base.deviceId,
    vendorName: base.vendorName,
    deviceName: base.deviceName,
    driver,
    iommuGroup,
    bootVga,
    sriovTotalVfs,
    sriovNumVfs: sriovTotalVfs ? readSriovNumVfs(devDir) : null,
    groupMembers,
    siblingFunctions,
    // "clean" group = only this GPU + its own sibling functions share the
    // IOMMU group - nothing else on the host (a USB controller, a drive
    // controller, etc.) would get yanked away from the host too.
    groupIsClean: iommuGroup != null && groupMembers.every((addr) => addr === address || sameSlot(addr, address))
  };
}

function sameSlot(a, b) {
  // '0000:01:00.0' -> '0000:01:00' (strip the .function part)
  return a.split('.')[0] === b.split('.')[0];
}

function readDriver(devDir) {
  try {
    return path.basename(fs.readlinkSync(path.join(devDir, 'driver')));
  } catch (_) {
    return null;
  }
}

function readIommuGroup(devDir) {
  try {
    return Number(path.basename(fs.readlinkSync(path.join(devDir, 'iommu_group'))));
  } catch (_) {
    return null;
  }
}

function readBootVga(devDir) {
  try {
    return fs.readFileSync(path.join(devDir, 'boot_vga'), 'utf8').trim() === '1';
  } catch (_) {
    return false;
  }
}

function readSriovTotalVfs(devDir) {
  try {
    const n = Number(fs.readFileSync(path.join(devDir, 'sriov_totalvfs'), 'utf8').trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch (_) {
    return null;
  }
}

function readSriovNumVfs(devDir) {
  try {
    return Number(fs.readFileSync(path.join(devDir, 'sriov_numvfs'), 'utf8').trim()) || 0;
  } catch (_) {
    return 0;
  }
}

function getIommuGroupMembers(groupNum) {
  try {
    return fs.readdirSync(`/sys/kernel/iommu_groups/${groupNum}/devices`);
  } catch (_) {
    return [];
  }
}

/**
 * IOMMU status. `active` is the only fact that actually matters for
 * passthrough right now - real IOMMU groups existing under
 * /sys/kernel/iommu_groups means the feature is live in the running
 * kernel. `cmdlineHasFlag` is just used to word the UI correctly (e.g.
 * "already configured, reboot pending" vs "not configured at all").
 */
async function getIommuStatus() {
  const cpuVendor = detectCpuVendor();
  let cmdline = '';
  try {
    cmdline = fs.readFileSync('/proc/cmdline', 'utf8');
  } catch (_) { /* not on Linux, or unreadable - treat as not configured */ }
  const vendorFlag = cpuVendor === 'amd' ? 'amd_iommu=on' : 'intel_iommu=on';
  const recommendedFlag = `${vendorFlag} iommu=pt`;
  const cmdlineHasFlag = cmdline.includes(vendorFlag.split('=')[0]);
  let active = false;
  try {
    active = fs.readdirSync('/sys/kernel/iommu_groups').length > 0;
  } catch (_) { /* directory doesn't exist - IOMMU is off */ }
  return { cpuVendor, recommendedFlag, cmdlineHasFlag, active };
}

function detectCpuVendor() {
  try {
    const info = fs.readFileSync('/proc/cpuinfo', 'utf8');
    if (/AuthenticAMD/.test(info)) return 'amd';
    if (/GenuineIntel/.test(info)) return 'intel';
  } catch (_) { /* fall through to default */ }
  return 'intel';
}

/**
 * Whether this GPU can be attached to / detached from a VM live, right
 * now, with zero reboot or logout - vs needing IOMMU turned on first
 * (reboot, no way around it - it's a boot-time CPU/chipset feature) or the
 * host's display switched off this GPU first (a relog/manual switch, not
 * something this app can safely automate).
 */
function canHotSwap(gpu, iommuStatus, allGpus) {
  if (!iommuStatus.active) {
    return {
      ok: false,
      reason: 'IOMMU is not active yet - it has to be enabled in the bootloader and the machine rebooted once before any passthrough (hot or not) can work at all.'
    };
  }
  if (!gpu.groupIsClean) {
    return {
      ok: false,
      reason: `This GPU shares IOMMU group ${gpu.iommuGroup} with other host devices, so it can't be isolated to a VM without also taking those away from the host. That's a hardware/chipset grouping limitation, not something togglable in software here.`
    };
  }
  if (gpu.bootVga) {
    const hasOtherGpu = allGpus.some((g) => g.address !== gpu.address);
    if (!hasOtherGpu) {
      return {
        ok: false,
        reason: "This is the only GPU on the system and it's currently driving your display - passing it to a VM would take away your desktop session. Hot-swap needs a second GPU (integrated or another discrete one) for the host to fall back to first."
      };
    }
    return {
      ok: false,
      reason: 'This GPU currently drives your host display. Switch the host display to the other GPU first (a BIOS/UEFI "primary display" setting, or an Optimus/PRIME switcher on a laptop), then it can be attached/detached live from then on.'
    };
  }
  return {
    ok: true,
    reason: "Not currently driving the host display, and cleanly isolated in its own IOMMU group - can be attached to or detached from a VM live, no reboot or relog needed either way."
  };
}

function parsePciAddress(addr) {
  const m = addr.match(/^([0-9a-f]{4}):([0-9a-f]{2}):([0-9a-f]{2})\.([0-9a-f])$/i);
  if (!m) throw new Error(`Unrecognized PCI address format: ${addr}`);
  const [, domain, bus, slot, func] = m;
  return { domain, bus, slot, func };
}

function buildHostdevXml(address) {
  const { domain, bus, slot, func } = parsePciAddress(address);
  return (
    `<hostdev mode="subsystem" type="pci" managed="yes">\n` +
    `  <source>\n` +
    `    <address domain="0x${domain}" bus="0x${bus}" slot="0x${slot}" function="0x${func}"/>\n` +
    `  </source>\n` +
    `</hostdev>\n`
  );
}

/**
 * Attaches a GPU (and its sibling PCI functions - HDMI/DP audio, etc, all
 * travel together as one card) to a VM using libvirt's own *managed*
 * hostdev (managed="yes") - libvirt handles unbinding the device from the
 * host driver and binding vfio-pci itself when the VM starts, and rebinds
 * it back to the host driver the instant the VM stops or the device is
 * detached. No manual vfio-pci driver override needed on our end.
 *
 * `live` attempts a hotplug into a running VM in addition to persisting
 * the change - only pass this when canHotSwap() said ok:true; if the VM
 * is shut off, virsh has nothing to hotplug into and the change just
 * becomes part of the definition for next boot regardless.
 */
async function attachGpuToVm(vmName, gpu, { live = false } = {}) {
  const addresses = [gpu.address, ...gpu.siblingFunctions];
  for (const addr of addresses) {
    const tmpFile = path.join(os.tmpdir(), `winapps-manager-hostdev-${Date.now()}-${addr.replace(/[^\w]/g, '')}.xml`);
    fs.writeFileSync(tmpFile, buildHostdevXml(addr));
    try {
      const args = ['attach-device', vmName, tmpFile, '--config'];
      if (live) args.push('--live');
      await run('virsh', args, { timeoutMs: 15000 });
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  }
}

/** Reverse of attachGpuToVm - detaches the GPU and its sibling functions. */
async function detachGpuFromVm(vmName, gpu, { live = false } = {}) {
  const addresses = [gpu.address, ...gpu.siblingFunctions];
  for (const addr of addresses) {
    const tmpFile = path.join(os.tmpdir(), `winapps-manager-hostdev-${Date.now()}-${addr.replace(/[^\w]/g, '')}.xml`);
    fs.writeFileSync(tmpFile, buildHostdevXml(addr));
    try {
      const args = ['detach-device', vmName, tmpFile, '--config'];
      if (live) args.push('--live');
      // allowFail: a function may already be gone from --live (VM off, or
      // detached earlier in this same loop) without --config having synced
      // yet - not worth failing the whole detach over.
      await run('virsh', args, { allowFail: true, timeoutMs: 15000 });
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  }
}

/** Which of this host's GPU PCI addresses are already attached to this VM's definition. */
async function listAttachedGpuAddresses(vmName) {
  const { stdout: xml } = await run('virsh', ['dumpxml', vmName], { allowFail: true, timeoutMs: 5000 });
  const addresses = [];
  const hostdevRe = /<hostdev\b[^>]*type=["']pci["'][^>]*>[\s\S]*?<\/hostdev>/gi;
  let hm;
  while ((hm = hostdevRe.exec(xml))) {
    // Only the <source><address .../></source> is the *host* PCI address -
    // a hostdev also gets a separate guest-side <address type="pci" .../>
    // sibling element, which must NOT be picked up here.
    const srcMatch = hm[0].match(/<source>\s*<address\s+domain=["']0x([0-9a-f]+)["']\s+bus=["']0x([0-9a-f]+)["']\s+slot=["']0x([0-9a-f]+)["']\s+function=["']0x([0-9a-f]+)["']/i);
    if (srcMatch) {
      const [, domain, bus, slot, func] = srcMatch;
      addresses.push(`${domain.padStart(4, '0')}:${bus.padStart(2, '0')}:${slot.padStart(2, '0')}.${func}`);
    }
  }
  return addresses;
}

/** One-call aggregator for the VM Details "full" fetch tier - see src/app.js. */
async function getGpuOverview(vmName) {
  const [gpus, iommuStatus, attachedAddresses] = await Promise.all([
    listGpus().catch((e) => ({ error: e.message })),
    getIommuStatus(),
    listAttachedGpuAddresses(vmName).catch(() => [])
  ]);
  if (gpus && gpus.error) return { error: gpus.error, iommu: iommuStatus, gpus: [] };
  const enriched = gpus.map((gpu) => ({
    ...gpu,
    hotSwap: canHotSwap(gpu, iommuStatus, gpus),
    attachedToThisVm: attachedAddresses.includes(gpu.address) || gpu.siblingFunctions.some((a) => attachedAddresses.includes(a))
  }));
  return { gpus: enriched, iommu: iommuStatus };
}

async function detectBootloader() {
  if (fs.existsSync('/etc/default/grub')) return 'grub';
  if (fs.existsSync('/boot/loader/entries') || fs.existsSync('/boot/efi/loader/entries')) return 'systemd-boot';
  return 'unknown';
}

/**
 * Appends the IOMMU kernel cmdline flags to the bootloader config and
 * regenerates it. Explicitly user-initiated only (a button click) - never
 * called automatically. This can only take effect on the *next* boot; the
 * caller is always told a reboot is required, and the machine is never
 * rebooted automatically.
 */
async function enableIommuCmdline(iommuStatus) {
  const bootloader = await detectBootloader();
  const flag = iommuStatus.recommendedFlag;
  if (bootloader === 'grub') return enableIommuGrub(flag);
  if (bootloader === 'systemd-boot') return enableIommuSystemdBoot(flag);
  throw new Error(`Could not detect GRUB or systemd-boot. Add "${flag}" to your kernel command line manually (this varies by distro/bootloader) and reboot.`);
}

async function enableIommuGrub(flag) {
  const src = fs.readFileSync('/etc/default/grub', 'utf8');
  const flagKey = flag.split(' ')[0].split('=')[0];
  if (src.includes(flagKey)) {
    return { changed: false, needsReboot: false, note: `"${flagKey}" is already present in /etc/default/grub.` };
  }
  let patched;
  if (/GRUB_CMDLINE_LINUX_DEFAULT="([^"]*)"/.test(src)) {
    patched = src.replace(/GRUB_CMDLINE_LINUX_DEFAULT="([^"]*)"/, (_, existing) => {
      const merged = `${existing} ${flag}`.replace(/\s+/g, ' ').trim();
      return `GRUB_CMDLINE_LINUX_DEFAULT="${merged}"`;
    });
  } else {
    patched = `${src}\nGRUB_CMDLINE_LINUX_DEFAULT="${flag}"\n`;
  }
  const tmpFile = path.join(os.tmpdir(), `winapps-manager-grub-${Date.now()}`);
  fs.writeFileSync(tmpFile, patched);
  try {
    // Written locally first, then installed as root via a single graphical
    // prompt - same "never let an unreviewed root write surprise the user"
    // discipline as network.js's sudoers installer.
    await run('install', ['-m', '0644', tmpFile, '/etc/default/grub'], { sudo: true, timeoutMs: 10000 });
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
  const updateBin = (await which('update-grub'))
    ? 'update-grub'
    : (await which('grub2-mkconfig'))
      ? 'grub2-mkconfig'
      : 'grub-mkconfig';
  const updateArgs = updateBin === 'update-grub' ? [] : ['-o', updateBin === 'grub2-mkconfig' ? '/boot/grub2/grub.cfg' : '/boot/grub/grub.cfg'];
  await run(updateBin, updateArgs, { sudo: true, timeoutMs: 30000 });
  return { changed: true, needsReboot: true, note: `Added "${flag}" to GRUB_CMDLINE_LINUX_DEFAULT and regenerated the boot config. Reboot for it to take effect.` };
}

async function enableIommuSystemdBoot(flag) {
  const entriesDir = fs.existsSync('/boot/loader/entries') ? '/boot/loader/entries' : '/boot/efi/loader/entries';
  const flagKey = flag.split(' ')[0].split('=')[0];
  const entries = fs.readdirSync(entriesDir).filter((f) => f.endsWith('.conf'));
  if (!entries.length) throw new Error(`No boot entries found in ${entriesDir}.`);
  let changedAny = false;
  for (const entry of entries) {
    const full = path.join(entriesDir, entry);
    const src = fs.readFileSync(full, 'utf8');
    if (src.includes(flagKey)) continue;
    const patched = src.replace(/^(options\s+.*)$/m, (line) => `${line} ${flag}`);
    if (patched === src) continue;
    const tmpFile = path.join(os.tmpdir(), `winapps-manager-loader-${Date.now()}`);
    fs.writeFileSync(tmpFile, patched);
    try {
      await run('install', ['-m', '0644', tmpFile, full], { sudo: true, timeoutMs: 10000 });
      changedAny = true;
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  }
  return {
    changed: changedAny,
    needsReboot: true,
    note: changedAny ? `Added "${flag}" to boot entries in ${entriesDir}. Reboot for it to take effect.` : `"${flagKey}" is already present in every boot entry.`
  };
}

/**
 * SR-IOV lets specific GPUs expose lightweight "virtual function" PCI
 * devices that the host driver keeps serving alongside - genuinely
 * simultaneous host+VM use of one physical GPU, instead of a hand-off.
 * Only real on hardware whose driver actually implements it (mostly
 * data-center cards - consumer NVIDIA/AMD/Intel Arc parts generally do
 * not; the sriov_totalvfs gate above is what determines whether this
 * section even shows up in the UI at all).
 */
async function setSriovNumVfs(gpu, count) {
  if (!gpu.sriovTotalVfs) throw new Error('This GPU does not report any SR-IOV virtual functions.');
  if (count < 0 || count > gpu.sriovTotalVfs) throw new Error(`Must be between 0 and ${gpu.sriovTotalVfs}.`);
  const p = path.join(PCI_DEVICES_DIR, gpu.address, 'sriov_numvfs');
  // sysfs requires dropping to 0 before it will accept a new nonzero value.
  await run('sh', ['-c', `echo 0 > '${p}' && echo ${count} > '${p}'`], { sudo: true, timeoutMs: 10000 });
  return { numVfs: count };
}

module.exports = {
  listGpus,
  getIommuStatus,
  canHotSwap,
  getGpuOverview,
  attachGpuToVm,
  detachGpuFromVm,
  listAttachedGpuAddresses,
  enableIommuCmdline,
  setSriovNumVfs
};
