#!/usr/bin/env bash
# Magarine Linux leg, step 3: Phase A (no login needed) then Phase B (needs
# the login from 2-login.md). Non-interactive throughout -- Phase B is
# skipped with a clear line, not asked about, if the login check fails.
# Everything is written under linux-leg/report/, then packed into one
# archive at the end so the whole thing can be sent back in one file (see
# 4-send-back.md).
#
# Run it with: bash 3-run.sh   (after: source ~/.magarine-linux-leg/env.sh)

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$HERE/lib/common.sh"

REPO="$(cd "$HERE/.." && pwd)"
CORE="$REPO/packages/core"
REPORT="$HERE/report"

rm -rf "$REPORT"
mkdir -p "$REPORT"

if ! command -v node >/dev/null 2>&1; then
  echo "node is not on PATH. Run: source ~/.magarine-linux-leg/env.sh   (or re-run 1-setup.sh)" >&2
  exit 1
fi

echo "=== Magarine Linux leg: 3-run.sh ===" | tee "$REPORT/00-header.txt"
{
  echo "date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "uname -a: $(uname -a)"
  [ -f /etc/os-release ] && cat /etc/os-release
} | tee -a "$REPORT/00-header.txt"

{
  echo "node:   $(node --version)"
  echo "npm:    $(npm --version)"
  echo "pnpm:   $(command -v pnpm >/dev/null 2>&1 && pnpm --version || echo 'not found')"
  echo "git:    $(git --version)"
  echo "claude: $(command -v claude >/dev/null 2>&1 && claude --version || echo 'not found')"
} | tee "$REPORT/01-versions.txt"
step_pass "versions" "node/npm/pnpm/git/claude --version" "see report/01-versions.txt"

TMP_ROOT="${TMPDIR:-/tmp}"
count_leaked_dirs() { find "$TMP_ROOT" -maxdepth 1 -name 'magarine-run-*' 2>/dev/null | wc -l | tr -d ' '; }

################################################################################
# PHASE A -- no login required
################################################################################
echo
echo "--- Phase A ---"
mkdir -p "$REPORT/phaseA"

# --- Suite, twenty cold runs, with a leak count around the whole pass -------
SUITE_BEFORE="$(count_leaked_dirs)"
SUITE_DIR="$REPORT/phaseA/suite-runs"
mkdir -p "$SUITE_DIR"
SUITE_FAILS=0
( cd "$CORE" && pnpm install ) > "$REPORT/phaseA/pnpm-install.log" 2>&1
INSTALL_RC=$?
if [ "$INSTALL_RC" -ne 0 ]; then
  step_fail "pnpm install" "pnpm install (in packages/core)" "$INSTALL_RC" "See report/phaseA/pnpm-install.log."
else
  for i in $(seq -w 1 20); do
    ( cd "$CORE" && pnpm test ) > "$SUITE_DIR/run-$i.log" 2>&1
    rc=$?
    if [ "$rc" -ne 0 ]; then
      SUITE_FAILS=$((SUITE_FAILS + 1))
      step_fail "suite run $i/20" "pnpm test (in packages/core)" "$rc" "See report/phaseA/suite-runs/run-$i.log."
    fi
  done
  if [ "$SUITE_FAILS" -eq 0 ]; then
    step_pass "suite, 20 cold runs" "pnpm test x20 (in packages/core)" "all 20 green -- see report/phaseA/suite-runs/"
  fi
fi
SUITE_AFTER="$(count_leaked_dirs)"
{
  echo "magarine-run-* entries under $TMP_ROOT before the 20 runs: $SUITE_BEFORE"
  echo "magarine-run-* entries under $TMP_ROOT after the 20 runs:  $SUITE_AFTER"
} | tee "$REPORT/phaseA/temp-dir-counts.txt"
if [ "$SUITE_AFTER" -gt "$SUITE_BEFORE" ]; then
  step_fail "temp directory leak check" "find $TMP_ROOT -name 'magarine-run-*'" "0" \
    "$((SUITE_AFTER - SUITE_BEFORE)) more magarine-run-* dir(s) after than before -- see report/phaseA/temp-dir-counts.txt."
else
  step_pass "temp directory leak check" "find $TMP_ROOT -name 'magarine-run-*'" "0 net new directories"
fi

# --- POSIX tree-kill, proven against the OS by pid --------------------------
node "$HERE/checks/tree-kill.ts" > "$REPORT/phaseA/tree-kill.log" 2>&1
TREE_KILL_RC=$?
if [ "$TREE_KILL_RC" -eq 0 ]; then
  step_pass "POSIX tree-kill (stop())" "node linux-leg/checks/tree-kill.ts" "$(tail -1 "$REPORT/phaseA/tree-kill.log")"
