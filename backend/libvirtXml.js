'use strict';
const crypto = require('crypto');

function randomMac() {
  const bytes = [0x52, 0x54, 0x00];
  for (let i = 0; i < 3; i++) bytes.push(Math.floor(Math.random() * 256));
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(':');
}

/**
 * opts:
 *  name, memoryMiB, currentMemoryMiB, vcpus, diskPath, diskSizeGiB (unused here,
 *  disk itself is created separately), windowsIsoPath, virtioIsoPath, seedIsoPath,
 *  ovmf {code, vars, format} (ignored when firmware='bios'), nvramPath,
 *  network ('default'), memballoon (bool),
 *  cpuPinning: [{vcpu, cpuset}] | null, topology: {sockets,dies,clusters,cores,threads} | null,
 *  osVariant label metadata (win10/win11), mac (optional), secureBoot (bool, default true,
 *  ignored when firmware='bios'), firmware ('uefi' | 'bios', default 'uefi'),
 *  answerFileDir (optional - a host directory containing just autounattend.xml,
 *  exposed to the guest as a virtual floppy disk; see below)
 */
function buildDomainXml(opts) {
  const {
    name,
    memoryMiB,
    currentMemoryMiB,
    vcpus,
    diskPath,
    windowsIsoPath,
    virtioIsoPath,
    seedIsoPath,
    ovmf,
    nvramPath,
    network = 'default',
    memballoon = true,
    cpuPinning = null,
    topology = null,
    osId = 'http://microsoft.com/win/11',
    mac = randomMac(),
    uuid = crypto.randomUUID(),
    secureBoot = true,
    firmware = 'uefi',
    answerFileDir = null
  } = opts;

  const useUefi = firmware !== 'bios';

  const memoryKiB = memoryMiB * 1024;
  const currentMemoryKiB = (currentMemoryMiB || memoryMiB) * 1024;

  // --- <vcpu>/<cputune> block: only emitted when the user opted in to
  // manual CPU pinning (docs/libvirt.md "Optional: Assign Specific Physical
  // CPU Cores"). Otherwise libvirt/QEMU picks placement automatically.
  let cputuneXml = '';
  let cpuTopologyXml = '<cpu mode="host-passthrough" check="none" migratable="on"/>';
  if (cpuPinning && cpuPinning.length && topology) {
    const pins = cpuPinning
      .map((p) => `    <vcpupin vcpu="${p.vcpu}" cpuset="${p.cpuset}"/>`)
      .join('\n');
    cputuneXml = `  <cputune>\n${pins}\n  </cputune>\n`;
    cpuTopologyXml =
      `<cpu mode="host-passthrough" check="none" migratable="on">\n` +
      `    <topology sockets="${topology.sockets}" dies="${topology.dies}" clusters="${topology.clusters}" cores="${topology.cores}" threads="${topology.threads}"/>\n` +
      `  </cpu>`;
  }

  const memballoonXml = memballoon
    ? '<memballoon model="virtio"/>'
    : '<memballoon model="none"/>';

  // Extra removable-media entries: Windows ISO, VirtIO driver ISO, and our
  // generated autounattend/oem seed ISO (used only during first boot).
  //
  // UEFI (OVMF): the Windows ISO gets its own dedicated SATA controller
  // (index 0, port 0/"sda") plus an explicit <boot order="1"/>, separate
  // from the other two ISOs (index 1). With several cdroms sharing one
  // AHCI controller, OVMF's boot-order matching has to tell them apart
  // purely by port number, and that's unreliable enough in practice to
  // make the whole boot order silently get ignored - the VM then drops to
  // "No bootable device found - Press any key..." even though the device
  // is perfectly bootable (proven by picking it manually from that same
  // menu working every time). Giving it a controller of its own removes
  // that ambiguity, and putting it on the *first* port matches how
  // OVMF/QEMU's own examples and virt-manager lay things out.
  //
  // Legacy BIOS (SeaBIOS): none of the above is needed - SeaBIOS's
  // <os><boot dev="hd"/><boot dev="cdrom"/></os> list (the classic
  // int18h-style cascade: try the disk, and if it has nothing installed,
  // fall through to the first CD-ROM) is exactly what a stock virt-manager
  // VM uses and is far more forgiving here. Per libvirt's schema, per-device
  // <boot order=".."/> and the <os>-level <boot dev=".."/> list are
  // mutually exclusive, so BIOS mode must not set boot order on any device
  // and instead relies purely on that <os>-level list. One shared SATA
  // controller for everything is enough.
  const cdroms = [];
  if (useUefi) {
    if (windowsIsoPath) cdroms.push(cdromXml('sda', windowsIsoPath, { controller: 0, unit: 0, bootOrder: 1 }));
    if (virtioIsoPath) cdroms.push(cdromXml('sdb', virtioIsoPath, { controller: 1, unit: 0 }));
    if (seedIsoPath) cdroms.push(cdromXml('sdc', seedIsoPath, { controller: 1, unit: 1 }));
  } else {
    if (windowsIsoPath) cdroms.push(cdromXml('sda', windowsIsoPath, { controller: 0, unit: 0 }));
    if (virtioIsoPath) cdroms.push(cdromXml('sdb', virtioIsoPath, { controller: 0, unit: 1 }));
    if (seedIsoPath) cdroms.push(cdromXml('sdc', seedIsoPath, { controller: 0, unit: 2 }));
  }

  const osXml = useUefi
    ? `<os>
    <type arch="x86_64" machine="pc-q35-8.1">hvm</type>
    <loader readonly="yes" secure="${secureBoot ? 'yes' : 'no'}" type="pflash" format="${ovmf.format}">${ovmf.code}</loader>
    <nvram template="${ovmf.vars}" format="${ovmf.format === 'qcow2' ? 'qcow2' : 'raw'}">${nvramPath}</nvram>
    <bootmenu enable="no"/>
  </os>`
    : `<os>
    <type arch="x86_64" machine="pc-q35-8.1">hvm</type>
    <boot dev="hd"/>
    <boot dev="cdrom"/>
    <bootmenu enable="no"/>
  </os>`;

  // TPM + SMM protection are OVMF/UEFI concerns (Windows 11's Secure Boot/
  // TPM 2.0 requirement); meaningless - and in TPM's case, not reliably
  // supported - under legacy SeaBIOS, so both are left out entirely in
  // BIOS mode rather than emitted as dead/incompatible config.
  const tpmXml = useUefi
    ? `<tpm model="tpm-crb">
      <backend type="emulator" version="2.0"/>
    </tpm>`
    : '';
  const smmXml = useUefi ? '\n    <smm state="on"/>' : '';

  const diskBootXml = useUefi ? '\n      <boot order="2"/>' : '';

  // The floppy is the one location every Windows Setup version is
  // documented to check first, unconditionally, for autounattend.xml -
  // unlike a second CD-ROM, which in practice (confirmed on real hardware
  // here) is NOT reliably scanned by modern Setup at all. QEMU/libvirt can
  // expose a plain host directory as a virtual FAT floppy directly (the
  // "VVFAT" driver) - no mkisofs/mtools/mformat needed, just a directory
  // containing autounattend.xml. It's read-only data with no boot sector,
  // so it's never a boot candidate either way - harmless to leave attached
  // even in BIOS mode's <boot dev="hd"/><boot dev="cdrom"/> cascade.
  const floppyXml = answerFileDir
    ? `    <disk type="dir" device="floppy">
      <driver name="qemu" type="fat"/>
      <source dir="${answerFileDir}"/>
      <target dev="fda" bus="fdc"/>
      <readonly/>
    </disk>
`
    : '';

  return `<domain type="kvm">
  <name>${escapeXml(name)}</name>
  <uuid>${uuid}</uuid>
  <metadata>
    <libosinfo:libosinfo xmlns:libosinfo="http://libosinfo.org/xmlns/libvirt/domain/1.0">
      <libosinfo:os id="${osId}"/>
    </libosinfo:libosinfo>
  </metadata>
  <memory unit="KiB">${memoryKiB}</memory>
  <currentMemory unit="KiB">${currentMemoryKiB}</currentMemory>
  <vcpu placement="static">${vcpus}</vcpu>
${cputuneXml}  ${osXml}
  <features>
    <acpi/>
    <apic/>
    <hyperv mode="custom">
      <relaxed state="on"/>
      <vapic state="on"/>
      <spinlocks state="on" retries="8191"/>
      <vpindex state="on"/>
      <synic state="on"/>
      <stimer state="on">
        <direct state="on"/>
      </stimer>
      <reset state="on"/>
      <frequencies state="on"/>
      <reenlightenment state="on"/>
      <tlbflush state="on"/>
      <ipi state="on"/>
    </hyperv>
    <vmport state="off"/>${smmXml}
  </features>
  ${cpuTopologyXml}
  <clock offset="localtime">
    <timer name="rtc" present="no" tickpolicy="catchup"/>
    <timer name="pit" present="no" tickpolicy="delay"/>
    <timer name="hpet" present="no"/>
    <timer name="kvmclock" present="no"/>
    <timer name="hypervclock" present="yes"/>
  </clock>
  <on_poweroff>destroy</on_poweroff>
  <on_reboot>restart</on_reboot>
  <on_crash>destroy</on_crash>
  <pm>
    <suspend-to-mem enabled="no"/>
    <suspend-to-disk enabled="no"/>
  </pm>
  <devices>
    <emulator>/usr/bin/qemu-system-x86_64</emulator>
    <disk type="file" device="disk">
      <driver name="qemu" type="qcow2" discard="unmap"/>
      <source file="${diskPath}"/>
      <target dev="vda" bus="virtio"/>${diskBootXml}
    </disk>
${cdroms.join('\n')}
${floppyXml}    <controller type="usb" index="0" model="qemu-xhci"/>
    <controller type="sata" index="0"/>
${useUefi ? '    <controller type="sata" index="1"/>\n' : ''}    <controller type="virtio-serial" index="0"/>
    <interface type="network">
      <mac address="${mac}"/>
      <source network="${network}"/>
      <model type="virtio"/>
    </interface>
    <serial type="pty">
      <target type="isa-serial" port="0">
        <model name="isa-serial"/>
      </target>
    </serial>
    <console type="pty">
      <target type="serial" port="0"/>
    </console>
    <channel type="spicevmc">
      <target type="virtio" name="com.redhat.spice.0"/>
    </channel>
    <channel type="unix">
      <source mode="bind"/>
      <target type="virtio" name="org.qemu.guest_agent.0"/>
    </channel>
    <input type="tablet" bus="usb"/>
    <input type="mouse" bus="ps2"/>
    <input type="keyboard" bus="ps2"/>
    ${tpmXml}
    <graphics type="spice" autoport="yes">
      <listen type="address"/>
      <image compression="off"/>
    </graphics>
    <sound model="ich9"/>
    <audio id="1" type="spice"/>
    <video>
      <model type="qxl" ram="65536" vram="65536" vgamem="16384" heads="1" primary="yes"/>
    </video>
    <redirdev bus="usb" type="spicevmc"/>
    <watchdog model="itco" action="reset"/>
    ${memballoonXml}
  </devices>
</domain>
`;
}

function cdromXml(dev, sourceFile, { controller = 0, unit = 0, bootOrder = null } = {}) {
  return `    <disk type="file" device="cdrom">
      <driver name="qemu" type="raw"/>
      <source file="${sourceFile}"/>
      <target dev="${dev}" bus="sata"/>
      <readonly/>
      ${bootOrder ? `<boot order="${bootOrder}"/>` : ''}
      <address type="drive" controller="${controller}" bus="0" target="0" unit="${unit}"/>
    </disk>`;
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

module.exports = { buildDomainXml, randomMac };
