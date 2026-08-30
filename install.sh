#!/usr/bin/env bash
#
# WinApps Manager installer (for running from a cloned repo / source checkout).
#
#   1. npm install
#   2. Deploys the bundled network-control script to a stable path
#   3. Delegates to resources/scripts/setup-network-sudo.sh for the actual
#      passwordless-sudo setup (same logic used by the packaged .deb/.rpm/
#      .pacman builds via `winapps-manager-setup-network` - see that script
#      and resources/scripts/pkg-postinstall.sh for why it's shared instead
#      of duplicated here)
#
# If you installed WinApps Manager from a .deb/.rpm/.pacman package instead
# of cloning this repo, you don't need this script at all - just run
# `winapps-manager-setup-network` (installed on your PATH automatically).
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

echo "==> Running network sudoers setup"
"$(pwd)/resources/scripts/setup-network-sudo.sh" "${1:-default}"

echo "==> Done. Run: npm start"
