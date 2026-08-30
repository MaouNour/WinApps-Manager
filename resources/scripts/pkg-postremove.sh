#!/bin/bash
#
# electron-builder afterRemove hook (deb/rpm/pacman) - removes the PATH
# symlink created by pkg-postinstall.sh. Never touches
# /etc/sudoers.d/90-winapps-manager-network - that file governs a
# passwordless-sudo grant the user explicitly opted into, and removing the
# app shouldn't silently revoke host configuration the user set up on
# purpose; setup-network-sudo.sh (and install.sh) documents where that file
# lives if they ever want to remove it by hand.

rm -f /usr/bin/winapps-manager-setup-network 2>/dev/null || true

exit 0
