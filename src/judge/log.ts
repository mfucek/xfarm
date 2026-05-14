// Dedicated, timestamped log file for the judge. Both the background daemon
// and the TUI's "judge again" action go through here, so the user can
// `tail -f ~/.xfarm/judge.log` from another terminal to watch a run live.
//
// Each line is ISO-8601 with milliseconds + level + message, e.g.
//   [2026-05-14T14:23:01.234Z] [judge:info] tweet=1a2b3c… start @alex
//
// We also mirror to stdout (errors to stderr) so the daemon's stdio capture
// (~/.xfarm/daemon.log) still gets these lines. In the TUI the alt-screen
// redraws every ~100ms so stray writes are immediately overwritten — visually
// invisible, but harmless.

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const JUDGE_LOG_PATH = join(homedir(), ".xfarm", "judge.log");

let warnedAboutWrite = false;

export type LogLevel = "info" | "warn" | "error";

export function logJudge(level: LogLevel, msg: string): void {
  const line = `[${new Date().toISOString()}] [judge:${level}] ${msg}\n`;
  try {
    mkdirSync(dirname(JUDGE_LOG_PATH), { recursive: true });
    appendFileSync(JUDGE_LOG_PATH, line);
  } catch (e) {
    if (!warnedAboutWrite) {
      warnedAboutWrite = true;
      try {
        process.stderr.write(
          `[judge:log] failed to append to ${JUDGE_LOG_PATH}: ${(e as Error).message}\n`,
        );
      } catch {
        /* nothing left to try */
      }
    }
  }
  const stream = level === "error" ? process.stderr : process.stdout;
  try {
    stream.write(line);
  } catch {
    /* ignore — daemon may have closed stdio during shutdown */
  }
}

/** Truncate a string for log lines so a giant prompt/response doesn't blow
 * up the log file. Keeps the head + a tail marker. */
export function logTrunc(s: string, max = 200): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…(${s.length - max} more chars)`;
}
