import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import { DEFAULT_CONFIG_PATH } from "../config.ts";
import { logFilePath } from "../lifecycle.ts";
import {
  reloadDaemon,
  startDaemonAction,
  stopDaemonAction,
} from "./daemon-actions.ts";
import {
  isActivate,
  isChar,
  isDown,
  isUp,
  type ParsedKey,
} from "./keys.ts";
import type { DebugAction, DebugItem, TuiHost } from "./types.ts";

export function getDebugItems(host: TuiHost): DebugItem[] {
  return [
    { kind: "section", id: "daemon" },
    { kind: "section", id: "activity" },
    {
      kind: "action",
      label: "restart daemon",
      hint: "stop + start in background",
      run: () => reloadDaemon(host),
    },
    { kind: "action", label: "stop daemon", run: () => stopDaemonAction(host) },
    { kind: "action", label: "start daemon", run: () => startDaemonAction(host) },
    {
      kind: "action",
      label: "clear scrape cooldowns",
      hint: "reset last_scanned_at on every author/keyword/feed",
      run: async () => {
        const n = host.db.clearScanCooldowns();
        host.flash(`cleared cooldowns on ${n} targets`, 4000);
      },
    },
    {
      kind: "action",
      label: "clear suggestions cursor",
      hint: "wipe all chunks + suggestions; suggester re-processes from scratch",
      run: async () => {
        const n = host.db.clearSuggestionsHistory();
        host.flash(`unchunked ${n} tweets; suggester history wiped`, 4000);
      },
    },
    {
      kind: "action",
      label: "open config in default editor",
      hint: DEFAULT_CONFIG_PATH,
      run: async () => {
        spawn("open", [DEFAULT_CONFIG_PATH], {
          stdio: "ignore",
          detached: true,
        }).unref();
        host.flash(`opened ${DEFAULT_CONFIG_PATH}`, 3000);
      },
    },
    {
      kind: "action",
      label: "open burner twitter",
      hint: "non-headless chrome with cookies; runs alongside daemon",
      run: async () => {
        // src/tui/keys-debug.ts -> repo root is two up
        const repoRoot = resolve(import.meta.dir, "..", "..");
        const cliPath = join(repoRoot, "src", "cli.ts");
        spawn("bun", ["run", cliPath, "session", "open"], {
          stdio: "ignore",
          detached: true,
          cwd: repoRoot,
        }).unref();
        host.flash("opened burner twitter window", 3000);
      },
    },
    {
      kind: "action",
      label: "open daemon log",
      hint: logFilePath(),
      run: async () => {
        spawn("open", [logFilePath()], {
          stdio: "ignore",
          detached: true,
        }).unref();
        host.flash(`opened ${logFilePath()}`, 3000);
      },
    },
    { kind: "section", id: "paths" },
    { kind: "section", id: "scheduling" },
    { kind: "section", id: "stats" },
    { kind: "section", id: "recent_log" },
  ];
}

export function handleDebugKey(host: TuiHost, key: ParsedKey): void {
  if (host.busy) return;
  const items = getDebugItems(host);
  if (isDown(key)) {
    host.debugCursor = Math.min(host.debugCursor + 1, items.length - 1);
    host.draw();
    return;
  }
  if (isUp(key)) {
    host.debugCursor = Math.max(0, host.debugCursor - 1);
    host.draw();
    return;
  }
  if (isActivate(key)) {
    const item = items[host.debugCursor];
    if (item && item.kind === "action") void runDebugAction(host, item);
    return;
  }
  // Legacy single-key shortcuts (still work regardless of cursor position).
  if (isChar("R")(key)) void reloadDaemon(host);
  else if (isChar("S")(key)) void stopDaemonAction(host);
  else if (isChar("B")(key)) void startDaemonAction(host);
}

async function runDebugAction(host: TuiHost, action: DebugAction): Promise<void> {
  try {
    await action.run();
  } catch (e) {
    host.flash(`action failed: ${(e as Error).message}`, 5000);
  } finally {
    host.draw();
  }
}
