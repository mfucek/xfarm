import { spawn } from "node:child_process";
import { Judge, JUDGE_LOG_PATH } from "../judge/index.ts";
import { isNaumuEnabled, NaumuMcpClient } from "../judge/naumu-mcp.ts";
import {
  BOLD,
  DIM,
  FG_CYAN,
  FG_GREEN,
  FG_RED,
  FG_WHITE,
  FG_YELLOW,
  RESET,
  ageStr,
  likesPerHour,
  parseStringArrayColumn,
  wrapText,
} from "./ansi.ts";
import { renderBox, renderDividedCard } from "./box.ts";
import { renderSpinnerLabel } from "./spinner.ts";
import type { TweetRow } from "../types.ts";
import type { TuiHost } from "./types.ts";

export type TweetDetailItem =
  | { kind: "meta"; lines: string[] }
  | { kind: "header"; label: string; color?: string }
  | { kind: "text"; lines: string[]; bordered?: boolean; color?: string }
  | { kind: "statsCard"; cells: { label: string; value: string }[] }
  | {
      kind: "bullet";
      lines: string[];
      raw: string;
      color?: string;
      copyHint?: string;
    }
  // Placeholder bullet rendered while the `p` refine flow is in flight.
  // Not selectable — j/k navigation skips it.
  | { kind: "pendingBullet"; status: string | null; color?: string }
  | {
      kind: "action";
      label: string;
      hint?: string;
      run: (host: TuiHost) => Promise<void> | void;
    };

/** Rows the cursor should stop on: actionable (action) or
 * activatable-on-Enter (bullet, which copies one reply idea to clipboard).
 * Meta, headers, and plain text are read-only and skipped during j/k
 * navigation. */
export function isSelectable(it: TweetDetailItem): boolean {
  return it.kind === "action" || it.kind === "bullet";
}

export function getTweetDetailItems(
  host: TuiHost,
  r: TweetRow,
  width: number,
): TweetDetailItem[] {
  const items: TweetDetailItem[] = [];

  items.push({ kind: "header", label: "post" });
  items.push({
    kind: "meta",
    lines: [
      `${FG_CYAN}@${r.author}${RESET}` +
        `  ${DIM}${ageStr(r.created_at)} ago${RESET}`,
      `${DIM}${formatSource(r.source)}${RESET}`,
      DIM + r.url + RESET,
    ],
  });
  items.push({
    kind: "text",
    lines: wrapText(r.text, Math.max(10, width - 4)),
    bordered: true,
  });

  // Color-code the stat values with the same rules used by the candidates
  // list (render-candidates.ts): hot score (>= notify_threshold) goes
  // yellow+bold, and any cell that fails its gate threshold goes red.
  const gate = host.cfg.gate;
  const minLikesPerHour = gate.min_velocity * 60;
  const score = r.llm_score == null ? "—" : r.llm_score.toFixed(1);
  const scoreHot =
    r.llm_score != null && r.llm_score >= host.cfg.judge.notify_threshold;
  const lphRaw = likesPerHour(r.likes, r.created_at);
  const velocity = lphRaw.toFixed(1);
  const likes = r.likes ?? 0;
  const replies = r.replies ?? 0;
  const scoreCell = scoreHot ? `${FG_YELLOW}${BOLD}${score}${RESET}` : score;
  const velCell =
    lphRaw < minLikesPerHour ? `${FG_RED}${velocity}${RESET}` : velocity;
  const likesCell =
    likes < gate.min_likes_absolute
      ? `${FG_RED}${likes}${RESET}`
      : String(likes);
  const repliesCell =
    replies < gate.min_replies || replies > gate.max_replies
      ? `${FG_RED}${replies}${RESET}`
      : String(replies);
  items.push({
    kind: "statsCard",
    cells: [
      { label: "score", value: scoreCell },
      { label: "likes", value: likesCell },
      { label: "replies", value: repliesCell },
      { label: "l/hr", value: velCell },
    ],
  });

  items.push({ kind: "header", label: "actions" });
  items.push({
    kind: "action",
    label: "open tweet",
    hint: "default browser · marks as seen · shortcut: o",
    run: (h) => openTweet(h, r),
  });
  items.push({
    kind: "action",
    label: "judge again",
    hint: `re-run the LLM judge · live log: ${JUDGE_LOG_PATH}`,
    run: (h) => runTestJudge(h, r),
  });

  // Only render the four LLM sections once the tweet has been judged at
  // least once. Pre-judge tweets stay terse (no rows full of dashes); after
  // judging we render all four headers with a "-" placeholder for empty
  // ones so the page shape is consistent across tweets.
  const isJudged = r.llm_score != null;
  if (isJudged) {
    items.push({ kind: "header", label: "angle", color: FG_GREEN });
    if (r.llm_angle) {
      items.push({
        kind: "text",
        lines: wrapText(r.llm_angle, width),
        color: FG_GREEN,
      });
    } else {
      items.push({ kind: "text", lines: ["-"], color: FG_GREEN });
    }

    items.push({ kind: "header", label: "context" });
    if (r.llm_context) {
      items.push({ kind: "text", lines: wrapText(r.llm_context, width) });
    } else {
      items.push({ kind: "text", lines: ["-"] });
    }

    items.push({ kind: "header", label: "links" });
    const links = parseStringArrayColumn(r.llm_links);
    if (links.length > 0) {
      for (const link of links) {
        items.push({
          kind: "action",
          label: linkHostLabel(link),
          hint: link,
          run: (h) => openLink(h, link),
        });
      }
    } else {
      items.push({ kind: "text", lines: ["-"] });
    }

    items.push({ kind: "header", label: "reply ideas", color: FG_GREEN });
    const pitches = parseStringArrayColumn(r.llm_pitch);
    if (pitches.length > 0) {
      for (const p of pitches) {
        items.push({
          kind: "bullet",
          lines: wrapText(p, Math.max(10, width - 2)),
          raw: p,
          color: FG_GREEN,
          copyHint: "Enter to copy · p to refine",
        });
      }
    } else if (host.tweetDetailRefineStatus == null) {
      // Suppress the "-" placeholder while a refine is in flight on an empty
      // list — the spinner stands in for it.
      items.push({ kind: "text", lines: ["-"], color: FG_GREEN });
    }
    if (host.tweetDetailRefineStatus != null) {
      items.push({
        kind: "pendingBullet",
        status: host.tweetDetailRefineStatus,
        color: FG_GREEN,
      });
    }
  }

  return items;
}