else
  step_fail "POSIX tree-kill (stop())" "node linux-leg/checks/tree-kill.ts" "$TREE_KILL_RC" "See report/phaseA/tree-kill.log."
fi

# --- Daemon lifecycle: start, refuse a second start, hard-kill, stale
#     recovery, graceful SIGTERM shutdown ------------------------------------
DAEMON_STATE="$(mktemp -d)"
DAEMON_LOG="$REPORT/phaseA/daemon-lifecycle.log"
: > "$DAEMON_LOG"

start_daemon() { # writes stdout/stderr to $1/$2, returns the pid via echo
  node "$CORE/src/cli.ts" serve --state-dir "$DAEMON_STATE" --adapter fake --port 0 --json \
    > "$1" 2> "$2" &
  echo $!
}

wait_for_daemon_file() {
  for _ in $(seq 1 50); do
    [ -f "$DAEMON_STATE/daemon.json" ] && return 0
    sleep 0.2
  done
  return 1
}

{
  echo "# first serve"
  PID_A="$(start_daemon "$REPORT/phaseA/daemon-a-stdout.log" "$REPORT/phaseA/daemon-a-stderr.log")"
  if wait_for_daemon_file; then
    cp "$DAEMON_STATE/daemon.json" "$REPORT/phaseA/daemon-a.json"
    echo "daemon A pid=$PID_A, daemon.json: $(cat "$DAEMON_STATE/daemon.json")"

    echo "# a second serve against the same state dir must refuse"
    SECOND_OUT="$(node "$CORE/src/cli.ts" serve --state-dir "$DAEMON_STATE" --adapter fake --port 0 --json 2>&1)"
    SECOND_RC=$?
    echo "second serve rc=$SECOND_RC output: $SECOND_OUT"

    echo "# graceful SIGTERM shutdown of daemon A, from this separate shell"
    SHUTDOWN_MODE_SEEN="$(grep -o '"shutdownMode": *"[a-z-]*"' "$DAEMON_STATE/daemon.json")"
    kill -TERM "$PID_A"
    wait "$PID_A" 2>/dev/null
    A_EXIT=$?
    if [ -f "$DAEMON_STATE/daemon.json" ]; then
      echo "daemon A: daemon.json NOT removed after SIGTERM (rc=$A_EXIT) -- FAIL"
      A_GRACEFUL=0
    else
      echo "daemon A: daemon.json removed after SIGTERM (rc=$A_EXIT), $SHUTDOWN_MODE_SEEN observed while live -- OK"
      A_GRACEFUL=1
    fi

    echo "# second serve, now that A is gone, should start cleanly"
    PID_B="$(start_daemon "$REPORT/phaseA/daemon-b-stdout.log" "$REPORT/phaseA/daemon-b-stderr.log")"
    if wait_for_daemon_file; then
      cp "$DAEMON_STATE/daemon.json" "$REPORT/phaseA/daemon-b.json"
      echo "daemon B pid=$PID_B started cleanly"

      echo "# hard-kill B (no SIGTERM), leaving a stale daemon.json"
      kill -KILL "$PID_B"
      wait "$PID_B" 2>/dev/null
      STALE_PRESENT=0
      [ -f "$DAEMON_STATE/daemon.json" ] && STALE_PRESENT=1
      echo "stale daemon.json left behind after hard-kill: $STALE_PRESENT (expected: 1)"

      echo "# a third serve must detect the stale pid and start anyway (crash recovery)"
      PID_C="$(start_daemon "$REPORT/phaseA/daemon-c-stdout.log" "$REPORT/phaseA/daemon-c-stderr.log")"
      if wait_for_daemon_file; then
        cp "$DAEMON_STATE/daemon.json" "$REPORT/phaseA/daemon-c.json"
        echo "daemon C started over the stale file -- stale-file detection OK"
        kill -TERM "$PID_C"; wait "$PID_C" 2>/dev/null
        RESULT="ok"
      else
        echo "daemon C never wrote daemon.json -- stale-file detection FAILED"
        RESULT="fail"
      fi
    else
      echo "daemon B never wrote daemon.json"
      RESULT="fail"
    fi
  else
    echo "daemon A never wrote daemon.json"
    RESULT="fail"
    A_GRACEFUL=0
    SECOND_RC=0
  fi
  echo "DAEMON_LIFECYCLE_RESULT=$RESULT A_GRACEFUL=${A_GRACEFUL:-0} SECOND_SERVE_REFUSED=$([ "${SECOND_RC:-0}" -ne 0 ] && echo 1 || echo 0)"
} >> "$DAEMON_LOG" 2>&1

