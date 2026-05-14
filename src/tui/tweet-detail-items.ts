import { spawn } from "node:child_process";
import { Judge } from "../judge/index.ts";
import { isNaumuEnabled, NaumuMcpClient } from "../judge/naumu-mcp.ts";
import {
  BOLD,
  DIM,
  FG_CYAN,
  FG_GREEN,
  FG_WHITE,
  RESET,
  ageStr,
  likesPerHour,
  parsePitchBullets,
  wrapText,
} from "./ansi.ts";
import { renderBox } from "./box.ts";
import type { TweetRow } from "../types.ts";
import type { TuiHost } from "./types.ts";

export type TweetDetailItem =
  | { kind: "meta"; lines: string[] }
  | { kind: "header"; label: string; color?: string }
  | { kind: "text"; lines: string[]; bordered?: boolean; color?: string }
  | {
      kind: "bullet";
      lines: string[];
      raw: string;
      color?: string;
      copyHint?: string;
    }
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

  const score = r.llm_score == null ? "—" : r.llm_score.toFixed(1);
  const velocity = likesPerHour(r.likes, r.created_at).toFixed(1);
  items.push({
    kind: "meta",
    lines: [
      `${FG_CYAN}@${r.author}${RESET}` +
        `  ${DIM}${ageStr(r.created_at)} ago${RESET}` +
        `  ${DIM}score${RESET} ${score}` +
        `  ${DIM}l/hr${RESET} ${velocity}` +
        `  ${DIM}likes${RESET} ${r.likes ?? 0}`,
      DIM + r.url + RESET,
    ],
  });

  items.push({ kind: "header", label: "actions" });
  items.push({
    kind: "action",
    label: "open tweet",
    hint: "default browser · marks as seen",
    run: (h) => {
      spawn("open", [r.url], { stdio: "ignore", detached: true }).unref();
      if (r.seen_at == null) {
        h.db.markSeen(r.id);
        r.seen_at = new Date().toISOString();
      }
      h.flash(`opened ${r.url}`);
    },
  });
  items.push({
    kind: "action",
    label: "judge again",
    hint:
      "re-run the LLM judge on this tweet and overwrite its score / angle / reply ideas",
    run: (h) => runTestJudge(h, r),
  });

  items.push({ kind: "header", label: "text" });
  items.push({
    kind: "text",
    lines: wrapText(r.text, Math.max(10, width - 4)),
    bordered: true,
  });

  if (r.llm_angle) {
    items.push({ kind: "header", label: "angle", color: FG_GREEN });
    items.push({
      kind: "text",
      lines: wrapText(r.llm_angle, width),
      color: FG_GREEN,
    });
  }

  const pitches = parsePitchBullets(r.llm_pitch);
  if (pitches.length > 0) {
    items.push({ kind: "header", label: "reply ideas", color: FG_GREEN });
    for (const p of pitches) {
      items.push({
        kind: "bullet",
        lines: wrapText(p, Math.max(10, width - 2)),
        raw: p,
        color: FG_GREEN,
        copyHint: "Enter to copy",
      });
    }
  }

  return items;
}

// Standard braille spinner. 80ms per frame ≈ 12.5fps — readable, not seizure-y.
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
function spinnerFrame(): string {
  return SPINNER_FRAMES[Math.floor(Date.now() / 80) % SPINNER_FRAMES.length] ?? "⠋";
}

export function renderTweetDetailItem(
  it: TweetDetailItem,
  width: number,
  selected: boolean,
  opts: { copiedAt?: number | null; busyAction?: string | null } = {},
): string[] {
  const prefix = selected ? `${FG_CYAN}│${RESET} ` : "  ";

  if (it.kind === "meta") return it.lines.map((l) => prefix + l);
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
  // action
  const marker = selected ? `${FG_CYAN}›${RESET}` : " ";
  const isBusy = opts.busyAction != null && opts.busyAction === it.label;
  if (isBusy) {
    // Replace the label with the spinner so the user's eye stays on the row
    // they pressed Enter on; suppress the hint so the row stays compact.
    const text = `${FG_CYAN}judging… ${spinnerFrame()}${RESET}`;
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
  host.draw();
  const spinnerTimer = setInterval(() => host.draw(), 100);

  const naumu = isNaumuEnabled(host.cfg) ? new NaumuMcpClient(host.cfg) : null;
  if (naumu) {
    const connectPromise = naumu.connect();
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000));
    await Promise.race([connectPromise, timeout]);
  }

  try {
    const judge = new Judge(host.cfg, naumu);
    const result = await judge.judgeOne(r);
    host.db.markJudged(
      r.id,
      result.score,
      result.reason,
      result.suggested_angle,
      result.pitch_bullets,
    );
    r.llm_score = result.score;
    r.llm_reason = result.reason;
    r.llm_angle = result.suggested_angle || null;
    r.llm_pitch =
      result.pitch_bullets.length > 0
        ? JSON.stringify(result.pitch_bullets)
        : null;
    host.flash(
      `judged: score=${result.score.toFixed(1)} (${result.reason.slice(0, 60)})`,
      6000,
    );
  } catch (e) {
    host.flash(`judge failed: ${(e as Error).message}`, 6000);
  } finally {
    clearInterval(spinnerTimer);
    host.tweetDetailBusyAction = null;
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

