import { spawn } from "node:child_process";
import { stdout } from "node:process";
import {
  isActivate,
  isChar,
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
  hideAndAdvance,
  isSelectable,
  openTweet,
  type TweetDetailItem,
} from "./tweet-detail-items.ts";
import { runRefineReplyIdea } from "./refine-reply.ts";
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

  // x — hide the current row from the list (sets hidden_at, does not delete)
  // and jump to the next candidate. Always available, regardless of where the
  // inner cursor is.
  if (isChar("x")(key)) {
    hideAndAdvance(host, r);
    return;
  }

  // o — open the tweet in the default browser without having to move the
  // cursor onto the "open tweet" action row.
  if (isChar("o")(key)) {
    openTweet(host, r);
    host.draw();
    return;
  }

  const cols = stdout.columns || 100;
  const width = Math.max(20, Math.min(100, cols - 4));
  const items = getTweetDetailItems(host, r, width);

  // p — refine the currently-hovered reply-idea bullet. Scoped to a bullet
  // row on purpose: refinement is "about this specific idea" and the hint
  // ("p to refine") only shows up under the selected bullet. No-op
  // anywhere else on the detail page.
  if (isChar("p")(key)) {
    const item = items[host.tweetDetailCursor];
    if (!item || item.kind !== "bullet") return;
    if (host.tweetDetailRefineStatus != null) {
      host.flash("already refining a reply…", 2500);
      return;
    }
    const subjectBullet = item.raw;
    void (async () => {
      const v = await host.promptInput("Refine reply: ");
      if (v == null) return;
      // promptInput trims and returns null for empty input, so v is non-empty
      // here. Don't await — runRefineReplyIdea drives its own redraws.
      void runRefineReplyIdea(host, r, v, subjectBullet);
    })();
    return;
  }

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
    } else if (item.kind === "bullet") {
      copyToClipboard(host, item.raw);
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
