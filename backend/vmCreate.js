'use strict';
const fs = require('fs');
const path = require('path');
const { run } = require('./exec');
const { buildDomainXml } = require('./libvirtXml');
const { buildSeedIso } = require('./unattend');
const { VM_IMAGES_DIR, SEED_ISO_DIR, VM_META_DIR, findOvmf } = require('./paths');

/**
 * opts: {
 *   name, memoryMiB, currentMemoryMiB, vcpus, diskSizeGiB,
 *   windowsIsoPath, virtioIsoPath,
 *   username, password,           // becomes RDP_USER/RDP_PASS later
 *   osTargetHint: 'win10'|'win11',
 *   memballoon: bool,
 *   enableDefenderDisable, enableUpdatesDisable, enableBloatDisable: bool,
 *   diskDir (optional override)
 * }
 * onProgress(stage, pct, message)
 */
async function createVm(opts, onProgress = () => {}) {
  const report = (stage, pct, message) => onProgress({ stage, pct, message });

  if (!/^[A-Za-z0-9_-]{1,32}$/.test(opts.name)) {
    throw new Error('VM name must be alphanumeric (dashes/underscores ok), max 32 chars.');
  }

  const ovmf = findOvmf();
  if (!ovmf) throw new Error('No UEFI firmware (OVMF/edk2) found on this host.');

  const diskDir = opts.diskDir || VM_IMAGES_DIR;
  fs.mkdirSync(diskDir, { recursive: true });
  const diskPath = path.join(diskDir, `${opts.name}.qcow2`);
  const nvramDir = path.join(diskDir, 'nvram');
  fs.mkdirSync(nvramDir, { recursive: true });
  const nvramPath = path.join(nvramDir, `${opts.name}_VARS.${ovmf.format === 'qcow2' ? 'qcow2' : 'fd'}`);

  report('disk', 5, 'Creating virtual disk...');
  await run('qemu-img', ['create', '-f', 'qcow2', diskPath, `${opts.diskSizeGiB}G`]);

  report('seed', 15, 'Building unattended-install answer file + OEM scripts...');
  const seedIsoPath = await buildSeedIso(
    {
      name: opts.name,
      username: opts.username,
      password: opts.password,
      computerName: opts.name.toUpperCase().slice(0, 15),
      osTargetHint: opts.osTargetHint,
      enableDefenderDisable: !!opts.enableDefenderDisable,
      enableUpdatesDisable: !!opts.enableUpdatesDisable,
      enableBloatDisable: !!opts.enableBloatDisable
    },
    (line) => report('seed', 20, line)
  );

  report('xml', 35, 'Generating libvirt domain XML...');
  const xml = buildDomainXml({
    name: opts.name,
    memoryMiB: opts.memoryMiB,
    currentMemoryMiB: opts.currentMemoryMiB || opts.memoryMiB,
    vcpus: opts.vcpus,
    diskPath,
    windowsIsoPath: opts.windowsIsoPath,
    virtioIsoPath: opts.virtioIsoPath,
    seedIsoPath,
    ovmf,
    nvramPath,
    memballoon: opts.memballoon !== false,
    osId: opts.osTargetHint === 'win10' ? 'http://microsoft.com/win/10' : 'http://microsoft.com/win/11',
    cpuPinning: opts.cpuPinning || null,
    topology: opts.topology || null
  });

  const xmlPath = path.join(diskDir, `${opts.name}.xml`);
  fs.writeFileSync(xmlPath, xml);

  report('define', 45, 'Defining the VM in libvirt...');
  await run('virsh', ['define', xmlPath]);

  if (opts.startOnBoot) {
    await run('virsh', ['autostart', opts.name], { allowFail: true });
  }

  report('boot', 55, 'Starting the VM and beginning the silent Windows install...');
  await run('virsh', ['start', opts.name]);

  // Persist metadata about this VM for the manager UI (which ISOs/user were used, etc.)
  fs.mkdirSync(VM_META_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(VM_META_DIR, `${opts.name}.json`),
    JSON.stringify(
      {
        name: opts.name,
        createdAt: new Date().toISOString(),
        username: opts.username,
        diskPath,
        xmlPath,
        seedIsoPath
      },
      null,
      2
    )
  );

  report('installing', 60, 'Windows is installing unattended in the background (no window shown).');
  await pollUntilAgentReady(opts.name, report);

  report('done', 100, 'Windows is installed and QEMU Guest Agent is responding. VM is ready.');
  return { name: opts.name, diskPath, xmlPath };
}

/** Polls guest-ping via qemu-guest-agent until Windows has booted past first-logon setup. */
async function pollUntilAgentReady(name, report, timeoutMs = 45 * 60 * 1000) {
  const start = Date.now();
  let lastPct = 60;
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 15000));
    const elapsedMin = Math.round((Date.now() - start) / 60000);
    // Progress is a rough estimate (silent installs give us no hard signal
    // pre-agent) - we creep the bar up over ~20 minutes, the typical time,
    // and jump to 'done' the instant the agent actually answers.
    lastPct = Math.min(95, 60 + elapsedMin * 1.5);
    report('installing', lastPct, `Still installing/first-boot configuring... (${elapsedMin} min elapsed)`);
    try {
      const { stdout } = await run(
        'virsh',
        ['qemu-agent-command', name, '{"execute":"guest-ping"}'],
        { allowFail: true }
      );
      if (stdout && stdout.includes('"return"')) {
        return true;
      }
    } catch (_) {
      // agent not up yet, keep polling
    }
  }
  throw new Error('Timed out waiting for QEMU Guest Agent to respond inside the 45-minute window. The install may still be running - check with `virsh domstate ' + name + '` and a viewer if needed.');
}

module.exports = { createVm };
