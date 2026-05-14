#!/usr/bin/env bash
# xfarm setup. Runs the install-only preflight (same one start.sh / dev.sh
# use), offers to build the dockable .app wrapper, then points you at the
# Config tab. Re-runnable; safe to call any time.

set -euo pipefail
cd "$(dirname "$0")"

./scripts/preflight.sh

if [ -t 1 ]; then
  W=$'\033[97m'; D=$'\033[2m'; G=$'\033[32m'; X=$'\033[0m'
else
  W=""; D=""; G=""; X=""
fi

# Offer to build the dockable .app wrapper. Non-TTY skips silently.
if [ -t 0 ]; then
  read -r -p "  Build dockable .app wrapper (./scripts/install-app.sh)? [Y/n]: " ans
  if [ "${ans:-Y}" != "n" ] && [ "${ans:-Y}" != "N" ]; then
    ./scripts/install-app.sh
  fi
fi

cat <<EOF

${G}Setup complete.${X}

${W}1. Launch xfarm${X}
${D}   ./start.sh${X}

${W}2. Configure in the Config tab${X}
${D}   The TUI opens here when cookies or the LLM aren't set up yet.${X}
${D}   - paste your burner X handle, auth_token, ct0${X}
${D}   - pick an LLM (gemini for Vertex AI, codex for your ChatGPT subscription)${X}
${D}   - fill in the per-provider settings${X}

${W}3. Switch to Candidates${X}
${D}   Press Tab once setup status shows "ready" — the daemon autostarts${X}
${D}   on your next launch.${X}

EOF
