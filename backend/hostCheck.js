'use strict';
const os = require('os');
const fs = require('fs');
const { run, which } = require('./exec');
const { findOvmf } = require('./paths');

/**
 * Mirrors docs/libvirt.md "Prerequisites" section item-for-item, plus the
 * things setup.sh / the docker doc dependency list needs for the *manager*
 * to work (genisoimage, virsh, qemu-img).
 * Returns a list of { id, label, ok, detail, fix } so the UI can render a
 * checklist and offer a one-click fix where possible.
 */
async function checkHost() {
  const results = [];
  const user = os.userInfo().username;

  // 1. CPU virtualization extensions
  let cpuOk = false;
  try {
    const cpuinfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
    cpuOk = /\b(vmx|svm)\b/.test(cpuinfo);
  } catch (_) {}
  results.push({
    id: 'cpu-virt',
    label: 'CPU supports hardware virtualization (VT-x/AMD-V)',
    ok: cpuOk,
    detail: cpuOk ? 'vmx/svm flag present' : 'No vmx/svm flag in /proc/cpuinfo; enable virtualization in BIOS/UEFI.'
  });

  // 2. Core tooling present (installed via the virt-manager package per docs)
  const bins = ['virsh', 'qemu-img', 'virt-install', 'virt-xml'];
  for (const bin of bins) {
    const p = await which(bin);
    results.push({
      id: `bin-${bin}`,
      label: `'${bin}' available`,
      ok: !!p,
      detail: p || 'Not found on PATH. Install virt-manager (also pulls in qemu/libvirt/virtinst).',
      fixCommand: fixInstallCommand()
    });
  }

  // ISO tooling for building the autounattend/oem seed ISO
  const isoBin = (await which('genisoimage')) || (await which('mkisofs')) || (await which('xorriso'));
  results.push({
    id: 'iso-tool',
    label: 'ISO authoring tool (genisoimage / mkisofs / xorriso)',
    ok: !!isoBin,
    detail: isoBin || 'Needed to build the unattended-install seed ISO.'
  });

  // 3. libvirt default URI - checked via env / /etc/environment, per NOTE in docs
  const envUri = process.env.LIBVIRT_DEFAULT_URI;
  let etcEnvHasUri = false;
  try {
    etcEnvHasUri = fs.readFileSync('/etc/environment', 'utf8').includes('LIBVIRT_DEFAULT_URI');
  } catch (_) {}
  results.push({
    id: 'libvirt-uri',
    label: "libvirt default URI set to 'qemu:///system'",
    ok: envUri === 'qemu:///system' || etcEnvHasUri,
    detail: envUri || (etcEnvHasUri ? 'set in /etc/environment' : 'not set'),
    fix: 'append',
    fixDetail: 'echo \'LIBVIRT_DEFAULT_URI="qemu:///system"\' | sudo tee -a /etc/environment'
  });

  // 4. group membership: kvm + libvirt (or libvirtd on NixOS)
  let groups = [];
  try {
    const { stdout } = await run('groups', [user]);
    groups = stdout.replace(/^.*:\s*/, '').trim().split(/\s+/);
  } catch (_) {}
  const inKvm = groups.includes('kvm');
  const inLibvirt = groups.includes('libvirt') || groups.includes('libvirtd');
  results.push({
    id: 'group-kvm',
    label: `User '${user}' is in the 'kvm' group`,
    ok: inKvm,
    detail: inKvm ? 'ok' : 'Run: sudo usermod -aG kvm ' + user + ' (then log out/in or reboot)'
  });
  results.push({
    id: 'group-libvirt',
    label: `User '${user}' is in the 'libvirt' group`,
    ok: inLibvirt,
    detail: inLibvirt ? 'ok' : 'Run: sudo usermod -aG libvirt ' + user + ' (then log out/in or reboot)'
  });

  // libvirtd running
  let daemonOk = false;
  try {
    const { stdout } = await run('systemctl', ['is-active', 'libvirtd'], { allowFail: true });
    daemonOk = stdout.trim() === 'active';
  } catch (_) {}
  results.push({
    id: 'libvirtd-running',
    label: 'libvirtd service is active',
    ok: daemonOk,
    detail: daemonOk ? 'active' : 'Run: sudo systemctl enable --now libvirtd'
  });

  // default network active
  let netOk = false;
  try {
    const { stdout } = await run('virsh', ['net-info', 'default'], { allowFail: true });
    netOk = /Active:\s*yes/i.test(stdout);
  } catch (_) {}
  results.push({
    id: 'default-net',
    label: "libvirt 'default' NAT network is active",
    ok: netOk,
    detail: netOk ? 'active' : "Run: virsh net-start default && virsh net-autostart default"
  });

  // OVMF / UEFI firmware present (required for the secure-boot XML from the docs)
  const ovmf = findOvmf();
  results.push({
    id: 'ovmf',
    label: 'UEFI firmware (OVMF/edk2) installed',
    ok: !!ovmf,
    detail: ovmf ? `${ovmf.code}` : 'Install ovmf / edk2-ovmf package for your distro.'
  });

  const allOk = results.every((r) => r.ok);
  return { allOk, results };
}

function fixInstallCommand() {
  // Best-effort guess of the distro's install command for virt-manager, per
  // docs/libvirt.md step 2. The UI shows this as a copyable suggestion, it
  // is never run without the user clicking "Run fix".
  if (fs.existsSync('/etc/debian_version')) return 'sudo apt install -y virt-manager';
  if (fs.existsSync('/etc/fedora-release')) return 'sudo dnf install -y virt-manager';
  if (fs.existsSync('/etc/arch-release')) return 'sudo pacman -S --needed virt-manager';
  if (fs.existsSync('/etc/os-release') && fs.readFileSync('/etc/os-release', 'utf8').includes('Gentoo')) {
    return 'sudo emerge app-emulation/virt-manager';
  }
  return 'Install "virt-manager" using your distro package manager.';
}

module.exports = { checkHost };
