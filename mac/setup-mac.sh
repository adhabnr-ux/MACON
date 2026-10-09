#!/bin/bash
# Run this ON YOUR MAC (Terminal). It enables Wake for network access, prints the values macon
# needs, and verifies that your Mac will ask for a password when it wakes.
set -u

if [ "$(uname)" != "Darwin" ]; then echo "This script must be run on the Mac you want to wake."; exit 1; fi

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }

bold "1/4  Enabling Wake for network access (needs your Mac password)"
if sudo pmset -a womp 1; then ok "womp = 1 (wake on magic packet / network access)"; else warn "could not set womp"; fi
# Keep the network stack reachable by a sleep proxy while asleep.
sudo pmset -a tcpkeepalive 1 >/dev/null 2>&1 && ok "tcpkeepalive = 1"
# Remote Login makes the Mac advertise an SSH service so a Bonjour Sleep Proxy will wake it on connect.
if systemsetup -getremotelogin 2>/dev/null | grep -qi "on"; then ok "Remote Login (SSH) is on — Wi-Fi wake via sleep proxy works"; else
  warn "Remote Login is off. Optional: System Settings → General → Sharing → Remote Login (helps waking over Wi-Fi via Apple TV/HomePod)."; fi

bold "2/4  Values for macon"
IFACE=$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')
MAC=$(ifconfig "${IFACE:-en0}" 2>/dev/null | awk '/ether/{print $2}')
IP=$(ipconfig getifaddr "${IFACE:-en0}" 2>/dev/null)
echo "  Interface : ${IFACE:-unknown}"
echo "  MAC       : ${MAC:-unknown}"
echo "  IP        : ${IP:-unknown}"
if networksetup -getairportnetwork "${IFACE:-en0}" 2>/dev/null | grep -q "Current Wi-Fi"; then
  warn "You're on Wi-Fi. MacBooks wake from Wi-Fi only via an Apple TV/HomePod (sleep proxy) or if plugged in and supported; Ethernet is the most reliable."
fi
warn "Wi-Fi 'Private Wi-Fi Address' makes the MAC differ per network. Use the value above while on THIS network, or turn it off for this network."
echo "  Run on your server:  node bin/macon.js init --mac=${MAC:-<mac>} --ip=${IP:-<ip>}"

bold "3/4  Current power settings"
pmset -g | grep -E "womp|tcpkeepalive|powernap|sleep " | sed 's/^/  /'

bold "4/4  Password required after wake?"
if command -v sysadminctl >/dev/null; then
  STATUS=$(sysadminctl -screenLock status 2>&1)
  echo "  $STATUS"
  if echo "$STATUS" | grep -qi "immediate\|screenLock delay is 0\|delay is immediate"; then ok "Password is required immediately after sleep"; else
    warn "Set it: System Settings → Lock Screen → 'Require password after screen saver begins or display is turned off' → Immediately"; fi
fi
echo
bold "Done. Reserve ${IP:-this IP} for this Mac in your router (DHCP reservation) so it never changes."
