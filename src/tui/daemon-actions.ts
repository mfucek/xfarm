import { restartAndWait, startAndWait, stopAndWait } from "../lifecycle.ts";
import type { TuiHost } from "./types.ts";

// Wrap a daemon operation with the standard busy/flash/draw UX. Errors flash
// instead of bubbling so a transient failure doesn't crash the TUI loop.
async function withBusy(
  host: TuiHost,
  spinnerMsg: string,
  body: () => Promise<string>,
): Promise<void> {
  host.busy = true;
  host.flash(spinnerMsg, 10000);
  host.draw();
  try {
    const final = await body();
    host.flash(final, 4000);
  } catch (e) {
    host.flash(`failed: ${(e as Error).message}`, 5000);
  } finally {
    host.busy = false;
    host.refresh();
    host.draw();
  }
}

export function reloadDaemon(host: TuiHost): Promise<void> {
  return withBusy(host, "reloading daemon…", async () => {
    const r = await restartAndWait(8000);
    if (r.state === "stop_timeout") {
      return `daemon ${r.pid} didn't exit in 8s — aborting reload`;
    }
    if (!r.up) {
      return `spawned PID ${r.newPid} but it never wrote a PID file — check the log`;
    }
    return `daemon reloaded (PID ${r.newPid})`;
  });
}

export function stopDaemonAction(host: TuiHost): Promise<void> {
  return withBusy(host, "stopping daemon…", async () => {
    const r = await stopAndWait(8000);
    if (r.state === "not_running") return "daemon was not running";
    if (r.state === "stopped") return `daemon ${r.pid} stopped`;
    return `daemon ${r.pid} unresponsive`;
  });
}

export function startDaemonAction(host: TuiHost): Promise<void> {
  return withBusy(host, "starting daemon…", async () => {
    const r = await startAndWait(8000);
    if (r.state === "already_running") return "daemon is already running";
    if (r.state === "started") return `daemon started (PID ${r.pid})`;
    return `spawned PID ${r.pid} but never wrote a PID file — check the log`;
  });
}