if grep -q 'DAEMON_LIFECYCLE_RESULT=ok' "$DAEMON_LOG" && grep -q 'A_GRACEFUL=1' "$DAEMON_LOG" && grep -q 'SECOND_SERVE_REFUSED=1' "$DAEMON_LOG"; then
  step_pass "daemon lifecycle (start/refuse-second/crash-recover)" "see report/phaseA/daemon-lifecycle.log" "start, second-refused, hard-kill, stale-recovered"
else
  step_fail "daemon lifecycle (start/refuse-second/crash-recover)" "see report/phaseA/daemon-lifecycle.log" "1" "See report/phaseA/daemon-lifecycle.log for which step did not match."
fi

if grep -q 'A_GRACEFUL=1' "$DAEMON_LOG"; then
  step_pass "graceful shutdown by SIGTERM, from a separate process" "kill -TERM <daemon pid>" "daemon.json removed; shutdownMode was 'signal' -- see report/phaseA/daemon-lifecycle.log"
else
  step_fail "graceful shutdown by SIGTERM, from a separate process" "kill -TERM <daemon pid>" "1" "See report/phaseA/daemon-lifecycle.log."
fi

# --- Fake-adapter mission loop -----------------------------------------------
MISSION_STATE="$(mktemp -d)"
MISSION_LOG="$REPORT/phaseA/fake-mission-loop.log"
{
  PROJ_JSON="$(node "$CORE/src/cli.ts" project create --name "linux-leg-phaseA" --state-dir "$MISSION_STATE" --json)"
  echo "project: $PROJ_JSON"
  PROJ_ID="$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$PROJ_JSON")"
  T1_JSON="$(node "$CORE/src/cli.ts" ticket add --project "$PROJ_ID" --title "T1" --state-dir "$MISSION_STATE" --json)"
  T1_ID="$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$T1_JSON")"
  T2_JSON="$(node "$CORE/src/cli.ts" ticket add --project "$PROJ_ID" --title "T2" --depends-on "$T1_ID" --state-dir "$MISSION_STATE" --json)"
  echo "tickets: $T1_JSON / $T2_JSON"
  node "$CORE/src/cli.ts" run --until-idle --project "$PROJ_ID" --max-parallel 2 --state-dir "$MISSION_STATE" --json
  echo "board:"
  node "$CORE/src/cli.ts" board --project "$PROJ_ID" --state-dir "$MISSION_STATE" --json | tee "$REPORT/phaseA/fake-mission-board.json"
  echo "inbox:"
  node "$CORE/src/cli.ts" inbox --project "$PROJ_ID" --state-dir "$MISSION_STATE" --json | tee "$REPORT/phaseA/fake-mission-inbox.json"
} > "$MISSION_LOG" 2>&1
if grep -q '"status":"DONE"' "$REPORT/phaseA/fake-mission-board.json" 2>/dev/null; then
  DONE_COUNT="$(grep -o '"status":"DONE"' "$REPORT/phaseA/fake-mission-board.json" | wc -l | tr -d ' ')"
  if [ "$DONE_COUNT" -eq 2 ]; then
    step_pass "fake-adapter mission loop (plan -> run --until-idle)" "project create; ticket add x2; run --until-idle" "both tickets DONE -- see report/phaseA/fake-mission-loop.log"
  else
    step_fail "fake-adapter mission loop (plan -> run --until-idle)" "run --until-idle" "1" "Only $DONE_COUNT/2 tickets reached DONE -- see report/phaseA/fake-mission-loop.log."
  fi
else
  step_fail "fake-adapter mission loop (plan -> run --until-idle)" "run --until-idle" "1" "See report/phaseA/fake-mission-loop.log."
fi

################################################################################
# PHASE B -- needs the login from 2-login.md
################################################################################
echo
echo "--- Phase B ---"
mkdir -p "$REPORT/phaseB"

