#!/usr/bin/env bash
# Start xfarm. Runs install-only preflight checks (bun, Playwright Chromium,
# terminal-notifier), then opens the TUI. Per-user config (cookies, LLM,
# burner account) is now done inside the app on the Config tab.
# Usage: ./start.sh
#
# After the TUI exits, closes our Terminal.app window so launches via
# /Applications/XFarm don't leave the user staring at "[Process completed]".
# No-op outside Terminal.app (iTerm / tmux / ssh / plain ./start.sh from a
# non-Terminal shell). dev.sh skips this on purpose.

set -euo pipefail
cd "$(dirname "$0")"

./scripts/preflight.sh

close_terminal_window() {
  local tty_path
  tty_path="$(tty 2>/dev/null || true)"
  [ -n "$tty_path" ] || return 0
  # Delay + background so the shell has fully exited by the time the close
  # fires — avoids Terminal's "Terminate this process?" prompt.
  (sleep 0.2 && osascript -e "tell application \"Terminal\" to close (every window whose tty is \"$tty_path\")" >/dev/null 2>&1) &
  disown
}
trap close_terminal_window EXIT

bun run src/cli.ts watch
