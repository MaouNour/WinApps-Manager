'use strict';
const fs = require('fs');
const path = require('path');
const { run } = require('./exec');
const { buildDomainXml } = require('./libvirtXml');
const { buildSeedIso, buildAutounattendXml, buildAutounattendFloppyImage } = require('./unattend');
const { ensureVirtioIso, ensureWindowsIso } = require('./isoAcquire');
const { openViewer } = require('./vmctl');
const { VM_IMAGES_DIR, VM_META_DIR, findOvmf } = require('./paths');

/**
 * opts: {
 *   name, memoryMiB, currentMemoryMiB, vcpus, diskSizeGiB,
 *   windowsIsoPath, virtioIsoPath,
 *   username, password,           // becomes RDP_USER/RDP_PASS later
 *   osTargetHint: 'win10'|'win11',
 *   memballoon: bool,
 *   enableDefenderDisable, enableUpdatesDisable, enableBloatDisable: bool,
 *   diskDir (optional override),
 *   firmware: 'uefi' | 'bios' (default 'uefi'). 'bios' uses plain legacy
 *     SeaBIOS - no OVMF, no TPM, no Secure Boot - with the classic
 *     <os><boot dev="hd"/><boot dev="cdrom"/></os> cascade (same pattern a
 *     stock virt-manager VM uses). Required for Windows 11's Secure
 *     Boot/TPM requirement, so keep 'uefi' for that; for Windows 10 and
 *     modified/community ISOs (Tiny10, ReviOS, AME, etc.) 'bios' sidesteps
 *     OVMF's pickier UEFI boot-manager altogether and is the more reliable
 *     choice.
 *   secureBoot: bool (default true, only applies when firmware='uefi' -
 *     like Tiny10/ReviOS/AME that aren't Microsoft-signed; Secure Boot
 *     rejecting an unsigned bootloader with no other valid boot option is a
 *     common cause of the VM appearing stuck at a firmware "select boot
 *     device" screen),
 *   interactiveInstall: bool (default false - "install Windows via the
 *     GUI". The libvirt XML is still built and optimized exactly the same
 *     "winapps way" as the silent path; the only difference is we skip
 *     autounattend.xml so Windows Setup asks its normal on-screen questions,
 *     and we open a SPICE viewer window instead of polling headlessly.)
 * }
 * onProgress(stage, pct, message)
 */
