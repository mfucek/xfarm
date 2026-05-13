import { spawn } from "node:child_process";
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
      kind: "bullets";
      bullets: string[][];
      raw: string[];
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
 * activatable-on-Enter (bullets, which copies to clipboard). Meta, headers,
 * and plain text are read-only and skipped during j/k navigation. */
export function isSelectable(it: TweetDetailItem): boolean {
  return it.kind === "action" || it.kind === "bullets";
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
    hint: "default browser",
    run: (h) => {
      spawn("open", [r.url], { stdio: "ignore", detached: true }).unref();
      h.flash(`opened ${r.url}`);
    },
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
    items.push({
      kind: "bullets",
      bullets: pitches.map((b) => wrapText(b, Math.max(10, width - 2))),
      raw: pitches,
      color: FG_GREEN,
      copyHint: "Enter to copy",
    });
  }

  return items;
}

export function renderTweetDetailItem(
  it: TweetDetailItem,
  width: number,
  selected: boolean,
  opts: { copiedAt?: number | null } = {},
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
  if (it.kind === "bullets") {
    const color = it.color ?? "";
    const out: string[] = [];
    for (const wrapped of it.bullets) {
      wrapped.forEach((l, i) => {
        out.push(prefix + color + (i === 0 ? "• " : "  ") + l + RESET);
      });
    }
    if (selected && it.copyHint) {
      const justCopied =
        opts.copiedAt != null && Date.now() - opts.copiedAt < 3000;
      out.push(
        prefix +
          (justCopied
            ? `${FG_WHITE}✓ copied to clipboard${RESET}`
            : `${DIM}${it.copyHint}${RESET}`),
      );
    }
    return out;
  }
  // action
  const marker = selected ? `${FG_CYAN}›${RESET}` : " ";
  const label = selected ? `${BOLD}${it.label}${RESET}` : it.label;
  const hint = it.hint ? `   ${DIM}${it.hint}${RESET}` : "";
  return [`${prefix}${marker} ${label}${hint}`];
}

