#!/usr/bin/env bash
# Dev mode: watch src/ for changes and restart the TUI on save.
#
# Uses src/dev-watch.ts (a static-import entry) instead of going through
# src/cli.ts so `bun --watch` sees the full import graph from startup —
# dynamic imports in cli.ts make watch miss some edits otherwise.
#
# The background daemon (spawned on first launch) is NOT hot-reloaded —
# its browser state is expensive to rebuild. Use the Debug page's `R`
# to reload the daemon when its code changes (or let the Claude Stop
# hook do it for you).
set -euo pipefail
cd "$(dirname "$0")"
./scripts/preflight.sh
exec bun --watch run src/dev-watch.ts
