#!/bin/sh
# macon-agent - runs on the Mac as a root LaunchDaemon (installed by mac/install-agent.sh).
#
# What it does
#   1. Keeps a rolling chain of scheduled wake-ups (`pmset schedule wake`) so a sleeping Mac wakes by
#      itself every INTERVAL seconds, even though nothing else is running.
#   2. On every wake (and every FAST_POLL seconds while awake) it asks the relay "did the phone press
#      Wake?". If yes it lights the screen and keeps it on for HOLD seconds, so you land on the
#      normal lock screen and type your password. It then acks the request.
#   3. If it woke the Mac only to check in and nobody is using it, it puts the Mac straight back to sleep.
#
# Usage: macon-agent [run|once|doctor|cleanup|version]
# Pure POSIX sh + tools that ship with macOS (curl, pmset, caffeinate, ioreg). No Node/Python needed.

set -u
PATH="$PATH:/usr/sbin:/usr/bin:/bin:/sbin"

VERSION=1
CONF="${MACON_CONF:-/usr/local/etc/macon-agent.conf}"
STATE_DIR="${MACON_STATE_DIR:-/var/db/macon}"
LOG_FILE="${MACON_LOG:-/var/log/macon-agent.log}"
OWNER=macon

# ---- defaults (override in the config file) ----
RELAY_URL=""
AGENT_TOKEN=""
INTERVAL=300            # seconds between scheduled wake-ups on AC power
BATTERY_INTERVAL=900    # ... on battery
FAST_POLL=15            # seconds between polls while the Mac is awake
HOLD=300                # seconds to keep the screen on after a wake request
CHAIN=3                 # how many future wake-ups to keep scheduled (survives a missed cycle)
QUIET_START=""          # e.g. "23:00" - no scheduled wake-ups between QUIET_START and QUIET_END
QUIET_END=""            # e.g. "07:00"
SELF_SLEEP=1            # 1 = put the Mac back to sleep after a check-in wake if nobody is using it

die() { printf 'macon-agent: %s\n' "$*" >&2; exit 1; }
is_uint() { case "$1" in ''|*[!0-9]*) return 1 ;; esac; return 0; }

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG_FILE" 2>/dev/null
  [ -n "${MACON_VERBOSE:-}" ] && printf '%s\n' "$*"
  return 0
}

now() { if [ -n "${MACON_NOW:-}" ]; then printf '%s' "$MACON_NOW"; else date +%s; fi; }

# epoch -> local time string (BSD date on macOS, GNU date elsewhere)
fmt_epoch() {
  if date -r 0 +%s >/dev/null 2>&1; then date -r "$1" "+$2"; else date -d "@$1" "+$2"; fi
}
fmt_pmset() { fmt_epoch "$1" '%m/%d/%y %H:%M:%S'; }

