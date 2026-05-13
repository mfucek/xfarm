import { spawn } from "node:child_process";
import {
  BOLD,
  DIM,
  FG_CYAN,
  FG_GREEN,
  RESET,
  ageStr,
  parsePitchBullets,
  wrapText,
} from "./ansi.ts";
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

export function getTweetDetailItems(
  host: TuiHost,
  r: TweetRow,
  width: number,
): TweetDetailItem[] {
  const items: TweetDetailItem[] = [];

  const score = r.llm_score == null ? "—" : r.llm_score.toFixed(1);
  const velocity = r.velocity == null ? "—" : r.velocity.toFixed(1);
  items.push({
    kind: "meta",
    lines: [
      `${FG_CYAN}@${r.author}${RESET}` +
        `  ${DIM}${ageStr(r.created_at)} ago${RESET}` +
        `  ${DIM}score${RESET} ${score}` +
        `  ${DIM}v/min${RESET} ${velocity}` +
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
): string[] {
  const prefix = selected ? `${FG_CYAN}│${RESET} ` : "  ";

  if (it.kind === "meta") return it.lines.map((l) => prefix + l);
  if (it.kind === "header") {
    const color = it.color ?? "";
    return [prefix + color + BOLD + it.label + RESET];
  }
  if (it.kind === "text") {
    const inner = it.bordered ? renderBordered(it.lines, width) : it.lines;
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
      out.push(prefix + DIM + it.copyHint + RESET);
    }
    return out;
  }
  // action
  const marker = selected ? `${FG_CYAN}›${RESET}` : " ";
  const label = selected ? `${BOLD}${it.label}${RESET}` : it.label;
  const hint = it.hint ? `   ${DIM}${it.hint}${RESET}` : "";
  return [`${prefix}${marker} ${label}${hint}`];
}

function renderBordered(lines: string[], width: number): string[] {
  const inner = Math.max(4, width - 4);
  const top = `${DIM}┌${"─".repeat(inner + 2)}┐${RESET}`;
  const bot = `${DIM}└${"─".repeat(inner + 2)}┘${RESET}`;
  const out = [top];
  for (const l of lines) {
    const pad = inner - l.length;
    const padded = pad > 0 ? l + " ".repeat(pad) : l.slice(0, inner);
    out.push(`${DIM}│${RESET} ${padded} ${DIM}│${RESET}`);
  }
  out.push(bot);
  return out;
}
