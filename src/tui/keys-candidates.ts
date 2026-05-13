import { spawn } from "node:child_process";
import { ESC } from "./ansi.ts";
import type { TuiHost } from "./types.ts";

export function handleCandidatesKey(host: TuiHost, key: string): void {
  const combined = [...host.candidates, ...host.nonCandidates];
  if (combined.length === 0) return;
  if (key === "j" || key === `${ESC}B` || key === "\x1b[B") {
    host.selected = Math.min(host.selected + 1, combined.length - 1);
  } else if (key === "k" || key === `${ESC}A` || key === "\x1b[A") {
    host.selected = Math.max(host.selected - 1, 0);
  } else if (key === "o") {
    const r = combined[host.selected];
    if (r) {
      spawn("open", [r.url], { stdio: "ignore", detached: true }).unref();
      host.flash(`opened ${r.url}`);
    }
  } else if (key === "\r" || key === "\n" || key === " ") {
    const r = combined[host.selected];
    if (r) {
      host.detailRow = r;
      host.tweetDetailCursor = 0;
      host.draw();
      return;
    }
  } else if (key === "s") {
    const r = combined[host.selected];
    if (r) {
      host.db.markSeen(r.id);
      host.refresh();
      host.flash(`marked seen: @${r.author}`);
    }
  } else if (key === "r") {
    const r = combined[host.selected];
    if (r) {
      host.db.markReplied(r.id);
      host.refresh();
      host.flash(`marked replied: @${r.author}`);
    }
  } else if (key === "C") {
    const n = host.db.clearLowEngagementOldTweets(3600);
    host.refresh();
    host.flash(`cleared ${n} tweets (0 likes, >1h old)`, 4000);
  }
  host.draw();
}
