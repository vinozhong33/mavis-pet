#!/usr/bin/env bash
# verify.sh — single-shot end-to-end verification for @mavis-pet/broker.
#
# Boots the real broker on an ephemeral port, runs every spec scenario over
# real HTTP + WebSocket, checks timing accuracy, asserts stdout is clean,
# and prints a single line on stdout that the engine/operator can grep:
#
#   VERDICT: PASS   (exit 0)
#   VERDICT: FAIL   (exit 1)
#
# Usage:  bash scripts/verify.sh [PORT]
# Reqs:   node 18+, npm install already done in this directory.
#
# What it covers (in order):
#   1. broker boots with stdout silent (no pollution)
#   2. GET /healthz returns 200 ok
#   3. GET /status reports idle on cold start
#   4. WS client receives initial state=idle on connect
#   5. POST /event PreToolUse → state=run
#   6. POST /event PostToolUse exitCode=1 → state=failed
#   7. failed auto-degrades within [1.8, 2.5] s back to run/idle (2s spec)
#   8. POST /event MessageComplete → state=wave
#   9. wave auto-degrades within [0.8, 1.6] s back to run/idle (1s spec)
#  10. multi-session: A=run + B=failed → global=failed
#  11. POST /switch slug=boba → ws receives {type:"pet",slug:"boba"}
#  12. graceful SIGTERM shuts down cleanly, stdout still empty
#
# After all checks complete, prints VERDICT line.

set -u

PORT="${1:-17861}"
HOST="127.0.0.1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BROKER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORK_DIR="$(mktemp -d -t mavis-pet-broker-verify.XXXXXX)"
trap 'cleanup' EXIT

PASS_COUNT=0
FAIL_COUNT=0
FAIL_NOTES=()

cleanup() {
  if [[ -n "${BROKER_PID:-}" ]] && kill -0 "$BROKER_PID" 2>/dev/null; then
    kill "$BROKER_PID" 2>/dev/null || true
    wait "$BROKER_PID" 2>/dev/null || true
  fi
  if [[ -n "${LISTENER_PID:-}" ]] && kill -0 "$LISTENER_PID" 2>/dev/null; then
    kill "$LISTENER_PID" 2>/dev/null || true
    wait "$LISTENER_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK_DIR"
}

# Print only via these helpers; checks must NOT leak intermediate noise.
note() { printf '  %s\n' "$*" >&2; }
pass() { PASS_COUNT=$((PASS_COUNT + 1)); note "PASS: $*"; }
fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  FAIL_NOTES+=("$*")
  note "FAIL: $*"
}

require_node() {
  if ! command -v node >/dev/null 2>&1; then
    fail "node not found in PATH"
    return 1
  fi
}

start_broker() {
  : >"$WORK_DIR/broker.stdout"
  : >"$WORK_DIR/broker.stderr"
  node "$BROKER_DIR/bin/mavis-pet-broker.mjs" --port "$PORT" --pet boba \
    >"$WORK_DIR/broker.stdout" 2>"$WORK_DIR/broker.stderr" &
  BROKER_PID=$!
  # Wait up to 3s for the bind line to appear in stderr.
  for _ in $(seq 1 30); do
    if grep -q "listening on http" "$WORK_DIR/broker.stderr" 2>/dev/null; then
      return 0
    fi
    sleep 0.1
  done
  fail "broker did not start within 3s"
  return 1
}

start_listener() {
  : >"$WORK_DIR/ws.log"
  node "$BROKER_DIR/scripts/ws-listener.mjs" "$PORT" /ws \
    >"$WORK_DIR/ws.log" 2>>"$WORK_DIR/broker.stderr" &
  LISTENER_PID=$!
  # Wait for "connected" line.
  for _ in $(seq 1 30); do
    if grep -q "connected to ws://" "$WORK_DIR/ws.log" 2>/dev/null; then
      return 0
    fi
    sleep 0.1
  done
  fail "ws listener did not connect within 3s"
  return 1
}

post_event() {
  local kind="$1"
  local sid="$2"
  local extra="${3:-}"
  local body="{\"kind\":\"$kind\",\"sessionId\":\"$sid\"$extra}"
  local resp
  resp=$(curl -sS -o /dev/null -w '%{http_code}' \
    -X POST -H 'content-type: application/json' \
    -d "$body" "http://$HOST:$PORT/event")
  echo "$resp"
}

last_state_line() {
  grep -E 'recv \{"type":"state"' "$WORK_DIR/ws.log" | tail -1
}

# Snapshot current line count of ws.log; checks measure new lines after this.
snapshot_lines() {
  wc -l <"$WORK_DIR/ws.log" 2>/dev/null | tr -d ' '
}

