<p align="center">
  <img src="icon.png" alt="XFarm" width="160" />
</p>

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
./start.sh    # preflight + TUI (auto-starts the background daemon)
./dev.sh      # same, but hot-reloads on src/ changes
```

`start.sh` runs `bun run src/cli.ts watch`. The first launch spawns the background scraper/judge/notifier daemon; subsequent launches reuse it.

## Dockable macOS app

```sh
./install.sh
```

Builds `/Applications/XFarm.app` — a thin bundle that opens a new Terminal window and runs `start.sh`. Re-running replaces the existing install (and cleans up any legacy `start.app` from earlier installs).

- App icon: drop `icon.icns` (preferred) or `icon.png` (1024×1024) at the repo root. PNG is auto-converted via `sips` + `iconutil`.
- First launch: right-click → **Open** in Finder to clear Gatekeeper, then drag the icon to the Dock.
- Repo path is baked into the bundle at install time — re-run `./install.sh` after moving the repo.

## Other commands

```sh
bun run src/cli.ts status             # is the daemon running?
bun run src/cli.ts stop               # stop the background daemon
bun run src/cli.ts session test       # confirm burner cookies work (headless)
bun run src/cli.ts session debug      # open visible browser to inspect
bun run src/cli.ts judge test "..."   # one-off Vertex call
bun run src/cli.ts judge run-pending  # judge any tweets waiting for a score
```
