#!/bin/bash
#
# electron-builder afterInstall hook (deb/rpm/pacman - see package.json's
# "build.deb/rpm/pacman.afterInstall"). Runs once, automatically, as root,
# right after `dnf install` / `apt install` / `pacman -U` unpacks the app.
#
# All this does is make resources/scripts/setup-network-sudo.sh reachable as
# a plain command, so the passwordless-network-toggle setup (see that
# script's own comments) works out of the box for a package install too,
# without ever cloning the winapps-manager repo or running install.sh.
#
# Deliberately does NOT run setup-network-sudo.sh itself here: this hook
# runs as root at package-install time, often before any Windows VM/libvirt
# network even exists yet, and modifying /etc/sudoers.d should always be an
# explicit, visible, user-initiated action (a terminal prompt for their own
# password) - never something a package install does silently on their
# behalf. ${sanitizedProductName} / ${executable} are filled in by
# electron-builder - see https://www.electron.build/docs/linux (Linux ->
# afterInstall).

SETUP_SCRIPT="/opt/${sanitizedProductName}/resources/scripts/setup-network-sudo.sh"
LINK="/usr/bin/winapps-manager-setup-network"

if [ -f "$SETUP_SCRIPT" ]; then
  chmod 755 "$SETUP_SCRIPT" 2>/dev/null || true
  ln -sf "$SETUP_SCRIPT" "$LINK" 2>/dev/null || true
fi

exit 0
