#!/usr/bin/env bash
# xfarm setup wizard (Bun + TypeScript + Playwright edition).
# Re-runnable; skips steps already done. Usage: ./setup.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
XFARM_HOME="$HOME/.xfarm"
CONFIG="$XFARM_HOME/config.yaml"
COOKIES="$XFARM_HOME/cookies.json"
SA_FILE="$XFARM_HOME/vertex-sa.json"

# ---- pretty printing ----
if [ -t 1 ]; then
  G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; B=$'\033[1m'; D=$'\033[2m'; X=$'\033[0m'
else
  G=""; Y=""; R=""; B=""; D=""; X=""
fi
say()  { printf "%s>%s %s\n" "$G" "$X" "$*"; }
warn() { printf "%s!%s %s\n" "$Y" "$X" "$*"; }
err()  { printf "%sx%s %s\n" "$R" "$X" "$*" >&2; }
hr()   { printf "%s%s%s\n" "$D" "------------------------------------------------------------" "$X"; }

# ---- 0. ensure we're in the right place ----
if [ ! -f "$REPO_ROOT/package.json" ]; then
  err "Run this from the xfarm repo directory (where package.json lives)."
  exit 1
fi

hr
say "xfarm setup wizard"
hr

# ---- 1. bun ----
if ! command -v bun >/dev/null 2>&1; then
  say "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
  if ! command -v bun >/dev/null 2>&1; then
    err "Bun installed but not on PATH. Open a new terminal and re-run ./setup.sh"
    exit 1
  fi
else
  say "bun already installed: $(bun --version)"
fi

# ---- 2. terminal-notifier (optional but nicer notifications) ----
if ! command -v terminal-notifier >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    say "Installing terminal-notifier..."
    brew install terminal-notifier || warn "brew install terminal-notifier failed; falling back to osascript."
  else
    warn "Homebrew not found. Notifications will use osascript (no click-to-open)."
  fi
else
  say "terminal-notifier already installed."
fi

# ---- 3. JS deps + Chromium ----
say "Installing JS dependencies (bun install)..."
cd "$REPO_ROOT"
bun install --silent

# trust google-genai + protobufjs postinstalls (idempotent)
bun pm trust @google/genai protobufjs >/dev/null 2>&1 || true

if [ ! -d "$HOME/Library/Caches/ms-playwright" ]; then
  say "Installing Chromium for Playwright (one-time, ~100MB)..."
  bunx playwright install chromium
else
  say "Playwright Chromium already installed."
fi

# ---- 4. ~/.xfarm dir ----
mkdir -p "$XFARM_HOME"

# ---- 5. config.yaml ----
if [ -f "$CONFIG" ]; then
  say "Config already exists at $CONFIG (leaving it alone)."
else
  say "Creating $CONFIG from template..."
  cp "$REPO_ROOT/config.example.yaml" "$CONFIG"
  hr
  printf "%sGCP project ID%s for Vertex AI Gemini judge.\n" "$B" "$X"
  printf "  (Vertex AI API must be enabled on the project.)\n"
  read -r -p "  GCP project ID: " gcp_project
  if [ -n "${gcp_project:-}" ]; then
    bun -e "
      import { readFileSync, writeFileSync } from 'fs';
      import yaml from 'js-yaml';
      const p = '$CONFIG';
      const d = yaml.load(readFileSync(p, 'utf-8'));
      d.judge.vertex_project = '$gcp_project';
      writeFileSync(p, yaml.dump(d));
    "
    say "Wrote vertex_project=$gcp_project to $CONFIG"
  else
    warn "Skipped GCP project — edit $CONFIG manually before running daemon."
  fi
fi

# ---- 6. cookies.json ----
if [ -f "$COOKIES" ]; then
  printf "%sBurner cookies already exist%s at $COOKIES.\n" "$Y" "$X"
  read -r -p "  Re-enter cookies? [y/N]: " redo
  if [ "${redo:-N}" != "y" ] && [ "${redo:-N}" != "Y" ]; then
    NEED_COOKIES=0
  else
    NEED_COOKIES=1
  fi
