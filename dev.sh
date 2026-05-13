#!/usr/bin/env bash
# Dev mode: watch src/ for changes and restart the TUI on save.
# The background daemon (spawned by `watch` on first launch) is NOT
# hot-reloaded — its browser state is expensive to rebuild. Use the
# Debug page's `R` to reload the daemon when its code changes.
set -euo pipefail
cd "$(dirname "$0")"
exec bun --watch run src/cli.ts watch
