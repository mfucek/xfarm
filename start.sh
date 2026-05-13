#!/usr/bin/env bash
# Start xfarm. Ensures the daemon is running in the background, then opens the TUI.
# Usage: ./start.sh

set -euo pipefail
cd "$(dirname "$0")"

exec bun run src/cli.ts watch
