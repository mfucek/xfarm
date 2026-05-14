<p align="center">
  <img src="icon.png" alt="XFarm" width="160" />
</p>

# xfarm

Local CLI that surfaces X reply candidates via headless Chromium + burner cookies + LLM judge. TypeScript + Bun.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/mfucek/xfarm/main/install.sh | bash
```

One-shot installer. Clones the repo into `~/.xfarm/app`, installs Bun + Playwright Chromium + (on macOS) `terminal-notifier`, drops an `xfarm` command into `~/.local/bin`, and builds `/Applications/XFarm.app`. Re-running pulls the latest and rebuilds in place. Set `XFARM_NO_APP=1` to skip the dockable .app.

If `~/.local/bin` isn't on your PATH yet, the installer prints the one line to add to your shell rc.

## Run

```sh
xfarm           # boots the TUI (auto-starts the background daemon)
open -a XFarm   # same, but via the dock icon on macOS
```

The first launch opens the Config tab. Paste your burner X cookies (`auth_token`, `ct0`), pick an LLM (Vertex Gemini or ChatGPT/codex), and fill in the per-provider settings — then press `Tab` to switch to Candidates.

## Update

```sh
curl -fsSL https://raw.githubusercontent.com/mfucek/xfarm/main/install.sh | bash
```

The installer is idempotent — re-run it to pull the latest, refresh dependencies, and rebuild the .app. Equivalent to `git -C ~/.xfarm/app pull && ~/.xfarm/app/scripts/preflight.sh`.

## Develop

Working on xfarm itself? Clone normally and use the dev scripts:

```sh
git clone https://github.com/mfucek/xfarm.git
cd xfarm
./setup.sh    # preflight + optional .app build, against this clone
./dev.sh      # hot-reload TUI on src/ changes
./start.sh    # preflight + TUI (no hot reload)
```

`./start.sh` runs `bun run src/cli.ts watch`. The first launch spawns the background scraper/judge/notifier daemon; subsequent launches reuse it.

### Build the .app against a dev clone

```sh
./scripts/install-app.sh
```

Builds `/Applications/XFarm.app` pointing at the current clone (instead of `~/.xfarm/app`). Useful if you want the dock icon to launch your dev checkout.

- App icon: drop `icon.icns` (preferred) or `icon.png` (1024×1024) at the repo root. PNG is auto-converted via `sips` + `iconutil`.
- First launch: right-click → **Open** in Finder to clear Gatekeeper, then drag the icon to the Dock.
- Repo path is baked into the bundle at install time — re-run after moving the repo.

## Other commands

```sh
xfarm status               # is the daemon running?
xfarm stop                 # stop the background daemon
xfarm session test         # confirm burner cookies work (headless)
xfarm session debug        # open visible browser to inspect
xfarm judge test "..."     # one-off Vertex call
xfarm judge run-pending    # judge any tweets waiting for a score
```

From a dev clone, swap `xfarm` for `bun run src/cli.ts`.
