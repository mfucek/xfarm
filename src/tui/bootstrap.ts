import { ensureConfigFile, loadConfigLoose } from "../config.ts";
import { DB } from "../db.ts";
import {
  isDaemonRunning,
  isFirstLaunchInSession,
  markSessionStarted,
  startDaemonBackground,
} from "../lifecycle.ts";
import { checkSetup } from "../setup-check.ts";
import { DIM, FG_RED, RESET } from "./ansi.ts";

export interface TuiBootstrap {
  db: DB;
  cfg: ReturnType<typeof loadConfigLoose>;
  status: ReturnType<typeof checkSetup>;
}

export function bootstrapTui(): TuiBootstrap {
  // Always seed a config file if missing so the TUI has something to read;
  // loadConfigLoose tolerates missing pieces, so the Config tab can edit
  // its way out of an invalid state.
  ensureConfigFile();
  const cfg = loadConfigLoose();
  const status = checkSetup(cfg);
  const db = new DB(cfg.storage.db_path);
  return { db, cfg, status };
}

export async function maybeStartDaemon(
  status: ReturnType<typeof checkSetup>,
): Promise<void> {
  // Auto-start daemon on first launch in this session ONLY when setup is
  // complete; otherwise the daemon would crash on missing creds/cookies and
  // spam the log. `bun --watch` restarts the TUI on every file save; we
  // don't resurrect a daemon the user explicitly stopped (see dev.sh).
  const firstLaunch = isFirstLaunchInSession();
  markSessionStarted();
  if (firstLaunch && status.ok && !isDaemonRunning()) {
    try {
      const pid = startDaemonBackground();
      process.stderr.write(
        `${DIM}[xfarm] daemon started in background (PID ${pid}, logs at ~/.xfarm/daemon.log)${RESET}\n`,
      );
      await new Promise((r) => setTimeout(r, 800));
    } catch (e) {
      process.stderr.write(
        `${FG_RED}[xfarm] failed to start daemon: ${(e as Error).message}${RESET}\n`,
      );
    }
  }
}

export function startVersionCheckPoll(
  onUpdate: (info: { behind: number } | null) => void,
): { stop: () => void } {
  let id: ReturnType<typeof setInterval> | null = null;
  // Upstream check — runs once at startup and then every minute. Silent on
  // every failure mode (no git, no network, no upstream), so the banner
  // only appears when there really is something to pull.
  const poll = async (): Promise<void> => {
    const { checkForUpdate } = await import("../version-check.ts");
    const info = await checkForUpdate();
    onUpdate(info);
  };
  void poll();
  id = setInterval(() => void poll(), 60_000);
  return {
    stop: () => {
      if (id) clearInterval(id);
    },
  };
}
