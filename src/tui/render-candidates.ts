import { scrollAnchored } from "./scroll-view.ts";
import {
  BOLD,
  DIM,
  FG_CYAN,
  FG_GREEN,
  FG_RED,
  FG_YELLOW,
  RESET,
  REVERSE,
  ageStr,
  likesPerHour,
  padRight,
  truncVisible,
} from "./ansi.ts";
import type { TweetRow } from "../types.ts";
import type { RenderCtx, TuiHost } from "./types.ts";
import { clampToStop } from "./items.ts";
import { assignGroups, computeCursorStops } from "./list-rail.ts";
import {
  getTweetDetailItems,
  isSelectable,
  renderTweetDetailItem,
} from "./tweet-detail-items.ts";

export function renderCandidates(
  cols: number,
  bodyRows: number,
  ctx: RenderCtx,
): string {
  const COL_AGE = 6;
  const COL_AUTHOR = 20;
  const COL_SCORE = 6;
  const COL_VEL = 7;
  const COL_LIKES = 7;
  const COL_REPL = 6;
  const COL_FIXED =
    COL_AGE + 1 + COL_AUTHOR + 1 + COL_SCORE + 1 + COL_VEL + 1 +
    COL_LIKES + 1 + COL_REPL + 1;
  const COL_TEXT = Math.max(20, cols - COL_FIXED);

  const lines: string[] = [];
  lines.push(
    DIM +
      padRight("age", COL_AGE) +
      " " +
      padRight("author", COL_AUTHOR) +
      " " +
      padRight("score", COL_SCORE) +
      " " +
      padRight("l/hr", COL_VEL) +
      " " +
      padRight("likes", COL_LIKES) +
      " " +
      padRight("repl", COL_REPL) +
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

  const gate = ctx.cfg.gate;
  // l/hr is a likes-per-hour lifetime average; the gate's min_velocity is in
  // likes/min, so scale by 60 for an apples-to-apples comparison.
  const minLikesPerHour = gate.min_velocity * 60;

  const pushRow = (r: TweetRow, globalIdx: number): void => {
    const isSel = globalIdx === ctx.selected;
    const isSeen = r.seen_at != null;
    const score = r.llm_score == null ? "—" : r.llm_score.toFixed(1);
    const scoreHot = (r.llm_score ?? 0) >= ctx.cfg.judge.notify_threshold;
    const lphRaw = likesPerHour(r.likes, r.created_at);
    const velocity = lphRaw.toFixed(1);
    const likes = r.likes ?? 0;
    const replies = r.replies ?? 0;

    const prefix = (isSel ? REVERSE : "") + (isSeen ? DIM : "");
    const suffix = isSel || isSeen ? RESET : "";
    // Re-apply REVERSE after the inner RESET so the row's selection highlight
    // continues past the colored span; on seen rows we skip color entirely so
    // the whole row reads as dim.
    const colorize = (s: string, color: string): string =>
      isSeen ? s : `${color}${s}${RESET}${isSel ? REVERSE : ""}`;

    // Hot-yellow score and red gate-fail cells only apply to unseen rows.
    const scoreCell =
      scoreHot && !isSeen
        ? `${FG_YELLOW}${BOLD}${score}${RESET}${isSel ? REVERSE : ""}`
        : score;
    const authorCell = colorize(`@${r.author}`, FG_CYAN);
    const velFail = lphRaw < minLikesPerHour;
    const likesFail = likes < gate.min_likes_absolute;
    const repliesFail = replies < gate.min_replies || replies > gate.max_replies;
    const velCell = velFail ? colorize(velocity, FG_RED) : velocity;
    const likesCell = likesFail ? colorize(String(likes), FG_RED) : String(likes);
    const repliesCell = repliesFail
      ? colorize(String(replies), FG_RED)
      : String(replies);

    lines.push(
      prefix +
        padRight(ageStr(r.created_at), COL_AGE) +
        " " +
        padRight(authorCell, COL_AUTHOR) +
        " " +
        padRight(scoreCell, COL_SCORE) +
        " " +
        padRight(velCell, COL_VEL) +
        " " +
        padRight(likesCell, COL_LIKES) +
        " " +
        padRight(repliesCell, COL_REPL) +
        " " +
        truncVisible(r.text, COL_TEXT) +
        suffix,
    );

    if (r.llm_angle) {
      const indent = " ".repeat(COL_FIXED);
      const anglePrefix = (isSel ? REVERSE : "") + (isSeen ? DIM : "");
      const angleColor = isSeen ? "" : FG_GREEN;
      lines.push(
        anglePrefix +
          indent +
          angleColor +
          "└ " +
          truncVisible(r.llm_angle, COL_TEXT - 2) +
          RESET,
      );
    }
  };

  // Variable-height windowing centered on the selection. Each row is 1 line
  // or 2 lines (when llm_angle is set), so we sum actual heights instead of
  // picking a fixed item count — otherwise the total list height jitters as
  // the user scrolls past 2-line rows and the budget either overflows the
  // terminal or leaves dead space at the bottom.
  //
  // In-body chrome: column header at top + summary line at bottom (when
  // windowed). We always reserve the summary slot; if the window fits all
  // items we just leave the row unused.
  const bodyChrome = 2;
  const itemAvail = Math.max(2, bodyRows - bodyChrome);

  const sel = Math.max(0, Math.min(ctx.selected, total - 1));
  const itemAt = (i: number): TweetRow =>
    i < candCount ? ctx.candidates[i]! : ctx.nonCandidates[i - candCount]!;
  const rowH = (i: number): number => (itemAt(i).llm_angle ? 2 : 1);
  // Effective height of a [s, e) window includes the 3-line divider when the
  // window straddles the candidate / non-candidate boundary, matching what
  // the loop below actually emits.
  const effectiveHeight = (s: number, e: number): number => {
    let h = 0;
    for (let i = s; i < e; i++) {
      if (i === candCount && i > s) h += 3;
      h += rowH(i);
    }
    return h;
  };

  let start = sel;
  let end = sel + 1;
  // Grow outward from the selection, alternating sides to keep it centered.
  // If one side hits the boundary we keep growing on the other.
  while (true) {
    const canUp = start > 0;
    const canDown = end < total;
    if (!canUp && !canDown) break;
    const distUp = sel - start;
    const distDown = end - 1 - sel;
    const preferUp = canUp && (!canDown || distUp <= distDown);
    let advanced = false;
    if (preferUp && effectiveHeight(start - 1, end) <= itemAvail) {
      start--;
      advanced = true;
    } else if (!preferUp && canDown && effectiveHeight(start, end + 1) <= itemAvail) {
      end++;
      advanced = true;
    } else if (preferUp && canDown && effectiveHeight(start, end + 1) <= itemAvail) {
      end++;
      advanced = true;
    } else if (!preferUp && canUp && effectiveHeight(start - 1, end) <= itemAvail) {
      start--;
      advanced = true;
    }
    if (!advanced) break;
  }

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

export function renderTweetDetail(
  cols: number,
  bodyRows: number,
  host: TuiHost,
): string {
  const r = host.detailRow;
  if (!r) return "";
  const width = Math.max(20, Math.min(100, cols - 4));
  const items = getTweetDetailItems(host, r, width);

  // Group machinery mirrors Config/Debug — header items start groups; the
  // cursor only stops on selectables (actions, bullets). The rail spans every
  // line of the group containing the cursor, so the post box and stats card
  // light up together when an action in the "actions" group is selected.
  const groupOf = assignGroups(items, (it) => it.kind === "header");
  const stops = computeCursorStops(
    items,
    groupOf,
    (it) => it.kind === "header",
    isSelectable,
    { anchorEmptyGroups: false },
  );
  const cur = clampToStop(stops, host.tweetDetailCursor);
  host.tweetDetailCursor = cur;
  const curGroup = groupOf[cur] ?? -1;

  const out: string[] = [];
  let curStart = 0;
  let curEnd = 0;
  const opts = {
    copiedAt: host.tweetDetailCopiedAt,
    busyAction: host.tweetDetailBusyAction,
    judgeStatus: host.tweetDetailJudgeStatus,
  };
  items.forEach((it, idx) => {
    if (it.kind === "header" && out.length > 0) out.push("");
    const isSel = idx === cur;
    const inSelectedGroup = groupOf[idx] === curGroup;
    if (isSel) curStart = out.length;
    for (const line of renderTweetDetailItem(
      it,
      width,
      isSel,
      inSelectedGroup,
      opts,
    )) {
      out.push(line);
    }
    if (isSel) curEnd = out.length - 1;
  });

  const windowed = scrollAnchored(out, bodyRows, curStart, curEnd);
  return (windowed ?? out).join("\n");
}