/** Open a URL emitted in a tweet's `llm_links` array in the default browser.
 * Mirrors openTweet's spawn shape, but doesn't touch seen_at — these are
 * external entity URLs (e.g. an app's homepage), not the tweet itself. */
function openLink(host: TuiHost, url: string): void {
  spawn("open", [url], { stdio: "ignore", detached: true }).unref();
  host.flash(`opened ${url}`);
}

/** Action-row label for a link: bare hostname (e.g. "example.com") so the
 * cursor row stays short. Full URL renders as the dim hint via the existing
 * action renderer. Falls back to the raw string when URL parsing fails. */
function linkHostLabel(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Open the tweet's URL in the default browser and mark it seen if it wasn't
 * already. Shared between the "open tweet" action row and the `o` shortcut on
 * the tweet-detail page. */
export function openTweet(host: TuiHost, r: TweetRow): void {
  spawn("open", [r.url], { stdio: "ignore", detached: true }).unref();
  if (r.seen_at == null) {
    host.db.markSeen(r.id);
    r.seen_at = new Date().toISOString();
  }
  host.flash(`opened ${r.url}`);
}

/** Render the `tweets.source` column as a short "via …" line. Sources today:
 * `keyword:<q>` (keyword search), `watchlist` (author scan), `feed:home`,
 * `test`. Unknown values pass through verbatim. */
function formatSource(source: string): string {
  if (source.startsWith("keyword:")) {
    return `via keyword "${source.slice("keyword:".length)}"`;
  }
  if (source === "watchlist") return "via watchlist";
  if (source === "feed:home") return "via home feed";
  return `via ${source}`;
}

export function renderTweetDetailItem(
  it: TweetDetailItem,
  width: number,
  selected: boolean,
  opts: {
    copiedAt?: number | null;
    busyAction?: string | null;
    judgeStatus?: string | null;
  } = {},
): string[] {
  const prefix = selected ? `${FG_CYAN}│${RESET} ` : "  ";

  if (it.kind === "meta") {
    return renderBox(it.lines, width, DIM).map((l) => prefix + l);
  }
  if (it.kind === "header") {
    const color = it.color ?? "";
    return [prefix + color + BOLD + it.label + RESET];
  }
  if (it.kind === "text") {
    const inner = it.bordered ? renderBox(it.lines, width, DIM) : it.lines;
    const color = it.color ?? "";
    return inner.map((l) =>
      prefix + (color && !it.bordered ? color + l + RESET : l),
    );
  }
  if (it.kind === "statsCard") {
    return renderDividedCard(it.cells, width, DIM).map((l) => prefix + l);
  }
  if (it.kind === "bullet") {
    const color = it.color ?? "";
    const out: string[] = it.lines.map(
      (l, i) => prefix + color + (i === 0 ? "• " : "  ") + l + RESET,
    );
    if (selected && it.copyHint) {
      const justCopied =
        opts.copiedAt != null && Date.now() - opts.copiedAt < 3000;
      out.push(
        prefix +
          "  " +
          (justCopied
            ? `${FG_WHITE}✓ copied to clipboard${RESET}`
            : `${DIM}${it.copyHint}${RESET}`),
      );
    }
    return out;
  }
  if (it.kind === "pendingBullet") {
    const color = it.color ?? FG_GREEN;
    const text = renderSpinnerLabel({
      label: "refining",
      status: it.status,
      color,
    });
    return [`${prefix}${color}• ${RESET}${text}`];
  }
  // action
  const marker = selected ? `${FG_CYAN}›${RESET}` : " ";
  const isBusy = opts.busyAction != null && opts.busyAction === it.label;
  if (isBusy) {
    // Replace the label with the spinner so the user's eye stays on the row
    // they pressed Enter on; suppress the hint so the row stays compact.
    // When the agentic loop reports a step ("Thinking…", "Browsing the
    // web…", "Asking Naumu…"), wedge it between "judging…" and the spinner
    // so the user can see what's actually happening.
    const text = renderSpinnerLabel({
      label: "judging",
      status: opts.judgeStatus,
      color: FG_CYAN,
    });
    return [`${prefix}${marker} ${text}`];
  }
  const bracketed = `[ ${it.label} ]`;
  const label = selected ? `${BOLD}${bracketed}${RESET}` : bracketed;
  const hint = it.hint ? `   ${DIM}${it.hint}${RESET}` : "";
  return [`${prefix}${marker} ${label}${hint}`];
}

/**
 * Re-run the judge on a single tweet from the detail view. Constructs a fresh
 * Judge + (optional) Naumu MCP client per invocation — the daemon owns its
 * own pair, but the TUI may run in a separate process so we can't share. If
 * MCP is configured, we give it ~5s to connect; otherwise the judge runs
 * single-shot. The result overwrites llm_score/reason/angle/pitch in the DB
 * and the in-memory detailRow so the view refreshes immediately.
 */
async function runTestJudge(host: TuiHost, r: TweetRow): Promise<void> {
  // Mark the action row busy so the renderer swaps its label for "judging…
  // <spinner>". The TUI's own redraw loop ticks once a second, which is too
  // slow for a smooth spinner — drive an extra 100ms timer until we're done.
  host.tweetDetailBusyAction = "judge again";
  host.tweetDetailJudgeStatus = "Warming up…";
  host.draw();
  const spinnerTimer = setInterval(() => host.draw(), 100);

  const naumu = isNaumuEnabled(host.cfg) ? new NaumuMcpClient(host.cfg) : null;
  if (naumu) {
    host.tweetDetailJudgeStatus = "Connecting to Naumu…";
    host.draw();
    const connectPromise = naumu.connect();
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000));
    await Promise.race([connectPromise, timeout]);
  }

  try {
    const judge = new Judge(host.cfg, naumu);
    const result = await judge.judgeOne(r, {
      onStatus: (s) => {
        host.tweetDetailJudgeStatus = s;
        // Spinner timer already redraws every 100ms; no need to draw here.
      },
    });
    host.db.markJudged(
      r.id,
      result.score,
      result.reason,
      result.suggested_angle,
      result.pitch_bullets,
      result.context,
      result.links,
    );
    r.llm_score = result.score;
    r.llm_reason = result.reason;
    r.llm_angle = result.suggested_angle || null;
    r.llm_pitch =
      result.pitch_bullets.length > 0
        ? JSON.stringify(result.pitch_bullets)
        : null;
    r.llm_context = result.context || null;
    r.llm_links =
      result.links.length > 0 ? JSON.stringify(result.links) : null;
    host.flash(
      `judged: score=${result.score.toFixed(1)} (${result.reason.slice(0, 60)})`,
      6000,
    );
  } catch (e) {
    host.flash(`judge failed: ${(e as Error).message}`, 6000);
  } finally {
    clearInterval(spinnerTimer);
    host.tweetDetailBusyAction = null;
    host.tweetDetailJudgeStatus = null;
    if (naumu) {
      try {
        await naumu.close();
      } catch {
        /* best effort */
      }
    }
    host.draw();
  }
}