minutes_of() { # "HH:MM" -> minutes since midnight
  _h=${1%%:*}; _m=${1##*:}; _h=${_h#0}; _m=${_m#0}
  echo $(( ${_h:-0} * 60 + ${_m:-0} ))
}

in_quiet() { # epoch -> success if inside the quiet window
  [ -n "$QUIET_START" ] || return 1
  _now=$(minutes_of "$(fmt_epoch "$1" '%H:%M')")
  _qs=$(minutes_of "$QUIET_START"); _qe=$(minutes_of "$QUIET_END")
  if [ "$_qs" -lt "$_qe" ]; then
    [ "$_now" -ge "$_qs" ] && [ "$_now" -lt "$_qe" ]
  else
    [ "$_now" -ge "$_qs" ] || [ "$_now" -lt "$_qe" ]
  fi
}

quiet_adjust() { # epoch -> first epoch (5 min steps) outside the quiet window
  _e=$1; _n=0
  while in_quiet "$_e" && [ "$_n" -lt 300 ]; do _e=$((_e + 300)); _n=$((_n + 1)); done
  echo "$_e"
}

read_file() { # name default
  if [ -r "$STATE_DIR/$1" ]; then cat "$STATE_DIR/$1"; else printf '%s' "${2:-}"; fi
}

load_config() {
  [ -r "$CONF" ] || die "config not found: $CONF (run mac/install-agent.sh)"
  # shellcheck disable=SC1090
  . "$CONF"
  [ -n "$RELAY_URL" ] || die "RELAY_URL is not set in $CONF"
  RELAY_URL=${RELAY_URL%/}
  case "$RELAY_URL" in
    https://?*|http://127.0.0.1*|http://localhost*) ;;
    *) die "RELAY_URL must start with https:// (got: $RELAY_URL)" ;;
  esac
  [ "${#AGENT_TOKEN}" -ge 32 ] || die "AGENT_TOKEN in $CONF is missing or too short"
  for _v in INTERVAL BATTERY_INTERVAL FAST_POLL HOLD CHAIN SELF_SLEEP; do
    eval "_val=\${$_v}"
    is_uint "$_val" || die "$_v must be a whole number (got: $_val)"
  done
  [ "$INTERVAL" -ge 30 ] && [ "$INTERVAL" -le 3600 ] || die "INTERVAL must be 30-3600 seconds"
  [ "$BATTERY_INTERVAL" -ge 30 ] && [ "$BATTERY_INTERVAL" -le 7200 ] || die "BATTERY_INTERVAL must be 30-7200 seconds"
  [ "$FAST_POLL" -ge 5 ] && [ "$FAST_POLL" -le 300 ] || die "FAST_POLL must be 5-300 seconds"
  [ "$HOLD" -ge 30 ] && [ "$HOLD" -le 3600 ] || die "HOLD must be 30-3600 seconds"
  [ "$CHAIN" -ge 1 ] && [ "$CHAIN" -le 10 ] || die "CHAIN must be 1-10"
  if [ -n "$QUIET_START$QUIET_END" ]; then
    for _q in "$QUIET_START" "$QUIET_END"; do
      case "$_q" in [0-2][0-9]:[0-5][0-9]) ;; *) die "QUIET_START/QUIET_END must look like 23:00" ;; esac
    done
    [ "$(minutes_of "$QUIET_START")" -ne "$(minutes_of "$QUIET_END")" ] || die "QUIET_START and QUIET_END must differ"
  fi
  mkdir -p "$STATE_DIR" || die "cannot create $STATE_DIR"
}

# ---------------------------------------------------------------- system probes

detect_power() {
  if pmset -g batt 2>/dev/null | head -n 1 | grep -q "Battery Power"; then AC=0; CUR_INTERVAL=$BATTERY_INTERVAL
  else AC=1; CUR_INTERVAL=$INTERVAL; fi
}

idle_secs() { # seconds since the last keyboard/mouse event ("" if unknown)
  ioreg -c IOHIDSystem 2>/dev/null | awk '/HIDIdleTime/ { gsub(/[^0-9]/, "", $NF); if ($NF != "") { printf "%d", $NF / 1000000000; exit } }'
}

others_preventing_sleep() { # someone other than caffeinate is holding the Mac awake
  pmset -g assertions 2>/dev/null | grep -E 'pid [0-9]+\(' | grep -E 'PreventUserIdleSystemSleep|PreventSystemSleep' | grep -v '(caffeinate)' | grep -q .
}

# ---------------------------------------------------------------- relay protocol

curl_relay() { # method path  -> body on stdout. Token goes via stdin, never argv (ps shows argv).
  printf 'header = "Authorization: Bearer %s"\nurl = "%s%s"\n' "$AGENT_TOKEN" "$RELAY_URL" "$2" |
    curl -fsS --max-time 20 -X "$1" -K - 2>/dev/null
}

poll() { # sets P_WAKE P_ID; fails if the relay is unreachable or answers nonsense
  _out=$(curl_relay GET "/api/agent/poll?interval=$CUR_INTERVAL&ac=$AC&awake=$AWAKE&v=$VERSION") || return 1
  P_WAKE=$(printf '%s\n' "$_out" | sed -n 's/^wake=\([01]\)$/\1/p' | head -n 1)
  P_ID=$(printf '%s\n' "$_out" | sed -n 's/^id=\([0-9]\{1,15\}\)$/\1/p' | head -n 1)
  [ -n "$P_WAKE" ] || return 1
  [ "$P_WAKE" = 0 ] || [ -n "$P_ID" ] || return 1
  return 0
}

ack() { curl_relay POST "/api/agent/ack?id=$1" >/dev/null; }

retry_ack() {
  _u=$(read_file unacked "")
  [ -n "$_u" ] || return 0
  if ack "$_u"; then rm -f "$STATE_DIR/unacked"; log "ack for request $_u delivered (retry)"; fi
}

