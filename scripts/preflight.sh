#!/usr/bin/env bash
# Preflight: install-only checks. Run from start.sh / dev.sh before launching
# the TUI. Per-user configuration (cookies, LLM creds, model picks) now lives
# in the in-app Config tab — we only verify that the binaries the TUI needs
# are actually on the box.
#
# Each check: detect → prompt to install → retry once. Non-interactive
# environments (no TTY) fall through with a warning instead of hanging.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ -t 1 ]; then
  G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[2m'; X=$'\033[0m'
else
  G=""; Y=""; R=""; D=""; X=""
fi
say()  { printf "%s>%s %s\n" "$G" "$X" "$*"; }
warn() { printf "%s!%s %s\n" "$Y" "$X" "$*"; }
err()  { printf "%sx%s %s\n" "$R" "$X" "$*" >&2; }

# Yes/no prompt. Default Y on Enter; non-TTY → assume yes (CI-friendly).
ask_yes() {
  local prompt="$1"
  if [ ! -t 0 ]; then return 0; fi
  read -r -p "  $prompt [Y/n]: " ans
  [ "${ans:-Y}" != "n" ] && [ "${ans:-Y}" != "N" ]
}

# ---- 1. bun ----
# PATH-only detection misses installs where the current shell hasn't sourced
# the rc file that adds bun to PATH yet. Probe the common install locations
# directly before declaring it missing.
ensure_bun() {
  command -v bun >/dev/null 2>&1 && return 0
  for dir in "$HOME/.bun/bin" "/opt/homebrew/bin" "/usr/local/bin"; do
    if [ -x "$dir/bun" ]; then
      export PATH="$dir:$PATH"
      return 0
    fi
  done
  return 1
}

if ! ensure_bun; then
  warn "bun not found."
  if ask_yes "Install Bun now (curl https://bun.sh/install | bash)?"; then
    curl -fsSL https://bun.sh/install | bash
  fi
  if ! ensure_bun; then
    err "bun still missing. Open a new shell or add ~/.bun/bin to PATH."
    exit 1
  fi
fi

# ---- 2. JS deps ----
# Run unconditionally — a presence check on node_modules/ misses lockfile
# bumps where deps changed but the directory already exists. bun install
# is a near-noop when bun.lock already matches.
say "Syncing JS deps (bun install)..."
(cd "$REPO_ROOT" && bun install --silent)
(cd "$REPO_ROOT" && bun pm trust @google/genai protobufjs >/dev/null 2>&1 || true)

# ---- 3. Playwright Chromium ----
# Ask Playwright itself what builds it expects, then verify each install
# location exists. A presence check on ~/Library/Caches/ms-playwright misses
# version drift — a stale chromium-1217 dir looks "installed" even when the
# current Playwright wants chromium-1223.
pw_missing=0
while IFS= read -r path; do
  [ -z "$path" ] && continue
  [ -d "$path" ] || pw_missing=1
done < <(cd "$REPO_ROOT" && bunx playwright install --dry-run chromium 2>/dev/null | awk '/Install location:/ {print $3}')

if [ "$pw_missing" = "1" ]; then
  warn "Playwright Chromium missing or stale."
  if ask_yes "Install Chromium for Playwright (~170MB, one-time per version)?"; then
    (cd "$REPO_ROOT" && bunx playwright install chromium)
  else
    warn "Skipping. The scraper will fail until you run: bunx playwright install chromium"
  fi
fi

# ---- 4. terminal-notifier (macOS, optional) ----
if [ "$(uname)" = "Darwin" ] && ! command -v terminal-notifier >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    if ask_yes "Install terminal-notifier for nicer macOS notifications (brew)?"; then
      brew install terminal-notifier || warn "brew install failed — notifier will fall back to osascript."
    fi
  else
    printf "%s  (note: install terminal-notifier via Homebrew for click-to-open notifications)%s\n" "$D" "$X"
  fi
fi
