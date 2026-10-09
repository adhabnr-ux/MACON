#!/bin/sh
# Installs the macon wake agent on THIS Mac (run in Terminal):
#     sudo ./mac/install-agent.sh [--url=https://macon-relay.you.workers.dev] [--interval=300]
#                                 [--battery-interval=900] [--quiet=23:00-07:00]
# Reads the agent token from relay/secrets.json (created by `node bin/macon.js relay-init`).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(dirname "$HERE")
die() { echo "install-agent: $*" >&2; exit 1; }

[ "$(uname)" = Darwin ] || die "run this on the Mac you want to wake"
[ "$(id -u)" = 0 ] || exec sudo "$0" "$@"

URL=""; INTERVAL=300; BATT=900; QUIET=""
for a in "$@"; do
  case "$a" in
    --url=*) URL=${a#--url=} ;;
    --interval=*) INTERVAL=${a#--interval=} ;;
    --battery-interval=*) BATT=${a#--battery-interval=} ;;
    --quiet=*) QUIET=${a#--quiet=} ;;
    *) die "unknown option: $a" ;;
  esac
done

TOKEN=${MACON_AGENT_TOKEN:-}
if [ -z "$TOKEN" ] && [ -r "$ROOT/relay/secrets.json" ]; then
  TOKEN=$(plutil -extract AGENT_TOKEN raw -o - "$ROOT/relay/secrets.json" 2>/dev/null || true)
fi
[ -n "$TOKEN" ] || { printf 'Agent token (AGENT_TOKEN from relay/secrets.json): '; read -r TOKEN; }
[ -n "$URL" ] || { printf 'Relay URL (e.g. https://macon-relay.yourname.workers.dev): '; read -r URL; }
URL=${URL%/}
case "$URL" in https://?*) ;; *) die "relay URL must start with https://" ;; esac
[ "${#TOKEN}" -ge 32 ] || die "agent token looks wrong (too short)"

QS=""; QE=""
if [ -n "$QUIET" ]; then QS=${QUIET%-*}; QE=${QUIET#*-}; fi

echo "==> Installing agent"
mkdir -p /usr/local/libexec /usr/local/etc /var/db/macon
install -m 755 -o root -g wheel "$HERE/macon-agent.sh" /usr/local/libexec/macon-agent
( umask 077
  cat > /usr/local/etc/macon-agent.conf <<CONF
# macon agent settings (root-only: contains the relay token). Restart after editing:
#   sudo launchctl kickstart -k system/com.macon.agent
RELAY_URL="$URL"
AGENT_TOKEN="$TOKEN"
INTERVAL=$INTERVAL            # seconds between wake-ups on power (worst-case delay after you tap Wake)
BATTERY_INTERVAL=$BATT      # ... on battery
HOLD=300                   # seconds the screen stays on after a wake request
QUIET_START="$QS"          # e.g. "23:00"  (no scheduled wake-ups until QUIET_END)
QUIET_END="$QE"            # e.g. "07:00"
SELF_SLEEP=1               # 1 = sleep again right after a check-in if nobody is using the Mac
CONF
)
chown root:wheel /usr/local/etc/macon-agent.conf
chmod 600 /usr/local/etc/macon-agent.conf
install -m 644 -o root -g wheel "$HERE/com.macon.agent.plist" /Library/LaunchDaemons/com.macon.agent.plist

echo "==> Power settings"
pmset -a womp 1 >/dev/null 2>&1 && echo "  wake for network access: on"
pmset -a powernap 1 >/dev/null 2>&1 && echo "  Power Nap: on (keeps Wi-Fi alive during short wake-ups)"

echo "==> Starting"
launchctl bootout system/com.macon.agent >/dev/null 2>&1 || true
launchctl bootstrap system /Library/LaunchDaemons/com.macon.agent.plist
launchctl enable system/com.macon.agent
sleep 3
echo
/usr/local/libexec/macon-agent doctor || true
cat <<MSG

Installed. Test it for real:
  1. Open the app on your phone and tap Wake while the Mac is awake: the screen should light within ~15 s.
  2. Put the Mac to sleep (Apple menu > Sleep), wait a minute, tap Wake. It should come up within $INTERVAL s.
Logs:      tail -f /var/log/macon-agent.log
Check-up:  sudo /usr/local/libexec/macon-agent doctor
MSG