do_wake() {
  log "wake request $P_ID: lighting the screen for ${HOLD}s"
  nohup caffeinate -u -t 10 >/dev/null 2>&1 &     # declare user activity: turns the display on / ends dark wake
  nohup caffeinate -d -i -t "$HOLD" >/dev/null 2>&1 & # keep display + system up so you can reach the lock screen
  echo $(( $(now) + HOLD )) > "$STATE_DIR/hold_until"
  echo "$P_ID" > "$STATE_DIR/last_id"
  if ack "$P_ID"; then log "request $P_ID acked"; else echo "$P_ID" > "$STATE_DIR/unacked"; log "ack failed, will retry"; fi
}

# ---------------------------------------------------------------- wake schedule

ours_event() { # epoch -> the scheduled wake we are currently inside (if any)
  [ -r "$STATE_DIR/sched" ] || return 0
  while read -r _e; do
    [ -n "$_e" ] || continue
    if [ "$1" -ge $((_e - 5)) ] && [ "$1" -le $((_e + 150)) ]; then echo "$_e"; return 0; fi
  done < "$STATE_DIR/sched"
}

cancel_chain() {
  [ -r "$STATE_DIR/sched" ] || return 0
  while read -r _e; do
    [ -n "$_e" ] && pmset schedule cancel wake "$(fmt_pmset "$_e")" "$OWNER" >/dev/null 2>&1
  done < "$STATE_DIR/sched"
  : > "$STATE_DIR/sched"
}

ensure_schedule() { # now
  _t=$1; _need=0; _first=""
  if [ ! -s "$STATE_DIR/sched" ]; then _need=1
  else
    _first=$(sort -n "$STATE_DIR/sched" | head -n 1)
    [ "$_first" -lt $((_t + 90)) ] && _need=1
  fi
  [ "$(read_file built_interval 0)" = "$CUR_INTERVAL" ] || _need=1
  [ "$_need" = 1 ] || return 0
  [ $((_t - $(read_file last_build 0))) -ge 30 ] || return 0   # don't hammer pmset if it keeps failing
  echo "$_t" > "$STATE_DIR/last_build"

  cancel_chain
  _e=$(quiet_adjust $((_t + CUR_INTERVAL))); _i=1; _list=""
  : > "$STATE_DIR/sched.new"
  while [ "$_i" -le "$CHAIN" ]; do
    if pmset schedule wake "$(fmt_pmset "$_e")" "$OWNER" >/dev/null 2>&1; then
      echo "$_e" >> "$STATE_DIR/sched.new"
      _list="$_list $(fmt_epoch "$_e" '%H:%M')"
    else
      log "pmset schedule wake failed for $(fmt_pmset "$_e") (is the agent running as root?)"
    fi
    _e=$(quiet_adjust $((_e + CUR_INTERVAL))); _i=$((_i + 1))
  done
  mv "$STATE_DIR/sched.new" "$STATE_DIR/sched"
  echo "$CUR_INTERVAL" > "$STATE_DIR/built_interval"
  log "scheduled wake-ups (every ${CUR_INTERVAL}s, $([ "$AC" = 1 ] && echo AC || echo battery)):${_list:- none}"
}

maybe_self_sleep() { # now
  [ "$SELF_SLEEP" = 1 ] && [ -n "$OURS" ] || return 0
  [ "$(read_file slept_for 0)" = "$OURS" ] && return 0
  [ "$(read_file hold_until 0)" -gt "$1" ] && return 0
  # Give the network time to come up after a dark wake before deciding.
  if [ "$POLL_OK" != 1 ] && [ "$1" -lt $((OURS + 90)) ]; then return 0; fi
  echo "$OURS" > "$STATE_DIR/slept_for"
  # idle < seconds-since-wake means there was keyboard/mouse input after the wake: a person is here.
  if [ "$IDLE" -lt $(( $1 - OURS - 3 )) ]; then log "someone is using the Mac; leaving it awake"; return 0; fi
  pmset displaysleepnow >/dev/null 2>&1
  sleep "${MACON_DISPLAY_DELAY:-2}"
  if others_preventing_sleep; then log "another process is keeping the Mac awake; not forcing sleep"; return 0; fi
  log "check-in done, nothing requested: back to sleep"
  pmset sleepnow >/dev/null 2>&1
}

# ---------------------------------------------------------------- main loop

POLL_FAIL=0; POLL_OK=0; OURS=""; AC=1; CUR_INTERVAL=$INTERVAL; AWAKE=0; IDLE=0; P_WAKE=0; P_ID=""

