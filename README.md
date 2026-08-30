# WinApps Manager (libvirt)

An Electron GUI that automates creating and managing a WinApps `libvirt` Windows
VM, following `docs/libvirt.md` from [winapps-org/winapps](https://github.com/winapps-org/winapps)
step for step.

## Run it

```bash
cd winapps-manager
npm install
npm start
```

Requires: `virt-manager` (pulls in `qemu-img`, `virsh`, `virt-install`), an
ISO tool (`genisoimage`/`mkisofs`/`xorriso`), and OVMF/edk2 UEFI firmware.
The **Setup Check** page in the app verifies all of this for you and tells
you the exact fix command if something's missing.

## What each screen does, and how it maps to the docs

### Setup Check
Runs through every item in the "Prerequisites" section of `docs/libvirt.md`:
CPU virtualization flags, `virt-manager`/`virsh`/`virt-install` on PATH,
`LIBVIRT_DEFAULT_URI`, `kvm`/`libvirt` group membership, `libvirtd` active,
the `default` NAT network active, and OVMF firmware present.

### New VM (wizard)
This is the automated version of the "Creating a Windows VM" walkthrough in
the docs. Instead of clicking through `virt-manager`'s XML editor by hand,
`backend/libvirtXml.js` generates the full domain XML directly from the
docs' example XML block, including:
- the exact `<hyperv>` enlightenment block from the docs
- the exact `<clock>` timer tuning (hypervclock only) from the docs
- the `org.qemu.guest_agent.0` virtio-serial channel from the docs
- VirtIO disk bus + VirtIO NIC model
- TPM 2.0, Secure Boot + OVMF, `<memballoon>` (toggle on/off in the UI)
- optional CPU pinning/topology (`backend/libvirtXml.js` supports it; the
  wizard UI doesn't expose the pinning picker yet - see "Not yet built" below)

**Silent installation.** The docs describe installing Windows by hand in the
`virt-manager` viewer (loading the VirtIO storage driver, bypassing the
network-required OOBE screen, etc). This app automates all of that with a
generated `autounattend.xml` (`backend/unattend.js`) on a small seed ISO, so
the VM boots, installs Windows, and configures itself with **no window shown
to the user** - the wizard just shows a progress bar that advances as the
install proceeds and jumps to 100% the moment QEMU Guest Agent responds
inside the finished install.

The seed ISO also carries a `bootstrap.cmd` that runs once at first logon and:
1. Silently installs the VirtIO guest tools + QEMU Guest Agent
2. Imports the official `RDPApps.reg` and runs the official `install.bat`,
   `TimeSync.ps1`, `NetProfileCleanup.ps1` - fetched once from
   `winapps-org/winapps` and cached locally forever after (see
   `backend/unattend.js: ensureOemFilesCached`), exactly per the "Final
   Configuration Steps" section of the docs (`Container.reg` is deliberately
   never downloaded, since that's Docker/Podman-only)
3. Optionally runs the Defender/Windows-Update/bloat-trim scripts you ticked
   in the wizard (`backend/unattend.js: psDisableDefender/psDisableUpdates/psDisableBloat`)

Once the VM is created, the account you set becomes `RDP_USER`/`RDP_PASS`
and `VM_NAME` is written straight into `winapps.conf` automatically.

### winapps.conf
`backend/winappsConfig.js` is a line-based parser/writer for your exact
`winapps.conf` layout (the file you uploaded). It only ever rewrites the
`KEY="value"` line for a field you actually changed - every comment, blank
line, and field order in your file is left untouched. Every field from your
file is editable here.

### Apps
WinApps already ships its own app-detection wizard, `winapps-setup`
(installed by `setup.sh`), which scans the Windows registry, matches
"community-tested" apps with proper icons/MIME types, and gives you a
checkbox picker. Rather than re-implementing that (and risking a picker
that's out of sync with WinApps' actual desktop-entry format), this screen
launches WinApps' own installer/picker in a terminal window - that's the
"Install WinApps now" / "Refresh app list" buttons. Both work fully offline
once WinApps itself is installed.

What *is* custom here: a read-only "installed programs" preview
(`backend/appsScan.js`) that queries the Windows uninstall registry over the
QEMU Guest Agent (`virsh qemu-agent-command`, no RDP/network needed) just so
you can glance at what's on the VM before opening the picker.

### Dashboard - quick actions
Directly implements the aliases you described, with the VM name substituted
per row instead of hardcoded:

| Your alias | Implemented as |
|---|---|
| `winvm-start` | `virsh start <name>` (`backend/vmctl.js`) |
| `winvm-stop` | `virsh shutdown <name>` |
| `winvm-kill` | `virsh destroy <name>` |
| `winvm-restart` | `virsh reset <name>` |
| `stop-win-network` | `iptables -A FORWARD -s <subnet> -d 0.0.0.0/0 -j DROP` via `pkexec`, subnet auto-read from `virsh net-dumpxml` (`backend/network.js`) |
| `connect-win-network` | same rule, `-D` instead of `-A` |

## What's new in this pass

You asked me to verify everything claimed against the docs, and to add
network/stats controls, a properly displayed app picker, fully hands-off
ISO handling, and live Defender/Update/Firewall/service/resource controls.
Here's what changed:

### Fully automatic ISO acquisition (`backend/isoAcquire.js`)
The wizard no longer requires picking any file:
- **VirtIO drivers ISO** downloads straight from the official Fedora
  mirror's stable `latest-virtio` link - no interaction needed, ever.
- **Windows installer ISO** is fetched by replicating the same public,
  unauthenticated request flow Microsoft's own software-download page uses
  to hand out direct ISO links (the same technique behind tools like
  Fido/Rufus's ISO downloader). Both are cached under
  `~/.local/share/winapps-manager/downloads/` so later VMs reuse them
  instantly. **Caveat, stated plainly:** Microsoft can rate-limit or change
  this endpoint at any time without notice; if it fails, the wizard's
  "Advanced: use my own ISO files" section is there as a manual fallback -
  I didn't want to hide a hard failure behind a fake success.

### VM stats + resource/storage editing (`backend/vmStats.js`, `backend/vmResize.js`)
Dashboard → **Details** on any VM now shows live CPU %, RAM used/total, disk
allocated/capacity, and network throughput (via `virsh dommemstat`/`cpu-stats`/
`domifstat`/`qemu-img info`), plus editable vCPUs, RAM, and qcow2 disk size
(`virt-xml --edit` + `qemu-img resize`, applied while the VM is shut off -
growing the disk still needs "Extend Volume" inside Windows Disk Management
afterwards, which I call out in the UI rather than silently repartitioning
for you).

### Live Defender/Update/Firewall/bloat-service control (`backend/guestControl.js`)
These were previously only set once at first boot. They're now:
- Applied at first boot (unchanged, still your wizard checkboxes) **and**
- Toggleable live afterwards from Dashboard → Details, with real status
  read back from the guest (`Get-MpPreference`, `Get-Service wuauserv`,
  `Get-NetFirewallProfile`) so the badge always reflects actual state, not
  just what you last clicked.
- The bloat-service list is expanded (idle telemetry/search/indexing
  services, scheduled tasks, Xbox/Bing appx bloat) and now also tunes the
  power plan for a headless VM (disables monitor/disk timeouts, switches to
  the minimum power scheme) - the "optimize performance/RAM" ask.

### A real, winboat-style app picker (`backend/winappsApps.js`)
I looked at WinApps' actual internals before touching this: `installer.sh`
already does registry-based detection over a hidden RDP session, matches
against its community-tested `apps/` list (pulling in proper icons + MIME
types), and caches each result as `~/.local/share/winapps/apps/<exe>/{info,icon.png}`.
Rather than reimplementing that detection (and risking a picker that drifts
out of sync with WinApps' real format), the Apps page:
- Runs the **real** detection (`installer.sh --user`/`--system`, both
  documented non-interactive flags) with a "Detect apps now" button and a
  live log, instead of opening a separate terminal window.
- Reads WinApps' own cached `icon.png` + `info` files and renders them as an
  icon grid with per-app toggles (winboat-style), so no data is invented -
  every icon and name shown is exactly what WinApps generated.
- Toggling an app adds/removes `NoDisplay=true` on its actual `.desktop`
  file rather than deleting anything, so it's fully reversible.
- Supports WinApps' documented manual-add path
  (`bin/winapps manual "C:\path\to\app.exe"`) for anything not in the
  community list yet.
- Still exposes the read-only registry preview from before, for a quick
  look at literally everything installed regardless of WinApps' matching.

### Network controls
Unchanged in mechanism (still real `iptables`/`virsh` calls, not
simulated), but now surfaced with live status badges next to each VM on the
Dashboard instead of being a fire-and-forget button.

## Still not built (being upfront about the remaining gaps)

- **CPU pinning picker UI** - `libvirtXml.js` already accepts
  `cpuPinning`/`topology`, but the wizard doesn't have the `lscpu -e`-driven
  picker from the docs' "Optional: Assign Specific Physical CPU Cores"
  section yet.
- **Static IP config, shared-folder virtiofs setup, GPU passthrough** - all
  documented as optional in `docs/libvirt.md`, not yet exposed in the UI.
- **`net:status`/`net:disconnect` still key off the `default` libvirt
  network name**, not a specific VM - fine for one VM on the default NAT
  network; multi-VM setups on different networks need the network name
  threaded through per VM (the metadata file already has what's needed to
  wire this up, just not done yet).
- **`pkexec` is used for the iptables toggle** - works out of the box on
  most desktop Linux with a polkit agent running; happy to switch to a
  sudoers NOPASSWD rule instead if you'd rather not see a prompt at all.
- **Windows ISO auto-download is inherently the most fragile piece here**
  since it depends on an undocumented Microsoft endpoint - flagged above,
  not hidden.
