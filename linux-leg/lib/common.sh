#!/usr/bin/env bash
# Sourced by 1-setup.sh and 3-run.sh. Never `set -e` in a script that sources
# this: a step's own command is expected to fail sometimes (that's what FAIL
# reports), and `-e` would kill the whole script on the first one instead of
# letting it print PASS/FAIL/SKIP and move on or exit deliberately.
set -uo pipefail

STEP_COUNT_PASS=0
STEP_COUNT_FAIL=0
STEP_COUNT_SKIP=0

# $1=step name  $2=exact command as a string  $3=one-line note (version, path, etc.)
step_pass() {
  STEP_COUNT_PASS=$((STEP_COUNT_PASS + 1))
  printf 'PASS  %-45s | cmd: %-55s | %s\n' "$1" "$2" "$3"
}

# $1=step name  $2=exact command as a string  $3=exit code  $4=one sentence on what to do
step_fail() {
  STEP_COUNT_FAIL=$((STEP_COUNT_FAIL + 1))
  printf 'FAIL  %-45s | cmd: %-55s | rc=%s | %s\n' "$1" "$2" "$3" "$4"
}

# $1=step name  $2=one sentence reason
step_skip() {
  STEP_COUNT_SKIP=$((STEP_COUNT_SKIP + 1))
  printf 'SKIP  %-45s | %s\n' "$1" "$2"
}

# Prints the final tally and returns 1 if any step failed (callers use this
# as the script's own exit code so a FAIL anywhere is never silently exit 0).
step_summary() {
  printf '\n%s: %d passed, %d failed, %d skipped\n' "$1" "$STEP_COUNT_PASS" "$STEP_COUNT_FAIL" "$STEP_COUNT_SKIP"
  [ "$STEP_COUNT_FAIL" -eq 0 ]
}

# Maps `uname -m` to the arch segment Node's own dist filenames use.
node_dist_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo "x64" ;;
    aarch64|arm64) echo "arm64" ;;
    *) echo "unsupported" ;;
  esac
}