iteration() {
  _t=$(now)
  detect_power
  IDLE=$(idle_secs); is_uint "${IDLE:-}" || IDLE=0
  if [ "$IDLE" -lt 120 ] || [ "$(read_file hold_until 0)" -gt "$_t" ]; then AWAKE=1; else AWAKE=0; fi
  OURS=$(ours_event "$_t")
  retry_ack
  if poll; then
    [ "$POLL_FAIL" = 1 ] && log "relay reachable again"
    POLL_FAIL=0; POLL_OK=1
    if [ "$P_WAKE" = 1 ] && [ "$P_ID" != "$(read_file last_id '')" ]; then do_wake; fi
  else
    POLL_OK=0
    [ "$POLL_FAIL" = 0 ] && log "relay unreachable; will keep retrying"
    POLL_FAIL=1
  fi
  ensure_schedule "$_t"
  maybe_self_sleep "$_t"
  [ "$POLL_OK" = 1 ]
}

run_loop() {
  load_config
  log "agent v$VERSION started (interval ${INTERVAL}s/${BATTERY_INTERVAL}s, relay $RELAY_URL)"
  _last=0
  while :; do
    _t=$(now)
    if [ $((_t - _last)) -ge "$FAST_POLL" ]; then
      if iteration; then _last=$_t; else _last=$((_t - FAST_POLL + 4)); fi   # failed: retry in ~5s
    fi
    # keep the log small
    if [ -f "$LOG_FILE" ] && [ "$(wc -c < "$LOG_FILE")" -gt 262144 ]; then tail -n 300 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"; fi
    sleep 5
  done
}

doctor() {
  MACON_VERBOSE=1
  ok=1
  say() { printf '%s %s\n' "$1" "$2"; }
  [ "$(uname)" = Darwin ] || say '!' "not macOS: pmset-based wake only works on a Mac"
  [ "$(id -u)" = 0 ] || { say '✗' "run with sudo (pmset schedule needs root)"; ok=0; }
  if [ -r "$CONF" ]; then
    ( load_config ) && say '✓' "config valid: $CONF" || { say '✗' "config invalid"; ok=0; }
    _perm=$(ls -l "$CONF" | cut -c1-10)
    [ "$_perm" = "-rw-------" ] && say '✓' "config is private (600)" || say '!' "config permissions are $_perm; should be -rw------- (it contains the token)"
  else say '✗' "no config at $CONF"; exit 1; fi
  load_config
  detect_power
  say 'i' "power: $([ "$AC" = 1 ] && echo 'AC (interval '$INTERVAL's)' || echo 'battery (interval '$BATTERY_INTERVAL's)')"
  _code=$(printf 'header = "Authorization: Bearer %s"\nurl = "%s/api/agent/poll?interval=%s&ac=%s&awake=1&v=%s"\n' "$AGENT_TOKEN" "$RELAY_URL" "$CUR_INTERVAL" "$AC" "$VERSION" | curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -K - 2>/dev/null)
  case "$_code" in
    200) say '✓' "relay reachable and token accepted ($RELAY_URL)" ;;
    401) say '✗' "relay reachable but the token was rejected: AGENT_TOKEN must match relay/secrets.json"; ok=0 ;;
    *) say '✗' "cannot reach relay (HTTP '$_code'). Check RELAY_URL and your internet connection"; ok=0 ;;
  esac
  say 'i' "scheduled wake events (pmset -g sched):"
  pmset -g sched 2>/dev/null | sed 's/^/    /'
  say 'i' "power settings:"
  pmset -g 2>/dev/null | grep -E ' (womp|powernap|sleep|tcpkeepalive) ' | sed 's/^/    /'
  say 'i' "recent wake events (look for 'DarkWake' = silent check-in, 'Wake' = screen may light):"
  pmset -g log 2>/dev/null | grep -E '(Wake|DarkWake) +[0-9-]+ .*due to' | tail -n 8 | sed 's/^/    /'
  [ "$ok" = 1 ] && say '✓' "all good" || say '✗' "fix the items marked ✗"
  [ "$ok" = 1 ]
}

cleanup() {
  [ -r "$CONF" ] && . "$CONF"
  mkdir -p "$STATE_DIR"
  OWNER=$OWNER; cancel_chain
  echo "macon-agent: cancelled scheduled wake-ups"
}

case "${1:-run}" in
  run) run_loop ;;
  once) load_config; MACON_VERBOSE=${MACON_VERBOSE:-}; iteration; exit 0 ;;
  doctor) doctor ;;
  cleanup) cleanup ;;
  version) echo "macon-agent $VERSION" ;;
  *) die "usage: macon-agent [run|once|doctor|cleanup|version]" ;;
esac
