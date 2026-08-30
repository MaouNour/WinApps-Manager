#!/bin/bash
# winapps-manager bundled control script.
#
# This is the app's own copy of the alias-style helper:
#   alias stop-win-network="sudo iptables -A FORWARD -s <subnet> -d 0.0.0.0/0 -j DROP"
#   alias connect-win-network="sudo iptables -D FORWARD -s <subnet> -d 0.0.0.0/0 -j DROP"
#   alias winvm-start="virsh start <name>"   / winvm-stop / winvm-kill / winvm-restart
#
# Same logic, just parameterized (subnet / VM name are arguments instead of
# hardcoded) so one script works for every VM this app manages.
#
# Usage:
#   winapps-ctl.sh network status|start|stop <subnet-cidr>
#   winapps-ctl.sh vm status|start|stop|restart|kill <vm-name>
#
# The "network" topic is the only one this app ever runs with sudo (via a
# scoped, exact-match NOPASSWD sudoers rule installed from the app's Setup
# Check page - see backend/network.js). The "vm" topic talks to libvirt
# directly and normally needs no elevated privileges at all if the user is
# in the `libvirt` group, exactly like the original aliases; it's kept here
# too so this one file is a drop-in replacement for the whole alias set if
# you want to run it by hand from a terminal.

set -u

topic="${1:-}"
option="${2:-}"
target="${3:-}"

case "$topic" in
  network|net|n)
    subnet="$target"
    if [ -z "$subnet" ]; then
      echo "error: subnet (e.g. 192.168.122.0/24) required as 3rd argument" >&2
      exit 2
    fi
    if iptables -C FORWARD -s "$subnet" -d 0.0.0.0/0 -j DROP 2>/dev/null; then
      state="disconnected"
    else
      state="connected"
    fi
    case "$option" in
      stop|drop|disconnect|d)
        if [ "$state" != "disconnected" ]; then
          iptables -A FORWARD -s "$subnet" -d 0.0.0.0/0 -j DROP
        fi
        echo "state=disconnected"
        ;;
      start|connect|c)
        if [ "$state" = "disconnected" ]; then
          iptables -D FORWARD -s "$subnet" -d 0.0.0.0/0 -j DROP
        fi
        echo "state=connected"
        ;;
      status|"")
        echo "state=$state"
        ;;
      *)
        echo "error: unknown network option '$option'" >&2
        exit 2
        ;;
    esac
    ;;

  vm|VM|run)
    name="$target"
    if [ -z "$name" ]; then
      echo "error: VM name required as 3rd argument" >&2
      exit 2
    fi
    case "$option" in
      start|poweron|p|s)
        virsh start "$name"
        ;;
      stop|shutdown|poweroff)
        virsh shutdown "$name"
        ;;
      restart|reboot|r)
        virsh reset "$name"
        ;;
      kill|force-shutdown|k)
        virsh destroy "$name"
        ;;
      status|"")
        virsh domstate "$name"
        ;;
      *)
        echo "error: unknown vm option '$option'" >&2
        exit 2
        ;;
    esac
    ;;

  *)
    echo "usage: $(basename "$0") <network|vm> <action> <target>" >&2
    exit 1
    ;;
esac