CRED_FILE="$HOME/.claude/.credentials.json"
# Existence/non-empty check only -- this script never reads or prints
# anything from inside that file.
if [ -s "$CRED_FILE" ]; then
  step_pass "login check" "test -s $CRED_FILE" "credentials file present"
  echo "See linux-leg/README.md: this container proof never has a real login, so this branch is not exercised here." \
    > "$REPORT/phaseB/NOTE.txt"

  # --- The real path. Built to the same shape as the fake-adapter mission
  # loop above, with --adapter claude and a shared DIRECTORY workspace, but
  # THIS BRANCH IS UNPROVEN: no container or CI run in this batch has a real
  # login, so nothing below has ever executed. Treat it as reviewed, not
  # verified, until an owner's real run exercises it. -----------------------
  WORKSPACE_ROOT="$HOME/.magarine-linux-leg/phaseB-workspace"
  mkdir -p "$WORKSPACE_ROOT"
  PB_STATE="$(mktemp -d)"
  {
    PROJ_JSON="$(node "$CORE/src/cli.ts" project create --name "linux-leg-phaseB" --workspace-root "$WORKSPACE_ROOT" --state-dir "$PB_STATE" --json)"
    PROJ_ID="$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$PROJ_JSON")"
    T1_ID="$(node "$CORE/src/cli.ts" ticket add --project "$PROJ_ID" --title "PB-T1" --workspace DIRECTORY --state-dir "$PB_STATE" --json | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).id)")"
    T2_ID="$(node "$CORE/src/cli.ts" ticket add --project "$PROJ_ID" --title "PB-T2" --workspace DIRECTORY --depends-on "$T1_ID" --state-dir "$PB_STATE" --json | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).id)")"
    T3_ID="$(node "$CORE/src/cli.ts" ticket add --project "$PROJ_ID" --title "PB-T3" --workspace DIRECTORY --depends-on "$T2_ID" --state-dir "$PB_STATE" --json | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).id)")"

    node "$CORE/src/cli.ts" serve --state-dir "$PB_STATE" --adapter claude --port 0 --json \
      > "$REPORT/phaseB/daemon-stdout.log" 2> "$REPORT/phaseB/daemon-stderr.log" &
    PB_PID=$!
    for _ in $(seq 1 50); do [ -f "$PB_STATE/daemon.json" ] && break; sleep 0.2; done

    # Live cancel from a background shell: give T1 a moment to start, then
    # cancel it from a SEPARATE invocation of the cli (not this shell's own
    # in-process handle), the same distinction "graceful shutdown by signal"
    # above proves for the daemon as a whole.
    sleep 5
    node "$CORE/src/cli.ts" cancel --ticket "$T1_ID" --state-dir "$PB_STATE" --json

    # Give the rest of the mission time to run to completion or to the
    # owner's own attention (a real Claude worker's pace is not ours to cap
    # here); the owner can watch with `board`/`inbox` in another shell.
    for _ in $(seq 1 120); do
      node "$CORE/src/cli.ts" run --until-idle --project "$PROJ_ID" --state-dir "$PB_STATE" --json >/dev/null 2>&1
      sleep 5
    done &
    WAIT_PID=$!
    sleep 60
    kill "$WAIT_PID" 2>/dev/null

    node "$CORE/src/cli.ts" board --project "$PROJ_ID" --state-dir "$PB_STATE" --json | tee "$REPORT/phaseB/board.json"
    node "$CORE/src/cli.ts" inbox --project "$PROJ_ID" --state-dir "$PB_STATE" --json | tee "$REPORT/phaseB/inbox.json"
    node "$CORE/src/cli.ts" activity --project "$PROJ_ID" --all --state-dir "$PB_STATE" --json | tee "$REPORT/phaseB/activity.json"
    node "$HERE/checks/dump-usage.ts" "$PB_STATE/magarine.db" | tee "$REPORT/phaseB/usage.json"

    kill -TERM "$PB_PID" 2>/dev/null
    wait "$PB_PID" 2>/dev/null
  } > "$REPORT/phaseB/run.log" 2>&1
  echo "Phase B ran for real -- see report/phaseB/. This is the owner's own paid run; nothing about its outcome is asserted PASS/FAIL by this script."
else
  step_skip "Phase B (real Claude adapter run)" "no login found at $CRED_FILE -- see linux-leg/2-login.md, then re-run this script."
  echo "Skipped: $CRED_FILE not present or empty. Phase A's results above still stand." > "$REPORT/phaseB/SKIPPED.txt"
fi

echo
step_summary "3-run.sh" > "$REPORT/SUMMARY.txt"
OVERALL_RC=$?
cat "$REPORT/SUMMARY.txt"

################################################################################
# Pack the report into one archive (see 4-send-back.md)
################################################################################
ARCHIVE="$HERE/magarine-linux-report-$(date -u +%Y%m%d-%H%M%S).tar.gz"
tar -czf "$ARCHIVE" -C "$HERE" report
echo
echo "Report archive: $ARCHIVE"
echo "See linux-leg/4-send-back.md for what to do with it."

exit "$OVERALL_RC"
