'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');
const { run } = require('./exec');
const { listVmStates } = require('./vmStats');

// One `virsh domstats` call covers every domain's name + state at once,
// instead of `virsh list` plus a separate `virsh domstate` per VM. Each of
// those used to be its own virsh process, and each new virsh process opens
// a fresh (polkit-gated) connection to libvirtd - on the dashboard's 5s
// poll, that meant one polkit authorization per VM every 5 seconds, forever.
async function listVms() {
  return listVmStates();
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
  const diskTargetMatch = xml.match(/<disk[^>]*device=['"]disk['"][\s\S]*?<target dev=['"]([^'"]+)['"]/);
  const diskTarget = diskTargetMatch ? diskTargetMatch[1] : 'vda';

  let diskSizeGiB = null;
  let diskAllocatedGiB = null;
  if (diskPath) {
    try {
      // Via libvirtd (domblkinfo), not a direct file read - qemu-img on the
      // raw path fails silently whenever the image isn't readable by the
      // user's own account (a very common libvirt permission setup), which
      // is why disk size showed as "—" here even though the VM works fine.
      const { stdout: info } = await run('virsh', ['domblkinfo', name, diskTarget], { allowFail: true, timeoutMs: 5000 });
      const capacity = Number((info.match(/^Capacity:\s*(\d+)/m) || [])[1] || 0);
      const allocation = Number((info.match(/^Allocation:\s*(\d+)/m) || [])[1] || 0);
      if (capacity) diskSizeGiB = Math.round((capacity / 1e9) * 10) / 10;
      if (allocation) diskAllocatedGiB = Math.round((allocation / 1e9) * 10) / 10;
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

/**
 * Retrofits the exact CPU/clock/hyperv block docs/libvirt.md recommends
 * (and that `backend/libvirtXml.js` already bakes into every VM created
 * through New VM) onto an existing VM's live definition - for VMs created
 * before this app existed, by hand, or from an older version of it. This
 * is the block that gets idle CPU usage down near 0%: <hyperv> Windows
 * enlightenments (relaxed/vapic/spinlocks/stimer/etc), hypervclock as the
 * *only* active clock source (rtc/pit/hpet/kvmclock all off - having more
 * than one active timer source is a common cause of a Windows guest
 * "polling" even at idle), and host-passthrough CPU mode.
 *
 * The VM must be shut off (libvirt only lets you `define` a domain's XML
 * that way for changes like this - a running VM keeps its current config
 * until restarted regardless).
 */
async function applyLibvirtOptimizations(name) {
  const { stdout: state } = await run('virsh', ['domstate', name]);
  if (state.trim() !== 'shut off') {
    throw new Error(`'${name}' must be shut off first - shut it down, then try again.`);
  }
  const { stdout: xml } = await run('virsh', ['dumpxml', name]);
  const patched = patchXmlForOptimizations(xml);
  const tmpFile = path.join(os.tmpdir(), `winapps-manager-optimize-${Date.now()}.xml`);
  fs.writeFileSync(tmpFile, patched);
  try {
    await run('virsh', ['define', tmpFile]);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
  return { changed: patched !== xml };
}

const HYPERV_BLOCK =
  `<hyperv mode="custom">\n` +
  `      <relaxed state="on"/>\n` +
  `      <vapic state="on"/>\n` +
  `      <spinlocks state="on" retries="8191"/>\n` +
  `      <vpindex state="on"/>\n` +
  `      <synic state="on"/>\n` +
  `      <stimer state="on">\n` +
  `        <direct state="on"/>\n` +
  `      </stimer>\n` +
  `      <reset state="on"/>\n` +
  `      <frequencies state="on"/>\n` +
  `      <reenlightenment state="on"/>\n` +
  `      <tlbflush state="on"/>\n` +
  `      <ipi state="on"/>\n` +
  `    </hyperv>`;

const CLOCK_BLOCK =
  `<clock offset="localtime">\n` +
  `    <timer name="rtc" present="no" tickpolicy="catchup"/>\n` +
  `    <timer name="pit" present="no" tickpolicy="delay"/>\n` +
  `    <timer name="hpet" present="no"/>\n` +
  `    <timer name="kvmclock" present="no"/>\n` +
  `    <timer name="hypervclock" present="yes"/>\n` +
  `  </clock>`;

function patchXmlForOptimizations(xml) {
  let out = xml;

  // <hyperv>...</hyperv> - replace if present (in case it's an older/
  // partial block), insert before </features> if the block is missing,
  // or add a whole <features> block if there's none at all.
  if (/<hyperv[\s\S]*?<\/hyperv>/.test(out)) {
    out = out.replace(/<hyperv[\s\S]*?<\/hyperv>/, HYPERV_BLOCK);
  } else if (/<\/features>/.test(out)) {
    out = out.replace(/<\/features>/, `  ${HYPERV_BLOCK}\n  </features>`);
  } else {
    out = out.replace(/(<\/os>)/, `$1\n  <features>\n    <acpi/>\n    <apic/>\n    ${HYPERV_BLOCK}\n  </features>`);
  }

  // <clock>...</clock> - replace wholesale if present (self-closing form
  // too, e.g. <clock offset="utc"/>, common on hand-made VMs - leaving that
  // unmatched would insert a second <clock> element instead of replacing
  // it, which libvirt rejects), otherwise insert right after </features>
  // (or after </os> if there's no features block).
  const clockRe = /<clock\b[^>]*\/>|<clock[\s\S]*?<\/clock>/;
  if (clockRe.test(out)) {
    out = out.replace(clockRe, CLOCK_BLOCK);
  } else if (/<\/features>/.test(out)) {
    out = out.replace(/<\/features>/, `</features>\n  ${CLOCK_BLOCK}`);
  } else {
    out = out.replace(/(<\/os>)/, `$1\n  ${CLOCK_BLOCK}`);
  }

  // <cpu .../> - only touch it if it's some other mode entirely (or has no
  // mode attribute at all, e.g. a bare <cpu>host-model</cpu> or missing
  // mode='' altogether - both common on hand-made VMs); leave an existing
  // host-passthrough (possibly with a <topology> for pinning) alone.
  const cpuTagMatch = out.match(/<cpu\b[^>]*\/>|<cpu\b[^>]*>[\s\S]*?<\/cpu>/);
  if (cpuTagMatch && !/mode=["']host-passthrough["']/.test(cpuTagMatch[0])) {
    out = out.replace(cpuTagMatch[0], '<cpu mode="host-passthrough" check="none" migratable="on"/>');
  } else if (!cpuTagMatch) {
    out = out.replace(/(<\/features>)/, `$1\n  <cpu mode="host-passthrough" check="none" migratable="on"/>`);
  }

  return out;
}

module.exports = { listVms, startVm, shutdownVm, killVm, resetVm, deleteVm, getVmConfig, applyLibvirtOptimizations };