async function createVm(opts, onProgress = () => {}) {
  const report = (stage, pct, message) => onProgress({ stage, pct, message });

  if (!/^[A-Za-z0-9_-]{1,32}$/.test(opts.name)) {
    throw new Error('VM name must be alphanumeric (dashes/underscores ok), max 32 chars.');
  }

  const firmware = opts.firmware === 'bios' ? 'bios' : 'uefi';
  const ovmf = firmware === 'uefi' ? findOvmf() : null;
  if (firmware === 'uefi' && !ovmf) throw new Error('No UEFI firmware (OVMF/edk2) found on this host.');

  const diskDir = opts.diskDir || VM_IMAGES_DIR;
  fs.mkdirSync(diskDir, { recursive: true });
  const diskPath = path.join(diskDir, `${opts.name}.qcow2`);
  let nvramPath = null;
  if (firmware === 'uefi') {
    const nvramDir = path.join(diskDir, 'nvram');
    fs.mkdirSync(nvramDir, { recursive: true });
    nvramPath = path.join(nvramDir, `${opts.name}_VARS.${ovmf.format === 'qcow2' ? 'qcow2' : 'fd'}`);
  }

  report('disk', 5, 'Creating virtual disk...');
  await run('qemu-img', ['create', '-f', 'qcow2', diskPath, `${opts.diskSizeGiB}G`]);

  // Fully automatic media acquisition: unless the user explicitly picked a
  // local file in "Advanced", we fetch + cache both ISOs ourselves so
  // nobody ever has to hunt down installer media by hand.
  let windowsIsoPath = opts.windowsIsoPath;
  if (!windowsIsoPath) {
    windowsIsoPath = await ensureWindowsIso(opts.osTargetHint, (p) => report('windows-iso', 6 + p.pct * 0.09, p.message));
  }
  let virtioIsoPath = opts.virtioIsoPath;
  if (!virtioIsoPath) {
    virtioIsoPath = await ensureVirtioIso((p) => report('virtio-iso', 15 + p.pct * 0.05, p.message));
  }

  const interactiveInstall = !!opts.interactiveInstall;

  report(
    'seed',
    22,
    interactiveInstall
      ? 'Building OEM/first-boot helper scripts (no autounattend - Setup will ask you directly)...'
      : 'Building unattended-install answer file + OEM scripts...'
  );
  const seedIsoPath = await buildSeedIso(
    {
      name: opts.name,
      username: opts.username,
      password: opts.password,
      computerName: opts.name.toUpperCase().slice(0, 15),
      osTargetHint: opts.osTargetHint,
      skipAutounattend: interactiveInstall,
      enableDefenderDisable: !!opts.enableDefenderDisable,
      enableUpdatesDisable: !!opts.enableUpdatesDisable,
      enableFirewallDisable: !!opts.enableFirewallDisable,
      enableBloatDisable: !!opts.enableBloatDisable
    },
    (line) => report('seed', 25, line)
  );

  // autounattend.xml ALSO goes on a dedicated virtual floppy (a small FAT12
  // image file - see libvirtXml.js) in addition to the seed CD above. The
  // floppy is the one location every version of Windows Setup is documented
  // to check first, no exceptions; a second CD-ROM's answer file, by
  // contrast, was confirmed NOT to get picked up in testing. Keeping it on
  // both costs nothing - whichever one Setup finds first wins.
  let answerFileImagePath = null;
  if (!interactiveInstall) {
    answerFileImagePath = await buildAutounattendFloppyImage(
      opts.name,
      buildAutounattendXml({
        username: opts.username,
        password: opts.password,
        computerName: opts.name.toUpperCase().slice(0, 15),
        osTargetHint: opts.osTargetHint
      })
    );
  }

  report('xml', 35, 'Generating libvirt domain XML...');
  const xml = buildDomainXml({
    name: opts.name,
    memoryMiB: opts.memoryMiB,
    currentMemoryMiB: opts.currentMemoryMiB || opts.memoryMiB,
    vcpus: opts.vcpus,
    diskPath,
    windowsIsoPath,
    virtioIsoPath,
    seedIsoPath,
    ovmf,
    nvramPath,
    answerFileImagePath,
    memballoon: opts.memballoon !== false,
    osId: guessLibosinfoId(opts.osTargetHint),
    cpuPinning: opts.cpuPinning || null,
    topology: opts.topology || null,
    secureBoot: opts.secureBoot !== false,
    firmware
  });

  const xmlPath = path.join(diskDir, `${opts.name}.xml`);
  fs.writeFileSync(xmlPath, xml);

  report('define', 45, 'Defining the VM in libvirt...');
  await run('virsh', ['define', xmlPath]);

  if (opts.startOnBoot) {
    await run('virsh', ['autostart', opts.name], { allowFail: true });
  }

  report(
    'boot',
    55,
    interactiveInstall
      ? 'Starting the VM - a viewer window will open for you to run Windows Setup...'
      : 'Starting the VM and beginning the silent Windows install...'
  );
  await run('virsh', ['start', opts.name]);

  if (interactiveInstall) {
    try {
      await openViewer(opts.name);
    } catch (e) {
      // Non-fatal: the VM is up either way, the user can still open a
      // viewer manually (virt-manager, or the Dashboard's Open Console).
      report('boot', 57, `Could not auto-open a viewer (${e.message}). Open one manually to continue Windows Setup.`);
    }
  }

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
        seedIsoPath,
        windowsIsoPath,
        virtioIsoPath,
        memoryMiB: opts.memoryMiB,
        vcpus: opts.vcpus,
        diskSizeGiB: opts.diskSizeGiB
      },
      null,
      2
    )
  );

  if (interactiveInstall) {
    report(
      'installing',
      60,
      'Waiting for you to finish Windows Setup in the viewer window. Once you\'re at the desktop, open the ' +
        '"SEED" CD drive in Windows and run bootstrap.cmd as Administrator to finish the WinApps setup ' +
        '(VirtIO guest tools, QEMU Guest Agent, RDP registry keys) - this step is picked up automatically below.'
    );
    // Manual GUI installs are entirely user-paced (clicking through Setup,
    // then remembering to run bootstrap.cmd themselves) so we give this a
    // much longer window than the silent path before giving up.
    await pollUntilAgentReady(opts.name, report, 3 * 60 * 60 * 1000);
  } else {
    report('installing', 60, 'Windows is installing unattended in the background (no window shown).');
    await pollUntilAgentReady(opts.name, report);
  }

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
    // and jump to 'done' the instant the agent actually answers. Capped at
    // a lower ceiling since this same creep also covers the much longer,
    // user-paced interactive-install timeout.
    lastPct = Math.min(95, 60 + elapsedMin * 0.5);
    report('installing', lastPct, `Still waiting on Windows/QEMU Guest Agent... (${elapsedMin} min elapsed)`);
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
  throw new Error('Timed out waiting for QEMU Guest Agent to respond inside the ' + Math.round(timeoutMs / 60000) + '-minute window. The install may still be running - check with `virsh domstate ' + name + '` and a viewer if needed.');
}

// Purely cosmetic libosinfo metadata (drives the icon/name virt-manager
// shows for the VM) - best-effort mapping so newly added editions
// (Enterprise/LTSC/IoT/Server) still get a sane tag instead of always
// falling through to "win/11".
function guessLibosinfoId(editionId = '') {
  if (editionId.startsWith('win10')) return 'http://microsoft.com/win/10';
  if (editionId.startsWith('win11')) return 'http://microsoft.com/win/11';
  if (editionId.startsWith('server2025')) return 'http://microsoft.com/win/2k25';
  if (editionId.startsWith('server2022')) return 'http://microsoft.com/win/2k22';
  return 'http://microsoft.com/win/11';
}

module.exports = { createVm };
