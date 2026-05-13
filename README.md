# xfarm

Local CLI that surfaces X reply candidates via headless Chromium + burner cookies + LLM judge. TypeScript + Bun.

See `/Users/mfucek/.claude/plans/i-just-want-a-cuddly-manatee.md` for the design.

## Setup

```sh
./setup.sh
```

Idempotent wizard: installs Bun if missing, runs `bun install`, downloads Chromium for Playwright, prompts for your GCP project, walks you through pasting burner cookies, decodes a Vertex service-account b64 blob, and smoke-tests the session.

## Run

```sh
bun run src/cli.ts daemon        # window 1: background scraper + judge + notifier
bun run src/cli.ts watch         # window 2: live candidate TUI
```

## Other commands

```sh
bun run src/cli.ts session test       # confirm burner cookies work (headless)
bun run src/cli.ts session debug      # open visible browser to inspect
bun run src/cli.ts judge test "..."   # one-off Vertex call
bun run src/cli.ts judge run-pending  # judge any tweets waiting for a score
```
