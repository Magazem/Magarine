#!/usr/bin/env bash
# Magarine Linux leg, step 1: install everything the repo needs into your own
# home directory. No `sudo` anywhere in this script except the two lines it
# prints and stops at if a dependency it cannot install itself is missing.
# Nothing here asks a question -- every step prints PASS, FAIL, or SKIP with
# the exact command it ran, the exit code, and one sentence on what to do,
# then either continues or stops. Safe to re-run: an already-installed step
# is reported SKIP, not repeated.
#
# Run it with: bash 1-setup.sh
# (not ./1-setup.sh -- the executable bit does not reliably survive a copy
# from a Windows filesystem or a USB stick onto ext4).

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$HERE/lib/common.sh"

INSTALL_DIR="$HOME/.magarine-linux-leg"
NODE_DIR="$INSTALL_DIR/node"
NPM_GLOBAL_DIR="$INSTALL_DIR/npm-global"
ENV_FILE="$INSTALL_DIR/env.sh"

mkdir -p "$INSTALL_DIR"

echo "Magarine Linux leg -- setup"
echo "Installing into: $INSTALL_DIR (no sudo, nothing outside your home directory)"
echo

# --- Step: a download tool -------------------------------------------------
DOWNLOAD_TOOL=""
if command -v curl >/dev/null 2>&1; then
  DOWNLOAD_TOOL="curl"
  step_pass "download tool" "command -v curl" "found: $(command -v curl)"
elif command -v wget >/dev/null 2>&1; then
  DOWNLOAD_TOOL="wget"
  step_pass "download tool" "command -v wget" "found: $(command -v wget)"
else
  step_fail "download tool" "command -v curl || command -v wget" "1" \
    "Run: sudo apt-get install -y curl -- then re-run this script."
  step_summary "setup"
  exit 1
fi

fetch() { # $1=url $2=outfile
  if [ "$DOWNLOAD_TOOL" = "curl" ]; then
    curl -fsSL -o "$2" "$1"
  else
    wget -q -O "$2" "$1"
  fi
}

# --- Step: TLS trust store ---------------------------------------------------
# A minimal image/install can have curl/wget but no CA bundle at all, which
# fails every https:// fetch below with a certificate error rather than a
# missing-command error -- checked separately so the FAIL line names the
# right package instead of leaving "download tool" looking broken.
if [ -f /etc/ssl/certs/ca-certificates.crt ] || [ -d /etc/ssl/certs ]; then
  step_pass "TLS trust store" "test -f /etc/ssl/certs/ca-certificates.crt" "present"
else
  step_fail "TLS trust store" "test -f /etc/ssl/certs/ca-certificates.crt" "1" \
    "Run: sudo apt-get install -y ca-certificates -- then re-run this script."
  step_summary "setup"
  exit 1
fi

# --- Step: git ---------------------------------------------------------------
# The one dependency this script may need sudo for -- it says so and stops,
# per the design note, rather than trying to install it itself.
if command -v git >/dev/null 2>&1; then
  step_pass "git" "command -v git" "found: $(git --version)"
else
  step_fail "git" "command -v git" "1" \
    "Run: sudo apt-get install -y git -- then re-run this script."
  step_summary "setup"
  exit 1
fi

# --- Step: tar ----------------------------------------------------------------
if command -v tar >/dev/null 2>&1; then
  step_pass "tar" "command -v tar" "found: $(command -v tar)"
else
  step_fail "tar" "command -v tar" "1" \
    "Run: sudo apt-get install -y tar -- then re-run this script."
  step_summary "setup"
  exit 1
fi

# --- Step: Node.js >= 24 ------------------------------------------------------
NEED_NODE_INSTALL=1
if [ -x "$NODE_DIR/bin/node" ]; then
  INSTALLED_MAJOR="$("$NODE_DIR/bin/node" -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
  if [ "${INSTALLED_MAJOR:-0}" -ge 24 ] 2>/dev/null; then
    NEED_NODE_INSTALL=0
    step_skip "Node.js >= 24" "already installed at $NODE_DIR ($("$NODE_DIR/bin/node" --version))"
  fi
fi