else
  NEED_COOKIES=1
fi

if [ "$NEED_COOKIES" = "1" ]; then
  hr
  cat <<'EOF'
Burner cookies setup

  1. Open a fresh Chrome / Safari profile and register a NEW X (Twitter) account.
     Do NOT use your real account for this. The burner does all scraping;
     your real account only writes manual replies.
  2. Log in at https://x.com on that fresh profile.
  3. Open DevTools (Cmd+Opt+I) -> Application tab -> Cookies -> https://x.com
  4. Find these two cookies and copy their values:
       auth_token   (long string, ~40 chars)
       ct0          (long string, ~160 chars)

EOF
  read -r -p "  Burner X handle (no @): " burner_handle
  read -r -p "  auth_token: " auth_token
  read -r -p "  ct0: " ct0

  burner_handle="$(printf '%s' "$burner_handle" | tr -d '[:space:]')"
  burner_handle="${burner_handle#@}"
  auth_token="$(printf '%s' "$auth_token" | tr -d '[:space:]')"
  ct0="$(printf '%s' "$ct0" | tr -d '[:space:]')"

  bun -e "
    import { writeFileSync, chmodSync } from 'fs';
    const data = { username: '$burner_handle', auth_token: '$auth_token', ct0: '$ct0' };
    writeFileSync('$COOKIES', JSON.stringify(data, null, 2));
    chmodSync('$COOKIES', 0o600);
  "
  say "Wrote $COOKIES (chmod 600)"

  # If the Playwright profile exists from a previous run, nuke it so the new
  # cookies take effect (persistent context can otherwise override injected ones).
  if [ -d "$XFARM_HOME/browser-profile" ]; then
    rm -rf "$XFARM_HOME/browser-profile"
    say "Cleared stale browser profile."
  fi
fi

# ---- 7. Vertex AI auth ----
hr
say "Vertex AI authentication"
ADC_FILE="$HOME/.config/gcloud/application_default_credentials.json"

if [ -f "$SA_FILE" ]; then
  say "Service-account key already at $SA_FILE — using it."
  HAVE_VERTEX_AUTH=1
else
  HAVE_VERTEX_AUTH=0
  PROJECT_HINT="$(bun -e "
    import { readFileSync } from 'fs';
    import yaml from 'js-yaml';
    try { console.log(yaml.load(readFileSync('$CONFIG','utf-8')).judge.vertex_project); }
    catch { console.log('your project'); }
  " 2>/dev/null || echo "your project")"
  cat <<EOF

Choose how to authenticate to Vertex:
  1) Service-account JSON key  (you have a base64 blob from your team)
  2) gcloud login              (your personal Google account, must have Vertex access in $PROJECT_HINT)
  3) Skip for now              (judge won't work until configured)

EOF
  read -r -p "  Choice [1/2/3]: " vertex_choice
  case "${vertex_choice:-1}" in
    1)
      cat <<EOF

You can either:
  - Enter a path to a file containing the base64 string, OR
  - Press enter and paste it inline (must be a single line, no newlines).

If your blob has line breaks, first run:  tr -d '\n' < creds.b64 > creds.oneline.b64