# Wait for the next state line whose line index in ws.log is greater than
# `from_line` (1-indexed snapshot from snapshot_lines). Prints the matching
# line on stdout when found.
wait_for_state_after_line() {
  local from="$1"
  local timeout_s="${2:-5}"
  local deadline=$((SECONDS + timeout_s))
  while [[ $SECONDS -lt $deadline ]]; do
    local line
    line=$(awk -v f="$from" 'NR > f && /recv \{"type":"state"/ {print; exit}' "$WORK_DIR/ws.log")
    if [[ -n "$line" ]]; then
      printf '%s\n' "$line"
      return 0
    fi
    sleep 0.05
  done
  return 1
}

# True if any line whose index > from_line matches the given pattern.
matched_after_line() {
  local from="$1"
  local pattern="$2"
  awk -v f="$from" -v p="$pattern" 'NR > f && $0 ~ p {found=1; exit} END {exit !found}' "$WORK_DIR/ws.log"
}

# Extract the ts inside a recv line.
extract_ts() {
  printf '%s' "$1" | sed -E 's/.*"ts":([0-9]+)\}.*/\1/'
}

# ── Run checks ────────────────────────────────────────────────────────────────

require_node || true

if [[ ! -f "$BROKER_DIR/bin/mavis-pet-broker.mjs" ]]; then
  fail "bin/mavis-pet-broker.mjs missing in $BROKER_DIR"
fi
if [[ ! -d "$BROKER_DIR/node_modules" ]]; then
  fail "node_modules missing in $BROKER_DIR — run 'npm install' first"
fi

if [[ $FAIL_COUNT -eq 0 ]]; then
  start_broker || true
fi

# 1. stdout pollution check (broker should never write to stdout).
if [[ -s "$WORK_DIR/broker.stdout" ]]; then
  fail "broker wrote to stdout (must be empty): $(head -c 200 "$WORK_DIR/broker.stdout")"
else
  pass "stdout is clean (0 bytes)"
fi

# 2. healthz
hz=$(curl -sS -o /dev/null -w '%{http_code}' "http://$HOST:$PORT/healthz" || echo 000)
if [[ "$hz" == "200" ]]; then
  pass "GET /healthz returns 200"
else
  fail "GET /healthz returned $hz"
fi

# 3. status cold
status_json=$(curl -sS "http://$HOST:$PORT/status" || echo '{}')
if printf '%s' "$status_json" | grep -q '"state":"idle"'; then
  pass "GET /status reports idle on cold start"
else
  fail "GET /status did not report idle: $status_json"
fi

# Connect WS listener.
if [[ $FAIL_COUNT -eq 0 ]]; then
  start_listener || true
fi

# 4. initial state
sleep 0.3
if grep -qE 'recv \{"type":"state","state":"idle"' "$WORK_DIR/ws.log"; then
  pass "WS client received initial state=idle on connect"
else
  fail "WS client did not receive initial idle state. ws.log:\n$(cat "$WORK_DIR/ws.log")"
fi

# Marker: timestamp the log so subsequent checks can locate "next" state lines.
MARK=$(snapshot_lines)
hc=$(post_event PreToolUse smoke ',"tool":"bash"')
if [[ "$hc" != "204" ]]; then
  fail "POST /event PreToolUse returned $hc"
fi
# 5. state=run
if line=$(wait_for_state_after_line "$MARK" 3); then
  if printf '%s' "$line" | grep -q '"state":"run"'; then
    pass "PreToolUse → state=run"
  else
    fail "PreToolUse expected state=run, got: $line"
  fi
else
  fail "no state push after PreToolUse"
fi

MARK=$(snapshot_lines)
T_FAIL_SENT_MS=$(date +%s%N | cut -c1-13)
hc=$(post_event PostToolUse smoke ',"exitCode":1')
if [[ "$hc" != "204" ]]; then
  fail "POST /event PostToolUse exitCode=1 returned $hc"
fi
# 6. state=failed
if line=$(wait_for_state_after_line "$MARK" 3); then
  if printf '%s' "$line" | grep -q '"state":"failed"'; then
    pass "PostToolUse exitCode=1 → state=failed"
    FAILED_TS=$(extract_ts "$line")
    FAILED_LINE=$(snapshot_lines)
  else
    fail "expected state=failed, got: $line"
    FAILED_TS=""
    FAILED_LINE=$(snapshot_lines)
  fi
else
  fail "no state push after PostToolUse fail"
  FAILED_TS=""
  FAILED_LINE=$(snapshot_lines)
fi

