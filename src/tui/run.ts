import {
  readLastSeenVersion,
  writeLastSeenVersion,
} from "../lifecycle.ts";
import { TUI } from "../tui.ts";
import { getAppVersion } from "../version-check.ts";
import { bootstrapTui, maybeStartDaemon, startVersionCheckPoll } from "./bootstrap.ts";

export async function runTui(): Promise<void> {
  const { db, cfg, status } = bootstrapTui();
  await maybeStartDaemon(status);

  const tui = new TUI(db, cfg);
  tui.setupStatus = status;
  if (!status.ok) {
    tui.page = "config";
    const missing = status.checks.filter((c) => !c.ok).map((c) => c.id).join(", ");
    tui.flash(`setup incomplete (${missing}) — finish here to start scraping`, 8000);
  } else {
    // First TUI launch under a new version (or no marker yet) → drop the user
    // on the About tab so they see the release notes for what just changed.
    // Gated on setup completeness so a brand-new install doesn't bury the
    // setup checklist behind release notes.
    const current = getAppVersion();
    const lastSeen = readLastSeenVersion();
    if (lastSeen !== current) {
      tui.page = "about";
      writeLastSeenVersion(current);
    }
  }

  const versionPoll = startVersionCheckPoll((info) => {
    const had = tui.updateAvailable;
    if (info) {
      tui.updateAvailable = info;
      tui.draw();
      // Silent auto-update: when the toggle is on and no pull is already in
      // flight, fire the pull-and-restart flow without any user interaction.
      // The interactive banner briefly flips to "AUTO-UPDATING…" until the
      // restart kicks in (or the pull fails, in which case we revert).
      if (
        tui.cfg.updater.auto_update &&
        !tui.autoUpdating &&
        !tui.shouldRestart
      ) {
        tui.autoUpdating = true;
        tui.bannerSelected = false;
        tui.draw();
        void (async () => {
          const { runGitPull } = await import("../version-check.ts");
          const r = await runGitPull();
          if (r.ok) {
            tui.requestRestart();
            return;
          }
          tui.autoUpdating = false;
          tui.flash(`auto-update: ${r.message}`, 6000);
          tui.draw();
        })();
      }
    } else if (had) {
      tui.updateAvailable = null;
      tui.bannerSelected = false;
      tui.bannerButton = 0;
      tui.draw();
    }
  });
  try {
    await tui.run();
  } finally {
    versionPoll.stop();
    db.close();
  }

  if (tui.shouldRestart) {
    // After a successful `git pull`, relaunch in the same terminal session:
    // stop the (now stale-code) daemon, then synchronously exec a fresh bun
    // process inheriting our stdio. spawnSync blocks until the new TUI exits,
    // so the user sees one continuous session — no shell prompt in between.
    const { stopAndWait } = await import("../lifecycle.ts");
    const { spawnSync } = await import("node:child_process");
    const { resolve, join } = await import("node:path");
    process.stdout.write("xfarm: pulled new code — restarting…\n");
    await stopAndWait(5000);
    const repoRoot = resolve(import.meta.dir, "..", "..");
    const cliPath = join(repoRoot, "src", "cli.ts");
    const result = spawnSync("bun", ["run", cliPath, "watch"], {
      stdio: "inherit",
      cwd: repoRoot,
    });
    process.exit(result.status ?? 0);
  }
}
