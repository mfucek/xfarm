import { stdout } from "node:process";
import {
  BOLD,
  DIM,
  FG_CYAN,
  FG_GREEN,
  FG_YELLOW,
  RESET,
  REVERSE,
  ageStr,
  padRight,
  truncVisible,
} from "./ansi.ts";
import type { TweetRow } from "../types.ts";
import type { RenderCtx, TuiHost } from "./types.ts";
import { clampToSelectable } from "./items.ts";
import {
  getTweetDetailItems,
  isSelectable,
  renderTweetDetailItem,
} from "./tweet-detail-items.ts";

export function renderCandidates(cols: number, ctx: RenderCtx): string {
  const COL_IDX = 3;
  const COL_AGE = 6;
  const COL_AUTHOR = 20;
  const COL_SCORE = 6;
  const COL_VEL = 7;
  const COL_LIKES = 7;
  const COL_FIXED =
    COL_IDX + 1 + COL_AGE + 1 + COL_AUTHOR + 1 + COL_SCORE + 1 + COL_VEL + 1 + COL_LIKES + 1;
  const COL_TEXT = Math.max(20, cols - COL_FIXED);

  const lines: string[] = [];
  lines.push(
    DIM +
      padRight("#", COL_IDX) +
      " " +
      padRight("age", COL_AGE) +
      " " +
      padRight("author", COL_AUTHOR) +
      " " +
      padRight("score", COL_SCORE) +
      " " +
      padRight("l/min", COL_VEL) +
      " " +
      padRight("likes", COL_LIKES) +
      " text / angle" +
      RESET,
  );

  const candCount = ctx.candidates.length;
  const total = candCount + ctx.nonCandidates.length;
  if (total === 0) {
    lines.push("");
    lines.push(
      DIM +
        "(no candidates yet — daemon is scanning. give it 1-2 minutes.)" +
        RESET,
    );
    return lines.join("\n");
  }

  const pushRow = (r: TweetRow, globalIdx: number): void => {
    const isSel = globalIdx === ctx.selected;
    const score = r.llm_score == null ? "—" : r.llm_score.toFixed(1);
    const scoreHot = (r.llm_score ?? 0) >= ctx.cfg.judge.notify_threshold;
    const scoreCell = scoreHot
      ? `${FG_YELLOW}${BOLD}${score}${RESET}${isSel ? REVERSE : ""}`
      : score;
    const velocity = r.velocity == null ? "—" : r.velocity.toFixed(1);

    const prefix = isSel ? REVERSE : "";
    const suffix = isSel ? RESET : "";
    const authorCell = `${FG_CYAN}@${r.author}${RESET}${isSel ? REVERSE : ""}`;

    lines.push(
      prefix +
        padRight(String(globalIdx), COL_IDX) +
        " " +
        padRight(ageStr(r.created_at), COL_AGE) +
        " " +
        padRight(authorCell, COL_AUTHOR) +
        " " +
        padRight(scoreCell, COL_SCORE) +
        " " +
        padRight(velocity, COL_VEL) +
        " " +
        padRight(String(r.likes ?? 0), COL_LIKES) +
        " " +
        truncVisible(r.text, COL_TEXT) +
        suffix,
    );

    if (r.llm_angle) {
      const indent = " ".repeat(COL_FIXED);
      const anglePrefix = isSel ? REVERSE : "";
      lines.push(
        anglePrefix +
          indent +
          FG_GREEN +
          "└ " +
          truncVisible(r.llm_angle, COL_TEXT - 2) +
          RESET +
          (isSel ? RESET : ""),
      );
    }
  };

  // Row-level windowing centered on the selection. Candidate rows can be 2
  // lines tall when an llm_angle is set, so halve the budget vs. other pages
  // to keep the worst case from overflowing past the terminal height.
  const rows = stdout.rows || 24;
  const dataRows = Math.max(3, Math.floor((rows - 10) / 2));
  const sel = Math.max(0, Math.min(ctx.selected, total - 1));
  let start = Math.max(0, sel - Math.floor(dataRows / 2));
  let end = Math.min(total, start + dataRows);
  start = Math.max(0, end - dataRows);

  for (let i = start; i < end; i++) {
    // Insert the section divider when we cross from candidates into
    // non-candidates inside the visible window.
    if (i === candCount && i > start) {
      lines.push("");
      lines.push(DIM + "─".repeat(cols) + RESET);
      lines.push("");
    }
    const r =
      i < candCount ? ctx.candidates[i]! : ctx.nonCandidates[i - candCount]!;
    pushRow(r, i);
  }

  if (start > 0 || end < total) {
    lines.push(
      DIM +
        `  ${start + 1}-${end} of ${total}` +
        (start > 0 ? `  ↑${start}` : "") +
        (end < total ? `  ↓${total - end}` : "") +
        RESET,
    );
  }

  return lines.join("\n");
}

export function renderTweetDetail(cols: number, host: TuiHost): string {
  const r = host.detailRow;
  if (!r) return "";
  const width = Math.max(20, Math.min(100, cols - 4));
  const items = getTweetDetailItems(host, r, width);

  // Snap onto the nearest actionable row so the cursor is never stuck on a
  // header/meta/text row. Writing back keeps the host cursor in sync so the
  // next j/k advances from the visible position.
  const cur = clampToSelectable(items, host.tweetDetailCursor, isSelectable);
  host.tweetDetailCursor = cur;

  const out: string[] = [];
  const opts = { copiedAt: host.tweetDetailCopiedAt };
  items.forEach((it, idx) => {
    if (it.kind === "header" && out.length > 0) out.push("");
    for (const line of renderTweetDetailItem(it, width, idx === cur, opts)) {
      out.push(line);
    }
  });
  return out.join("\n");
}
