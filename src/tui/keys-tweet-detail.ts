import { spawn } from "node:child_process";
import { stdout } from "node:process";
import {
  getTweetDetailItems,
  type TweetDetailItem,
} from "./tweet-detail-items.ts";
import type { TuiHost } from "./types.ts";

export function handleTweetDetailKey(host: TuiHost, key: string): void {
  const r = host.detailRow;
  if (!r) return;

  // ctrl-c always quits the TUI
  if (key === "\x03") {
    host.requestStop();
    return;
  }
  // esc or q closes the detail view
  if (key === "\x1b" || key === "q") {
    host.detailRow = null;
    host.draw();
    return;
  }

  // ←/→ paginate to prev/next row in the candidates list
  if (key === "\x1b[D" || key === "h") {
    navigateRow(host, -1);
    return;
  }
  if (key === "\x1b[C" || key === "l") {
    navigateRow(host, 1);
    return;
  }

  const cols = stdout.columns || 100;
  const width = Math.max(20, Math.min(100, cols - 4));
  const items = getTweetDetailItems(host, r, width);

  if (key === "j" || key === "\x1b[B") {
    host.tweetDetailCursor = Math.min(host.tweetDetailCursor + 1, items.length - 1);
    host.draw();
    return;
  }
  if (key === "k" || key === "\x1b[A") {
    host.tweetDetailCursor = Math.max(0, host.tweetDetailCursor - 1);
    host.draw();
    return;
  }
  if (key === "\r" || key === "\n" || key === " ") {
    const item = items[host.tweetDetailCursor];
    if (!item) return;
    if (item.kind === "action") {
      void runDetailAction(host, item);
    } else if (item.kind === "bullets") {
      copyToClipboard(host, item.raw.join("\n"), "reply ideas");
    }
    return;
  }
}

function navigateRow(host: TuiHost, delta: 1 | -1): void {
  const combined = [...host.candidates, ...host.nonCandidates];
  if (combined.length === 0) return;
  const next = host.selected + delta;
  if (next < 0 || next >= combined.length) return;
  host.selected = next;
  host.detailRow = combined[next] ?? null;
  host.tweetDetailCursor = 0;
  host.draw();
}

function copyToClipboard(host: TuiHost, text: string, label: string): void {
  try {
    const child = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
    child.stdin.end(text);
    child.on("error", (e) => host.flash(`copy failed: ${e.message}`, 4000));
    child.on("close", (code) => {
      if (code === 0) host.flash(`copied ${label} to clipboard`);
      else host.flash(`pbcopy exited ${code}`, 4000);
      host.draw();
    });
  } catch (e) {
    host.flash(`copy failed: ${(e as Error).message}`, 4000);
  }
}

async function runDetailAction(
  host: TuiHost,
  item: Extract<TweetDetailItem, { kind: "action" }>,
): Promise<void> {
  try {
    await item.run(host);
  } catch (e) {
    host.flash(`action failed: ${(e as Error).message}`, 5000);
  } finally {
    host.draw();
  }
}
