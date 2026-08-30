#!/usr/bin/env bash
#
# WinApps Manager installer.
#
#   1. npm install
#   2. Deploys the bundled network-control script to a stable path
#   3. Installs a narrowly-scoped NOPASSWD sudoers rule for it, so the app's
#      network toggle/status check never has to prompt for a password.
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
# Usage:
#   ./install.sh [libvirt-network-name]     (defaults to "default")

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

echo "==> Installing npm dependencies"
npm install

BIN_DIR="$HOME/.local/share/winapps-manager/bin"
mkdir -p "$BIN_DIR"
SCRIPT_SRC="$(pwd)/resources/scripts/winapps-ctl.sh"
SCRIPT_DST="$BIN_DIR/winapps-ctl.sh"

if [ ! -f "$SCRIPT_SRC" ]; then
  echo "error: $SCRIPT_SRC not found - run this from the winapps-manager project root." >&2
  exit 1
fi
cp "$SCRIPT_SRC" "$SCRIPT_DST"
chmod 755 "$SCRIPT_DST"
echo "==> Deployed control script to $SCRIPT_DST"

NET_NAME="${1:-default}"

if ! command -v virsh >/dev/null 2>&1; then
  echo "==> virsh not found - skipping passwordless sudo setup."
  echo "    Install/enable libvirt first, then re-run: ./install.sh $NET_NAME"
  echo "==> Done. Run: npm start"
  exit 0
fi

XML="$(virsh net-dumpxml "$NET_NAME" 2>/dev/null || true)"
if [ -z "$XML" ]; then
  echo "==> Could not read libvirt network '$NET_NAME' - skipping passwordless sudo setup."
  echo "    Once that network exists, re-run: ./install.sh $NET_NAME"
  echo "==> Done. Run: npm start"
  exit 0
fi

ADDR="$(printf '%s' "$XML" | grep -oE "<ip address=['\"][^'\"]+" | head -1 | sed -E "s/<ip address=['\"]//")"
MASK="$(printf '%s' "$XML" | grep -oE "netmask=['\"][^'\"]+" | head -1 | sed -E "s/netmask=['\"]//")"
if [ -z "$ADDR" ] || [ -z "$MASK" ]; then
  echo "==> Could not parse the subnet out of network '$NET_NAME' - skipping passwordless sudo setup." >&2
  echo "==> Done. Run: npm start"
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
  echo "# Installed by WinApps Manager install.sh - passwordless network isolation toggle."
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

echo "==> Run: npm start"
