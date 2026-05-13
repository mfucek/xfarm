import {
  isDaemonRunning,
  startDaemonBackground,
  stopDaemon,
  waitForDaemonRunning,
  waitForDaemonStopped,
} from "../lifecycle.ts";
import type { TuiHost } from "./types.ts";

export async function reloadDaemon(host: TuiHost): Promise<void> {
  host.busy = true;
  host.flash("reloading daemon…", 10000);
  host.draw();
  try {
    const pid = stopDaemon();
    if (pid != null) {
      const stopped = await waitForDaemonStopped(8000);
      if (!stopped) {
        host.flash(`daemon ${pid} didn't exit in 8s — aborting reload`, 5000);
        return;
      }
    }
    const newPid = startDaemonBackground();
    const up = await waitForDaemonRunning(8000);
    if (up) {
      host.flash(`daemon reloaded (PID ${newPid})`, 3000);
    } else {
      host.flash(
        `spawned PID ${newPid} but it never wrote a PID file — check the log`,
        5000,
      );
    }
  } catch (e) {
    host.flash(`reload failed: ${(e as Error).message}`, 5000);
  } finally {
    host.busy = false;
    host.refresh();
    host.draw();
  }
}

export async function stopDaemonAction(host: TuiHost): Promise<void> {
  host.busy = true;
  host.flash("stopping daemon…", 8000);
  host.draw();
  try {
    const pid = stopDaemon();
    if (pid == null) {
      host.flash("daemon was not running", 3000);
      return;
    }
    const stopped = await waitForDaemonStopped(8000);
    host.flash(
      stopped ? `daemon ${pid} stopped` : `daemon ${pid} unresponsive`,
      4000,
    );
  } finally {
    host.busy = false;
    host.refresh();
    host.draw();
  }
}

export async function startDaemonAction(host: TuiHost): Promise<void> {
  if (isDaemonRunning()) {
    host.flash("daemon is already running", 3000);
    return;
  }
  host.busy = true;
  host.flash("starting daemon…", 8000);
  host.draw();
  try {
    const pid = startDaemonBackground();
    const up = await waitForDaemonRunning(8000);
    host.flash(
      up
        ? `daemon started (PID ${pid})`
        : `spawned PID ${pid} but never wrote a PID file — check the log`,
      4000,
    );
  } finally {
    host.busy = false;
    host.refresh();
    host.draw();
  }
}
