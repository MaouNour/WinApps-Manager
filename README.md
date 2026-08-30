<div align="center">

# WinApps Manager

### A simple graphical manager for Windows VMs built for WinApps

Create, configure, optimize and manage your WinApps Windows VM without living inside
`virsh`, `virt-manager`, XML files and shell scripts.

<br>

[![Linux](https://img.shields.io/badge/platform-Linux-1793D1?style=flat-square&logo=linux&logoColor=white)](#requirements)
[![Electron](https://img.shields.io/badge/Electron-Desktop%20App-47848F?style=flat-square&logo=electron&logoColor=white)](#installation)
[![libvirt](https://img.shields.io/badge/virtualization-KVM%20%2B%20libvirt-FF6B35?style=flat-square)](#how-it-works)
[![WinApps](https://img.shields.io/badge/built%20for-WinApps-4CAF50?style=flat-square)](#winapps-integration)

<br>

**[Download](../../releases) · [Report a Bug](../../issues) · [WinApps](https://github.com/winapps-org/winapps)**

</div>

---

<div align="center">

<img src="docs/screenshots/dashboard.png" alt="WinApps Manager Dashboard" width="900">

</div>

# What is WinApps Manager?

Running Windows applications through
[WinApps](https://github.com/winapps-org/winapps) is powerful, but setting up the
libvirt backend manually can involve a lot of configuration:

- Installing and checking virtualization dependencies
- Creating the Windows VM
- Configuring UEFI, Secure Boot and TPM
- Configuring VirtIO storage and networking
- Applying the WinApps hypervisor configuration
- Creating the unattended Windows installation
- Installing VirtIO and the QEMU Guest Agent
- Configuring RDP
- Creating `winapps.conf`
- Detecting Windows applications
- Managing the VM through `virsh`
- Managing the VM's network
- Optimizing Windows for a virtualized workload

**WinApps Manager puts those pieces behind one interface.**

The goal is simple:

> **Set up Windows once, then use Windows applications as if they were Linux applications.**

You should not have to open `virt-manager` every time you want to start a VM,
edit libvirt XML by hand, or remember which `virsh` command controls your machine.

---

# ✨ Features

<table>
<tr>
<td width="50%" valign="top">

### 🖥️ One-click VM creation

Create a Windows VM designed specifically for WinApps.

- Windows edition selection
- Custom VM name
- User and password configuration
- Automatic VM configuration
- VirtIO storage
- VirtIO networking
- TPM 2.0
- Secure Boot / UEFI
- QEMU Guest Agent
- Hyper-V enlightenments
- WinApps-compatible configuration

</td>

<td width="50%" valign="top">

### 🚀 Silent Windows installation

Once the VM is configured, Windows can install without requiring you to sit
through the Windows installer.

WinApps Manager generates the required unattended installation files and
handles the first-boot configuration automatically.

You get a progress screen instead of a Windows installation window.

</td>
</tr>

<tr>
<td width="50%" valign="top">

### ⚡ Performance optimizations

Tune Windows for its role as a WinApps VM.

- CPU / memory configuration
- Memory ballooning
- Hypervisor clock configuration
- Windows performance mode
- Background-service cleanup
- Power-plan optimization
- Windows Update controls
- Defender controls
- Unnecessary service controls

The objective is to make an idle Windows VM behave like a lightweight background
service rather than a second desktop sitting on your machine.

</td>

<td width="50%" valign="top">

### 📊 Live VM statistics

See what your VM is actually doing.

- CPU usage
- Memory usage
- Disk usage
- Network traffic
- VM resource allocation
- Host CPU / RAM / GPU usage

Resource information is read from the running VM instead of relying solely on
stored configuration.

</td>
</tr>

<tr>
<td width="50%" valign="top">

### 🌐 Network control

Control the VM's network directly from the dashboard.

- Connect / disconnect VM networking
- Live network status
- No need to remember `iptables` commands
- VM-specific network handling
- Optional passwordless network control after setup

</td>

<td width="50%" valign="top">

### 🎮 VM controls

Everything you normally need from `virsh` is available from the UI.

- Start
- Shutdown
- Restart
- Force stop
- Reconnect network
- Disconnect network
- Edit resources
- Resize storage

</td>
</tr>

<tr>
<td width="50%" valign="top">

### 🪟 WinApps application management

Use WinApps' own application detection rather than maintaining a second
application database.

Applications can be displayed as a visual picker with:

- Application icons
- Names
- Enable / disable controls
- Automatic refresh
- Manual application support
- Existing WinApps desktop entries

</td>

<td width="50%" valign="top">

### ⚙️ `winapps.conf` management

Configure your WinApps connection without manually editing the configuration
file.

Manage settings such as:

- VM name
- RDP username
- RDP password
- RDP configuration
- WinApps options

Changes are written back into the existing configuration while preserving its
structure.

</td>
</tr>
</table>

---

# 🧭 How it works

The idea is to make the entire setup feel like installing an application rather
than building a virtual machine manually.

```text
┌──────────────────┐
│   Create VM      │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Choose Windows   │
│ ISO / edition    │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Configure VM     │
│ CPU / RAM / Disk │
│ UEFI / TPM /     │
│ VirtIO / WinApps │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Silent Windows   │
│ Installation     │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Guest setup      │
│ VirtIO / QGA /   │
│ WinApps config   │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│      Done        │
│                  │
│ Windows apps now │
│ behave like apps │
│ on your desktop  │
└──────────────────┘
