#!/usr/bin/env bash
# xfarm setup. Configuration moved into the app — this script now just runs
# the install-only preflight (same one start.sh / dev.sh use) and points you
# at the Config tab. Re-runnable; safe to call any time.

set -euo pipefail
cd "$(dirname "$0")"

./scripts/preflight.sh

if [ -t 1 ]; then
  G=$'\033[32m'; B=$'\033[1m'; D=$'\033[2m'; X=$'\033[0m'
else
  G=""; B=""; D=""; X=""
fi

cat <<EOF

${G}Setup complete.${X}

Launch xfarm:
    ${B}./start.sh${X}

The TUI opens on the ${B}Config${X} tab when burner cookies or the LLM
aren't configured yet. From there:
  - paste your burner X handle, auth_token, ct0
  - pick an LLM (gemini for Vertex AI, codex for your ChatGPT subscription)
  - fill in the per-provider settings

Once setup status shows "ready", switch to Candidates with ${D}Tab${X} and
the daemon will autostart on your next launch.

EOF
