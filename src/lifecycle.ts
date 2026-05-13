import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const XFARM_HOME = join(homedir(), ".xfarm");

export const pidFilePath = (): string => join(XFARM_HOME, "daemon.pid");
export const logFilePath = (): string => join(XFARM_HOME, "daemon.log");
const sessionMarkerPath = (): string => join(XFARM_HOME, "tui-session.ppid");

/**
 * True if this is the first TUI launch under the current parent (i.e. not a
 * `bun --watch` hot-reload). Used to gate the daemon auto-start so file saves
 * don't resurrect a daemon the user explicitly stopped. `bun --watch` keeps
 * its own PID across child restarts, so PPID identifies the watch session.
 */
export function isFirstLaunchInSession(): boolean {
  const p = sessionMarkerPath();
  if (!existsSync(p)) return true;
  try {
    return Number(readFileSync(p, "utf-8").trim()) !== process.ppid;
  } catch {
    return true;
  }
}

export function markSessionStarted(): void {
  mkdirSync(XFARM_HOME, { recursive: true });
  writeFileSync(sessionMarkerPath(), String(process.ppid));
}

export function readPid(): number | null {
  const p = pidFilePath();
  if (!existsSync(p)) return null;
  try {
    const n = Number(readFileSync(p, "utf-8").trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function isDaemonRunning(): boolean {
  const pid = readPid();
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function writePid(pid: number): void {
  mkdirSync(XFARM_HOME, { recursive: true });
  writeFileSync(pidFilePath(), String(pid));
}

export function clearPid(): void {
  try {
    unlinkSync(pidFilePath());
  } catch {
    /* already gone */
  }
}

/** Spawn the daemon as a detached background process. Returns its PID. */
export function startDaemonBackground(): number {
  mkdirSync(XFARM_HOME, { recursive: true });
  const fd = openSync(logFilePath(), "a");
  // src/lifecycle.ts -> repo root is one up
  const repoRoot = resolve(import.meta.dir, "..");
  const cliPath = join(repoRoot, "src", "cli.ts");
  const child = spawn("bun", ["run", cliPath, "daemon"], {
    detached: true,
    stdio: ["ignore", fd, fd],
    cwd: repoRoot,
  });
  child.unref();
  if (!child.pid) throw new Error("failed to spawn daemon");
  return child.pid;
}

/** Send SIGTERM to the running daemon. Returns the pid we tried to stop, or null. */
export function stopDaemon(): number | null {
  const pid = readPid();
  if (!pid || !isDaemonRunning()) {
    clearPid();
    return null;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already dead */
  }
  return pid;
}

/** Wait until the daemon process is no longer alive (or timeout). */
export async function waitForDaemonStopped(timeoutMs = 6000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isDaemonRunning()) {
      clearPid();
      return true;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** Wait until the daemon has written its PID file and is alive. */
export async function waitForDaemonRunning(
  timeoutMs = 6000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isDaemonRunning()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
