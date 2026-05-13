import { spawn } from "node:child_process";
import { stdout } from "node:process";
import {
  isActivate,
  isClose,
  isDown,
  isLeft,
  isRight,
  isUp,
  type ParsedKey,
} from "./keys.ts";
import { stepSelectable } from "./items.ts";
import {
  getTweetDetailItems,
  isSelectable,
  type TweetDetailItem,
} from "./tweet-detail-items.ts";
import type { TuiHost } from "./types.ts";

export function handleTweetDetailKey(host: TuiHost, key: ParsedKey): void {
  const r = host.detailRow;
  if (!r) return;

  if (key.kind === "ctrl-c") {
    host.requestStop();
    return;
  }
  if (isClose(key)) {
    host.detailRow = null;
    host.draw();
    return;
  }

  // ←/→ or h/l paginates to prev/next row in the candidates list.
  if (isLeft(key)) {
    navigateRow(host, -1);
    return;
  }
  if (isRight(key)) {
    navigateRow(host, 1);
    return;
  }

  const cols = stdout.columns || 100;
  const width = Math.max(20, Math.min(100, cols - 4));
  const items = getTweetDetailItems(host, r, width);

  if (isDown(key)) {
    host.tweetDetailCursor = stepSelectable(
      items,
      host.tweetDetailCursor,
      1,
      isSelectable,
    );
    host.tweetDetailCopiedAt = null;
    host.draw();
    return;
  }
  if (isUp(key)) {
    host.tweetDetailCursor = stepSelectable(
      items,
      host.tweetDetailCursor,
      -1,
      isSelectable,
    );
    host.tweetDetailCopiedAt = null;
    host.draw();
    return;
  }
  if (isActivate(key)) {
    const item = items[host.tweetDetailCursor];
    if (!item) return;
    if (item.kind === "action") {
      void runDetailAction(host, item);
    } else if (item.kind === "bullets") {
      copyToClipboard(host, item.raw.join("\n"));
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
  host.tweetDetailCopiedAt = null;
  host.draw();
}

function copyToClipboard(host: TuiHost, text: string): void {
  try {
    const child = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
    child.stdin.end(text);
    child.on("error", (e) => host.flash(`copy failed: ${e.message}`, 4000));
    child.on("close", (code) => {
      if (code === 0) host.tweetDetailCopiedAt = Date.now();
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