if [ "$NEED_NODE_INSTALL" -eq 1 ]; then
  ARCH="$(node_dist_arch)"
  if [ "$ARCH" = "unsupported" ]; then
    step_fail "Node.js >= 24" "uname -m" "1" \
      "This machine's CPU architecture ($(uname -m)) has no known official Node.js tarball for this script; install Node 24+ manually and re-run."
    step_summary "setup"
    exit 1
  fi

  LISTING_URL="https://nodejs.org/dist/latest-v24.x/"
  LISTING_FILE="$(mktemp)"
  if fetch "$LISTING_URL" "$LISTING_FILE" 2>/dev/null && [ -s "$LISTING_FILE" ]; then
    TARBALL_NAME="$(grep -oE "node-v24\.[0-9]+\.[0-9]+-linux-$ARCH\.tar\.gz" "$LISTING_FILE" | head -1)"
  fi
  rm -f "$LISTING_FILE"

  if [ -z "${TARBALL_NAME:-}" ]; then
    step_fail "Node.js >= 24" "fetch $LISTING_URL" "1" \
      "Could not find a Node 24 linux-$ARCH tarball listing -- check internet access and re-run, or install Node 24+ manually."
    step_summary "setup"
    exit 1
  fi

  TARBALL_URL="$LISTING_URL$TARBALL_NAME"
  TARBALL_PATH="$(mktemp -u).tar.gz"
  if fetch "$TARBALL_URL" "$TARBALL_PATH"; then
    mkdir -p "$INSTALL_DIR"
    EXTRACT_TMP="$(mktemp -d)"
    if tar -xzf "$TARBALL_PATH" -C "$EXTRACT_TMP"; then
      rm -rf "$NODE_DIR"
      mv "$EXTRACT_TMP"/node-v24*/ "$NODE_DIR"
      rm -f "$TARBALL_PATH"
      rmdir "$EXTRACT_TMP" 2>/dev/null || true
      step_pass "Node.js >= 24" "fetch $TARBALL_URL && tar -xzf" "installed $("$NODE_DIR/bin/node" --version) at $NODE_DIR"
    else
      step_fail "Node.js >= 24" "tar -xzf $TARBALL_PATH" "$?" \
        "The downloaded Node tarball did not extract cleanly -- delete $INSTALL_DIR and re-run."
      step_summary "setup"
      exit 1
    fi
  else
    step_fail "Node.js >= 24" "fetch $TARBALL_URL" "$?" \
      "Download failed -- check internet access and re-run."
    step_summary "setup"
    exit 1
  fi
fi

export PATH="$NODE_DIR/bin:$PATH"

# --- Step: pnpm via corepack --------------------------------------------------
# COREPACK_ENABLE_DOWNLOAD_PROMPT=0 is what keeps this non-interactive:
# without it, corepack's own first-use confirmation is the one prompt that
# would otherwise fire and hang a script that closed stdin.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
if "$NODE_DIR/bin/corepack" enable --install-directory "$NODE_DIR/bin" >/tmp/corepack-enable.log 2>&1 \
  && "$NODE_DIR/bin/corepack" prepare pnpm@latest --activate >/tmp/corepack-prepare.log 2>&1; then
  PNPM_VERSION="$("$NODE_DIR/bin/pnpm" --version 2>/dev/null || echo unknown)"
  step_pass "pnpm via corepack" "corepack prepare pnpm@latest --activate" "pnpm $PNPM_VERSION"
else
  step_fail "pnpm via corepack" "corepack prepare pnpm@latest --activate" "$?" \
    "See /tmp/corepack-enable.log and /tmp/corepack-prepare.log -- likely a network problem; re-run once resolved."
  step_summary "setup"
  exit 1
fi

# --- Step: Claude Code CLI via npm, user prefix, no sudo ----------------------
mkdir -p "$NPM_GLOBAL_DIR"
"$NODE_DIR/bin/npm" config set prefix "$NPM_GLOBAL_DIR" >/dev/null 2>&1

if [ -x "$NPM_GLOBAL_DIR/bin/claude" ] && "$NPM_GLOBAL_DIR/bin/claude" --version >/dev/null 2>&1; then
  step_skip "Claude Code CLI" "already installed at $NPM_GLOBAL_DIR/bin/claude ($("$NPM_GLOBAL_DIR/bin/claude" --version))"
else
  # No --allow-scripts: proven during this role's own container work that the
  # package's postinstall script can hang for minutes with no visible output
  # and no way to interrupt it non-interactively, which is exactly the kind
  # of failure this script exists to avoid on a one-round-trip machine. npm's
  # default script-allowlist skips that postinstall; `claude --version` and
  # `claude -p` both work fully without it (confirmed against a real
  # download in this role's own container proof) -- see linux-leg/README.md.
  if "$NODE_DIR/bin/npm" install -g @anthropic-ai/claude-code >/tmp/npm-claude-install.log 2>&1; then
    step_pass "Claude Code CLI" "npm install -g @anthropic-ai/claude-code" "installed: $("$NPM_GLOBAL_DIR/bin/claude" --version 2>/dev/null || echo 'installed, version check failed')"
  else
    step_fail "Claude Code CLI" "npm install -g @anthropic-ai/claude-code" "$?" \
      "See /tmp/npm-claude-install.log -- likely a network problem; re-run once resolved."
    step_summary "setup"
    exit 1
  fi
fi

# --- Write the env file every later script sources ---------------------------
cat > "$ENV_FILE" <<EOF
# Generated by 1-setup.sh. Source this before running 3-run.sh, or before
# using node/pnpm/claude by hand: source $ENV_FILE
export PATH="$NODE_DIR/bin:$NPM_GLOBAL_DIR/bin:\$PATH"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
EOF
step_pass "env file" "write $ENV_FILE" "source it before running 3-run.sh"

echo
step_summary "setup"
