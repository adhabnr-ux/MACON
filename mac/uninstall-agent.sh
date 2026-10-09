#!/bin/sh
# Removes the macon agent and cancels its scheduled wake-ups.
set -u
[ "$(id -u)" = 0 ] || exec sudo "$0" "$@"
[ -x /usr/local/libexec/macon-agent ] && /usr/local/libexec/macon-agent cleanup
launchctl bootout system/com.macon.agent >/dev/null 2>&1
rm -f /Library/LaunchDaemons/com.macon.agent.plist /usr/local/libexec/macon-agent /usr/local/etc/macon-agent.conf
rm -rf /var/db/macon
echo "macon agent removed. (Power settings womp/powernap were left as they are.)"