/** Hide the current detail row from the candidates list (does not delete from
 * the DB — sets hidden_at so fetchActive / fetchNonCandidates skip it) and
 * jump to the next candidate. If there is no next row, close the detail view
 * back to the list. host.refresh() re-runs the queries so the hidden row
 * disappears from the underlying arrays. */
export function hideAndAdvance(host: TuiHost, r: TweetRow): void {
  host.db.markHidden(r.id);
  r.hidden_at = new Date().toISOString();

  // Pick the next row from the in-memory list *before* refreshing, since
  // refresh() will drop the hidden row and shift indices.
  const combined = [...host.candidates, ...host.nonCandidates];
  const idx = combined.findIndex((x) => x.id === r.id);
  const nextRow =
    idx >= 0 && idx + 1 < combined.length ? combined[idx + 1] : null;

  host.refresh();

  if (nextRow) {
    const refreshed = [...host.candidates, ...host.nonCandidates];
    const nextIdx = refreshed.findIndex((x) => x.id === nextRow.id);
    if (nextIdx >= 0) {
      host.selected = nextIdx;
      host.detailRow = refreshed[nextIdx] ?? null;
      host.tweetDetailCursor = 0;
      host.tweetDetailCopiedAt = null;
      host.flash(`hid @${r.author}`);
      host.draw();
      return;
    }
  }

  host.detailRow = null;
  host.selected = Math.min(
    host.selected,
    Math.max(0, host.candidates.length + host.nonCandidates.length - 1),
  );
  host.flash(`hid @${r.author} (end of list)`);
  host.draw();
}

