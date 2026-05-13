#!/usr/bin/env bash
# Start xfarm. Runs install-only preflight checks (bun, Playwright Chromium,
# terminal-notifier), then opens the TUI. Per-user config (cookies, LLM,
# burner account) is now done inside the app on the Config tab.
# Usage: ./start.sh

set -euo pipefail
cd "$(dirname "$0")"

./scripts/preflight.sh

exec bun run src/cli.ts watch
