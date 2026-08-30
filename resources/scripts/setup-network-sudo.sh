#!/usr/bin/env bash
#
# WinApps Manager - passwordless network-toggle setup.
#
# Installs a narrowly-scoped NOPASSWD sudoers rule so the app's network
# toggle/status check (Dashboard) never has to prompt for a password.
#
# Why this exists instead of just using the in-app "Setup Check -> Enable"
# button: that button uses `pkexec`, which depends on a graphical polkit
# authentication agent being registered. Many window managers (tiling WMs,
# minimal setups) don't run one, so pkexec fails immediately with
# "Request dismissed" (exit 126) instead of ever showing a prompt - and
# since the Dashboard's background poller checks network status every 4s,
# that turns into a password-prompt loop. Running this script does the same
# sudoers setup through a single, ordinary terminal `sudo` prompt instead,
# which works everywhere regardless of what's running your desktop.
#
# Unlike install.sh, this script has NO dependency on the winapps-manager
# git repo or `npm install` - it only ever touches this app's own stable,
# per-user data directory (~/.local/share/winapps-manager), which the app
# itself already populates (including its own copy of winapps-ctl.sh) the
# first time you run it. That's what makes it safe to ship inside the
# .deb/.rpm/.pacman package and run standalone, without cloning anything -
# see resources/scripts/pkg-postinstall.sh.
#
# Usage:
#   winapps-manager-setup-network [libvirt-network-name]   (defaults to "default")
#   (installed packages symlink this script to that name on PATH; when run
#   from a cloned repo, install.sh calls it directly instead)

set -euo pipefail

BIN_DIR="$HOME/.local/share/winapps-manager/bin"
SCRIPT_DST="$BIN_DIR/winapps-ctl.sh"

if [ ! -f "$SCRIPT_DST" ]; then
  echo "error: $SCRIPT_DST not found yet." >&2
  echo "       Run WinApps Manager at least once first - it deploys its" >&2
  echo "       control script there automatically on startup, then re-run this." >&2
  exit 1
fi

NET_NAME="${1:-default}"

if ! command -v virsh >/dev/null 2>&1; then
  echo "==> virsh not found - skipping passwordless sudo setup."
  echo "    Install/enable libvirt first, then re-run: $(basename "$0") $NET_NAME"
  exit 0
fi

XML="$(virsh net-dumpxml "$NET_NAME" 2>/dev/null || true)"
if [ -z "$XML" ]; then
  echo "==> Could not read libvirt network '$NET_NAME' - skipping passwordless sudo setup."
  echo "    Once that network exists (e.g. after creating a VM in WinApps Manager)," \
       "re-run: $(basename "$0") $NET_NAME"
  exit 0
fi

ADDR="$(printf '%s' "$XML" | grep -oE "<ip address=['\"][^'\"]+" | head -1 | sed -E "s/<ip address=['\"]//")"
MASK="$(printf '%s' "$XML" | grep -oE "netmask=['\"][^'\"]+" | head -1 | sed -E "s/netmask=['\"]//")"
if [ -z "$ADDR" ] || [ -z "$MASK" ]; then
  echo "==> Could not parse the subnet out of network '$NET_NAME' - skipping passwordless sudo setup." >&2
  exit 0
fi

netmask_octet_bits() {
  case "$1" in
    255) echo 8 ;; 254) echo 7 ;; 252) echo 6 ;; 248) echo 5 ;;
    240) echo 4 ;; 224) echo 3 ;; 192) echo 2 ;; 128) echo 1 ;; 0) echo 0 ;;
    *) echo 0 ;;
  esac
}

IFS=. read -r a1 a2 a3 _a4 <<< "$ADDR"
IFS=. read -r m1 m2 m3 m4 <<< "$MASK"
CIDR=0
for octet in "$m1" "$m2" "$m3" "$m4"; do
  CIDR=$((CIDR + $(netmask_octet_bits "$octet")))
done
SUBNET="${a1}.${a2}.${a3}.0/${CIDR}"

echo "==> Installing passwordless sudo rule for network toggling (subnet: $SUBNET)"
echo "    You'll be asked for your sudo password once, right here in the terminal."

SUDOERS_FILE="/etc/sudoers.d/90-winapps-manager-network"
TMP="$(mktemp)"
{
  echo "# Installed by WinApps Manager setup-network-sudo.sh - passwordless network isolation toggle."
  echo "# Scoped to exactly this script, exactly status/stop/start, exactly this VM's subnet."
  echo "# Never grants raw iptables or any other command."
  echo "$USER ALL=(root) NOPASSWD: $SCRIPT_DST network status $SUBNET, $SCRIPT_DST network stop $SUBNET, $SCRIPT_DST network start $SUBNET"
} > "$TMP"
chmod 440 "$TMP"

# Validate syntax before it ever touches /etc/sudoers.d - a broken sudoers
# file can lock sudo out system-wide, so this check is mandatory.
sudo visudo -c -f "$TMP"
sudo install -m 0440 -o root -g root "$TMP" "$SUDOERS_FILE"
rm -f "$TMP"

echo "==> Done. Passwordless network toggle installed at $SUDOERS_FILE"
echo "==> Verifying (should print a state with no password prompt)..."
if sudo -n "$SCRIPT_DST" network status "$SUBNET"; then
  echo "==> Verified - network status/toggle will never prompt for a password again."
else
  echo "==> Warning: verification call still needed a prompt. Check $SUDOERS_FILE and re-run this script." >&2
fi