EOF
      read -r -p "  Path to b64 file (or empty to paste): " b64_path
      if [ -n "${b64_path:-}" ]; then
        b64_path="${b64_path/#~/$HOME}"
        if [ ! -f "$b64_path" ]; then
          err "File not found: $b64_path"
        else
          b64_content="$(cat "$b64_path" | tr -d '[:space:]')"
        fi
      else
        printf "  Paste base64 string and press Enter: "
        read -r b64_content
        b64_content="$(printf '%s' "$b64_content" | tr -d '[:space:]')"
      fi
      if [ -n "${b64_content:-}" ]; then
        if bun -e "
          import { writeFileSync, chmodSync } from 'fs';
          const b64 = '$b64_content';
          let raw;
          try { raw = Buffer.from(b64, 'base64'); }
          catch (e) { console.error('base64 decode failed:', e.message); process.exit(1); }
          let data;
          try { data = JSON.parse(raw.toString('utf-8')); }
          catch (e) { console.error('decoded payload is not JSON:', e.message); process.exit(1); }
          if (data.type !== 'service_account') {
            console.error('not a service_account key (got type=' + JSON.stringify(data.type) + ')');
            process.exit(1);
          }
          for (const k of ['project_id', 'client_email', 'private_key']) {
            if (!data[k]) { console.error('missing required field: ' + k); process.exit(1); }
          }
          writeFileSync('$SA_FILE', raw);
          chmodSync('$SA_FILE', 0o600);
          console.log('OK project_id=' + data.project_id + ' client_email=' + data.client_email);
        "; then
          bun -e "
            import { readFileSync, writeFileSync } from 'fs';
            import yaml from 'js-yaml';
            const p = '$CONFIG';
            const d = yaml.load(readFileSync(p, 'utf-8'));
            d.judge.credentials_path = '$SA_FILE';
            writeFileSync(p, yaml.dump(d));
          "
          say "Service-account key saved to $SA_FILE and wired into config."
          HAVE_VERTEX_AUTH=1
        else
          err "Service-account creds rejected — see error above."
        fi
      else
        warn "No base64 provided; skipping Vertex auth."
      fi
      ;;
    2)
      if [ -f "$ADC_FILE" ]; then
        say "ADC already present at $ADC_FILE — using it."
        HAVE_VERTEX_AUTH=1
      elif command -v gcloud >/dev/null 2>&1; then
        gcloud auth application-default login && HAVE_VERTEX_AUTH=1 \
          || warn "gcloud login failed; re-run later: gcloud auth application-default login"
      elif command -v brew >/dev/null 2>&1; then
        read -r -p "  gcloud CLI not installed. Install via Homebrew now? [Y/n]: " ans
        if [ "${ans:-Y}" != "n" ] && [ "${ans:-Y}" != "N" ]; then
          brew install --cask google-cloud-sdk || warn "brew install failed"
          if command -v gcloud >/dev/null 2>&1; then
            gcloud auth application-default login && HAVE_VERTEX_AUTH=1
          fi
        fi
      else
        warn "gcloud not found and no Homebrew. Install from https://cloud.google.com/sdk/docs/install"
      fi
      ;;
    *)
      warn "Skipped Vertex auth. Configure later by editing judge.credentials_path in $CONFIG"
      ;;
  esac
fi

# ---- 8. smoke test ----
hr
say "Testing burner session (launching headless Chromium)..."
if bun run src/cli.ts session test; then
  SESSION_OK=1
else
  SESSION_OK=0
  warn "Session test failed. Try: ./setup.sh and choose 'y' to re-enter cookies,"
  warn "or run: bun run src/cli.ts session debug   (opens a visible browser to inspect)."
fi

# ---- 9. launch instructions ----
hr
if [ "$SESSION_OK" = "1" ]; then
  printf "%sSetup complete.%s\n\n" "$G" "$X"
else
  printf "%sSetup finished with warnings — see above.%s\n\n" "$Y" "$X"
fi
cat <<EOF
To run xfarm, open TWO terminal windows in this directory:

  Window 1 (background scanner):
    bun run src/cli.ts daemon

  Window 2 (live candidate list):
    bun run src/cli.ts watch

Inside 'watch', hotkeys:
    j / k   move selection
    o       open tweet in browser
    s       mark seen
    r       mark replied
    q       quit

Edit config later at:  $CONFIG
Edit judge prompt at:  $REPO_ROOT/prompts/judge.md

EOF
