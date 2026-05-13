#!/usr/bin/env bash
# Stop hook: if daemon source files were modified since the last reload,
# stop the running daemon and spawn a fresh one in the background.
#
# Designed to be a no-op when nothing daemon-relevant changed, so it's safe
# to wire to every Stop event.

set -euo pipefail

# Hooks may run with a minimal PATH — ensure bun is reachable.
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MARKER="$HOME/.xfarm/.last-reload"
LOG_FILE="$HOME/.xfarm/daemon.log"
PID_FILE="$HOME/.xfarm/daemon.pid"

cd "$REPO_ROOT"

# Daemon not running? Nothing to do.
if [ ! -f "$PID_FILE" ] || ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  exit 0
fi

# Files that, when modified, require a daemon restart. The TUI hot-reloads
# itself via `bun --watch`, so tui.ts and cli.ts are deliberately omitted.
DAEMON_FILES=(
  src/daemon.ts
  src/lifecycle.ts
  src/config.ts
  src/db.ts
  src/judge.ts
  src/notifier.ts
  src/types.ts
  src/scraper/account-scan.ts
  src/scraper/browser.ts
  src/scraper/keyword-scan.ts
  src/scraper/parse.ts
  src/scraper/rate-limit.ts
  src/scraper/velocity-tracker.ts
  prompts/judge.md
  .env
)

stat_mtime() {
  # macOS uses -f, Linux uses -c. Try both.
  stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0
}

newest=0
for f in "${DAEMON_FILES[@]}"; do
  if [ -e "$REPO_ROOT/$f" ]; then
    m=$(stat_mtime "$REPO_ROOT/$f")
    [ "$m" -gt "$newest" ] && newest=$m
  fi
done

last_reload=0
if [ -e "$MARKER" ]; then
  last_reload=$(stat_mtime "$MARKER")
elif [ -e "$PID_FILE" ]; then
  # First run since daemon started — treat daemon's start time as the baseline.
  last_reload=$(stat_mtime "$PID_FILE")
fi

if [ "$newest" -le "$last_reload" ]; then
  # Nothing daemon-relevant changed since the last reload.
  exit 0
fi

old_pid=$(cat "$PID_FILE")
echo "[xfarm-hook] daemon code changed — reloading (was PID $old_pid)"

# Stop the running daemon. The CLI's `stop` command sends SIGTERM and waits
# up to 5s for the PID to disappear.
bun run src/cli.ts stop >/dev/null 2>&1 || true

# Spawn a fresh detached daemon, logs appended to the same file.
mkdir -p "$(dirname "$LOG_FILE")"
nohup bun run src/cli.ts daemon >>"$LOG_FILE" 2>&1 &
disown

# Brief wait so the new daemon writes its PID before we bow out.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 0.3
  if [ -f "$PID_FILE" ]; then
    new_pid=$(cat "$PID_FILE")
    if [ "$new_pid" != "$old_pid" ] && kill -0 "$new_pid" 2>/dev/null; then
      echo "[xfarm-hook] daemon reloaded (now PID $new_pid)"
      break
    fi
  fi
done

# Touch the marker so we don't reload again until something else changes.
mkdir -p "$(dirname "$MARKER")"
touch "$MARKER"
