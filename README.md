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
A real in-app logo+checkbox picker (`backend/appsCatalog.js` +
`backend/appsManage.js`), not a terminal launcher:

- **Catalog sync** (`appsCatalog.js`) - a one-time (or explicit re-run)
  fetch of the `apps/` folder from the WinApps repo: each app's `info` file
  (name/categories/MIME types) and `icon.svg` are cached to
  `~/.local/share/winapps-manager/app-catalog/`. This is the *only* network
  use anywhere in the Apps screen, and it's opt-in and one-time - after that
  the picker is 100% offline, same pattern as the existing OEM-file caching
  used during VM creation.
- **Enable/disable** (`appsManage.js`) - ticking a box writes
  `~/.local/share/applications/<slug>.desktop` plus an executable
  `~/.local/bin/<slug>` wrapper that calls `winapps <slug>`; unticking
  removes both. This is byte-for-byte what WinApps' own installer does when
  you tick a box in its terminal wizard (`Exec=<bin>/winapps <slug> %F`,
  `Icon=`, `Categories=`, `MimeType=` all populated from the cached `info`
  file) - just triggered by a click instead of a `dialog` TUI.
  "Windows (Full RDP Session)" is always included as its own tile, matching
  the repo's README app table.
- **Detection** - a "Detect installed apps" button re-runs the existing
  guest-agent registry scan (`appsScan.js`, still offline/no-RDP) and
  fuzzy-matches installed program names against the catalog, showing a green
  dot on tiles that look installed. Purely informational - every tile stays
  checkable regardless, since detection is best-effort name matching.

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

## Not yet built (next steps, scoped on purpose)

This is a first full pass, not the finished product - flagging what's
scaffolded vs. what needs another iteration:

- **ISO auto-downloader** - the wizard's ISO fields are still local-file-only
  (browse to a Windows ISO and a VirtIO ISO you already downloaded). An
  in-app "download instead" option for both is the next gap to close.
- **CPU pinning picker UI** - the backend (`libvirtXml.js`) already accepts
  `cpuPinning`/`topology`, but the wizard doesn't have the `lscpu -e`-driven
  picker from the docs' "Optional: Assign Specific Physical CPU Cores"
  section yet.
- **ISO downloader** - by design, ISO selection is local-file-only right now
  (per your "shouldn't require network" note for day-to-day use); a
  "download VirtIO ISO" convenience button could be added as an opt-in.
- **Static IP config, shared-folder virtiofs setup, GPU passthrough** - all
  documented as optional in `docs/libvirt.md`, not yet exposed in the UI.
- **`net:status`/`net:disconnect` currently key off the `default` libvirt
  network name**, not a specific VM - fine while there's one VM on the
  default NAT network, but multi-VM setups on different networks need the
  network name threaded through per VM (the VM metadata saved in
  `~/.local/share/winapps-manager/vms/<name>.json` already has what's needed
  to wire this up).
- **`pkexec` is used for the iptables toggle** - works out of the box on
  most desktop Linux, but if there's no polkit agent running you'll get a
  password prompt failure; happy to switch to a sudoers NOPASSWD rule
  instead if you'd rather not see any prompt at all.
