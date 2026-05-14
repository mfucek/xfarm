import { TUI } from "../tui.ts";
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
  }

  const versionPoll = startVersionCheckPoll((info) => {
    const had = tui.updateAvailable;
    if (info) {
      tui.updateAvailable = info;
      tui.draw();
    } else if (had) {
      tui.updateAvailable = null;
      tui.bannerSelected = false;
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
