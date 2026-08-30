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
 *  ovmf {code, vars, format}, nvramPath, network ('default'), memballoon (bool),
 *  cpuPinning: [{vcpu, cpuset}] | null, topology: {sockets,dies,clusters,cores,threads} | null,
 *  osVariant label metadata (win10/win11), mac (optional)
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
    uuid = crypto.randomUUID()
  } = opts;

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
  const cdroms = [];
  if (windowsIsoPath) {
    cdroms.push(cdromXml('sdb', windowsIsoPath));
  }
  if (virtioIsoPath) {
    cdroms.push(cdromXml('sdc', virtioIsoPath));
  }
  if (seedIsoPath) {
    cdroms.push(cdromXml('sdd', seedIsoPath));
  }

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
${cputuneXml}  <os firmware="efi">
    <type arch="x86_64" machine="pc-q35-8.1">hvm</type>
    <firmware>
      <feature enabled="yes" name="enrolled-keys"/>
      <feature enabled="yes" name="secure-boot"/>
    </firmware>
    <loader readonly="yes" secure="yes" type="pflash" format="${ovmf.format}">${ovmf.code}</loader>
    <nvram template="${ovmf.vars}" format="${ovmf.format === 'qcow2' ? 'qcow2' : 'raw'}">${nvramPath}</nvram>
    <boot dev="hd"/>
    <boot dev="cdrom"/>
  </os>
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
    <vmport state="off"/>
    <smm state="on"/>
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
      <target dev="vda" bus="virtio"/>
    </disk>
${cdroms.join('\n')}
    <controller type="usb" index="0" model="qemu-xhci"/>
    <controller type="sata" index="0"/>
    <controller type="virtio-serial" index="0"/>
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
    <tpm model="tpm-crb">
      <backend type="emulator" version="2.0"/>
    </tpm>
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

function cdromXml(dev, sourceFile) {
  return `    <disk type="file" device="cdrom">
      <driver name="qemu" type="raw"/>
      <source file="${sourceFile}"/>
      <target dev="${dev}" bus="sata"/>
      <readonly/>
    </disk>`;
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

module.exports = { buildDomainXml, randomMac };
