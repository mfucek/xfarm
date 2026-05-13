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
if ! command -v bun >/dev/null 2>&1; then
  warn "bun not found."
  if ask_yes "Install Bun now (curl https://bun.sh/install | bash)?"; then
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
  fi
  if ! command -v bun >/dev/null 2>&1; then
    err "bun still missing. Open a new shell or add ~/.bun/bin to PATH."
    exit 1
  fi
fi

# ---- 2. node_modules ----
if [ ! -d "$REPO_ROOT/node_modules" ]; then
  say "Installing JS deps (bun install)..."
  (cd "$REPO_ROOT" && bun install --silent)
  (cd "$REPO_ROOT" && bun pm trust @google/genai protobufjs >/dev/null 2>&1 || true)
fi

# ---- 3. Playwright Chromium ----
# Playwright caches Chromium under ~/Library/Caches/ms-playwright on macOS,
# ~/.cache/ms-playwright on Linux. Either being non-empty is good enough.
PW_CACHE_MAC="$HOME/Library/Caches/ms-playwright"
PW_CACHE_LIN="$HOME/.cache/ms-playwright"
if [ ! -d "$PW_CACHE_MAC" ] && [ ! -d "$PW_CACHE_LIN" ]; then
  warn "Playwright Chromium not installed."
  if ask_yes "Install Chromium for Playwright (~100MB, one-time)?"; then
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
