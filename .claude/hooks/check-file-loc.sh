#!/usr/bin/env bash
# PostToolUse hook: after Write/Edit, if the edited source file exceeds the
# LoC threshold, emit an additionalContext reminder telling the agent to
# split it. Output is consumed by Claude via stdout JSON.

set -euo pipefail

THRESHOLD=500

# Read the tool input JSON from stdin and pull out the file path.
input="$(cat)"
file_path="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')"

# Nothing to do if no path or file vanished between edit and hook.
[ -n "$file_path" ] || exit 0
[ -f "$file_path" ] || exit 0

# Only check actual source files. Markdown / yaml / json regularly exceed
# 500 lines without being a refactor signal.
case "$file_path" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.py|*.go|*.rs|*.java|*.kt|*.swift|*.rb|*.php|*.c|*.cc|*.cpp|*.h|*.hpp) ;;
  *) exit 0 ;;
esac

lines="$(wc -l < "$file_path" | tr -d '[:space:]')"

if [ "$lines" -gt "$THRESHOLD" ]; then
  jq -nc \
    --arg f "$file_path" \
    --argjson n "$lines" \
    --argjson t "$THRESHOLD" \
    '{
       hookSpecificOutput: {
         hookEventName: "PostToolUse",
         additionalContext: ("⚠️  " + $f + " is now " + ($n|tostring) +
           " lines (threshold: " + ($t|tostring) + "). Per .claude/CLAUDE.md, " +
           "refactor this file into smaller, focused modules before considering " +
           "the task complete. Do not skip this — split by responsibility " +
           "(rendering vs. state vs. I/O, or per-entity for repositories).")
       }
     }'
fi