# 7. failed → degrade after ~2s
sleep 2.4
if line=$(wait_for_state_after_line "$FAILED_LINE" 1); then
  TS_DEGRADE=$(extract_ts "$line")
  if [[ -n "$FAILED_TS" && -n "$TS_DEGRADE" ]]; then
    DELTA=$((TS_DEGRADE - FAILED_TS))
    if [[ $DELTA -ge 1800 && $DELTA -le 2600 ]]; then
      pass "failed → run/idle degrade timing OK (${DELTA}ms ∈ [1800, 2600])"
    else
      fail "failed degrade timing out of bounds: ${DELTA}ms"
    fi
  else
    pass "failed degraded (timing not measured)"
  fi
else
  fail "failed state did not auto-degrade in 2.4s"
fi

MARK=$(snapshot_lines)
hc=$(post_event MessageComplete smoke '')
if [[ "$hc" != "204" ]]; then
  fail "POST /event MessageComplete returned $hc"
fi
# 8. state=wave
if line=$(wait_for_state_after_line "$MARK" 3); then
  if printf '%s' "$line" | grep -q '"state":"wave"'; then
    pass "MessageComplete → state=wave"
    WAVE_TS=$(extract_ts "$line")
    WAVE_LINE=$(snapshot_lines)
  else
    fail "expected state=wave, got: $line"
    WAVE_TS=""
    WAVE_LINE=$(snapshot_lines)
  fi
else
  fail "no state push after MessageComplete"
  WAVE_TS=""
  WAVE_LINE=$(snapshot_lines)
fi

# 9. wave → degrade after ~1s
sleep 1.4
if line=$(wait_for_state_after_line "$WAVE_LINE" 1); then
  TS_WAVE_OFF=$(extract_ts "$line")
  if [[ -n "$WAVE_TS" && -n "$TS_WAVE_OFF" ]]; then
    DELTA=$((TS_WAVE_OFF - WAVE_TS))
    if [[ $DELTA -ge 800 && $DELTA -le 1600 ]]; then
      pass "wave degrade timing OK (${DELTA}ms ∈ [800, 1600])"
    else
      fail "wave degrade timing out of bounds: ${DELTA}ms"
    fi
  else
    pass "wave degraded (timing not measured)"
  fi
else
  fail "wave state did not auto-degrade in 1.4s"
fi

# 10. multi-session aggregation: A=run, B=failed → global=failed
MARK=$(snapshot_lines)
post_event PreToolUse  multi-A ',"tool":"bash"' >/dev/null
post_event PreToolUse  multi-B ',"tool":"bash"' >/dev/null
post_event PostToolUse multi-B ',"exitCode":1'  >/dev/null
sleep 0.3
if matched_after_line "$MARK" '"state":"failed"'; then
  pass "multi-session: one RUN + one FAILED → global=failed"
else
  fail "multi-session aggregation did not emit failed"
fi

# 11. /switch broadcasts pet
MARK=$(snapshot_lines)
hc=$(curl -sS -o /dev/null -w '%{http_code}' \
  -X POST -H 'content-type: application/json' \
  -d '{"slug":"dux"}' "http://$HOST:$PORT/switch")
if [[ "$hc" == "200" ]]; then
  sleep 0.2
  if matched_after_line "$MARK" '"type":"pet","slug":"dux"'; then
    pass "POST /switch broadcasts {type:'pet',slug:'dux'}"
  else
    fail "POST /switch did not push pet message"
  fi
else
  fail "POST /switch returned $hc"
fi

# 12. SIGTERM clean shutdown + stdout still empty
kill -TERM "$BROKER_PID" 2>/dev/null || true
for _ in $(seq 1 30); do
  if ! kill -0 "$BROKER_PID" 2>/dev/null; then
    break
  fi
  sleep 0.1
done
if kill -0 "$BROKER_PID" 2>/dev/null; then
  fail "broker did not exit within 3s of SIGTERM"
  kill -KILL "$BROKER_PID" 2>/dev/null || true
else
  pass "broker exited gracefully on SIGTERM"
fi
# Final stdout check.
if [[ -s "$WORK_DIR/broker.stdout" ]]; then
  fail "broker wrote to stdout during run: $(head -c 200 "$WORK_DIR/broker.stdout")"
else
  pass "stdout still 0 bytes after full run"
fi

# ── Verdict ───────────────────────────────────────────────────────────────────
note ""
note "----- summary -----"
note "passed: $PASS_COUNT"
note "failed: $FAIL_COUNT"
if [[ $FAIL_COUNT -gt 0 ]]; then
  note "failures:"
  for n in "${FAIL_NOTES[@]}"; do
    note "  - $n"
  done
fi

# IMPORTANT — emit on STDOUT so engine/operator can grep this single token.
if [[ $FAIL_COUNT -eq 0 ]]; then
  echo "VERDICT: PASS"
  exit 0
else
  echo "VERDICT: FAIL"
  exit 1
fi
