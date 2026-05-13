import { stdout } from "node:process";
import {
  BOLD,
  DIM,
  FG_BLUE,
  FG_CYAN,
  FG_GRAY,
  FG_GREEN,
  FG_RED,
  RESET,
  REVERSE,
  ageStr,
  padRight,
  stripAnsi,
  truncVisible,
  wrapText,
} from "./ansi.ts";
import { addsCount, itemSuggestion } from "./keyword-items.ts";
import type { KeywordItem, RenderCtx } from "./types.ts";

type ColWidths = {
  idx: number;
  icon: number;
  kw: number;
  newKw: number;
  scanned: number;
  reason: number;
};

function computeWidths(cols: number): ColWidths {
  const idx = 3;
  const icon = 1;
  const scanned = 12;
  const remaining = Math.max(30, cols - (idx + 1 + icon + 1 + scanned + 1 + 1));
  const kw = Math.max(14, Math.min(32, Math.floor(remaining * 0.32)));
  const newKw = Math.max(12, Math.min(28, Math.floor(remaining * 0.26)));
  const fixed = idx + 1 + icon + 1 + kw + 1 + newKw + 1 + scanned + 1;
  const reason = Math.max(16, cols - fixed);
  return { idx, icon, kw, newKw, scanned, reason };
}

export function renderKeywords(cols: number, ctx: RenderCtx): string {
  const W = computeWidths(cols);
  const lines: string[] = [];
  const adds = addsCount(ctx.keywordItems);
  const pending = ctx.pendingSuggestionCount;
  const chunkSize = ctx.cfg.suggester.chunk_size;
  const progress = `${ctx.unchunkedCount}/${chunkSize} toward next chunk`;
  const total = ctx.keywordItems.length;
  const sel = Math.max(0, Math.min(ctx.selected, Math.max(0, total - 1)));
  const pagination = total > 0 ? `${sel + 1}/${total}` : "0/0";
  lines.push(
    DIM +
      `${total - adds} keywords · ${pending} pending · ${pagination} · ${progress}` +
      RESET,
  );
  lines.push("");
  lines.push(
    DIM +
      padRight("#", W.idx) +
      " " +
      padRight("", W.icon) +
      " " +
      padRight("keyword", W.kw) +
      " " +
      padRight("→ new keyword", W.newKw) +
      " " +
      padRight("last scan", W.scanned) +
      " reason" +
      RESET,
  );

  if (total === 0) {
    lines.push("");
    lines.push(DIM + "(no keywords — press + to add one)" + RESET);
    return lines.join("\n");
  }

  const rows = stdout.rows || 24;
  const dataRows = Math.max(3, rows - 10);
  let start = Math.max(0, sel - Math.floor(dataRows / 2));
  let end = Math.min(total, start + dataRows);
  start = Math.max(0, end - dataRows);

  for (let i = start; i < end; i++) {
    // Visual divider where pending adds end and existing keywords begin.
    if (i === adds && adds > 0 && i > start) {
      lines.push(DIM + "─".repeat(cols) + RESET);
    }
    lines.push(renderRow(i, ctx.keywordItems[i]!, sel, W));
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

function renderRow(
  idx: number,
  it: KeywordItem,
  sel: number,
  W: ColWidths,
): string {
  const isSel = idx === sel;
  const prefix = isSel ? REVERSE : "";
  const suffix = isSel ? RESET : "";
  // Reverse-video flips fg/bg; close-and-reopen the highlight around any
  // ANSI escape so colors don't bleed past the selected row.
  const hi = (s: string) => (isSel ? s + REVERSE : s);

  let iconChar = " ";
  let iconColor = "";
  let kwColor = "";
  let kwText = "";
  let newKwCell = "";
  let scanned = "";
  let reason = "";

  if (it.kind === "add") {
    iconChar = "+";
    iconColor = FG_GREEN;
    kwColor = FG_GREEN;
    kwText = it.suggestion.keyword;
    reason = it.suggestion.reason;
    scanned = "—";
  } else {
    kwText = it.query;
    scanned = it.last_scanned_at
      ? ageStr(it.last_scanned_at) + " ago"
      : "never";
    const s = it.suggestion;
    if (s?.verdict === "remove") {
      iconChar = "X";
      iconColor = FG_RED;
      kwColor = FG_RED;
      reason = s.reason;
    } else if (s?.verdict === "change") {
      iconChar = "~";
      iconColor = FG_BLUE;
      newKwCell = hi(FG_BLUE + truncVisible(s.replacement ?? "", W.newKw) + RESET);
      reason = s.reason;
    }
  }

  const iconCell = iconColor ? hi(iconColor + iconChar + RESET) : iconChar;
  const kwCell = kwColor
    ? hi(kwColor + truncVisible(kwText, W.kw) + RESET)
    : truncVisible(kwText, W.kw);
  const scannedCell = hi(DIM + scanned + RESET);
  const reasonCell = reason
    ? hi(DIM + truncVisible(reason, W.reason) + RESET)
    : "";

  return (
    prefix +
    padRight(String(idx), W.idx) +
    " " +
    padRight(iconCell, W.icon) +
    " " +
    padRight(kwCell, W.kw) +
    " " +
    padRight(newKwCell, W.newKw) +
    " " +
    padRight(scannedCell, W.scanned) +
    " " +
    reasonCell +
    suffix
  );
}

export function renderKeywordDetail(cols: number, ctx: RenderCtx): string {
  const it = ctx.detailKeyword;
  if (!it) return "";
  const width = Math.max(20, Math.min(100, cols - 4));
  const lines: string[] = [];
  const s = itemSuggestion(it);
  const position =
    ctx.keywordItems.length > 0
      ? `  ${DIM}${ctx.selected + 1}/${ctx.keywordItems.length}${RESET}`
      : "";

  if (it.kind === "add") {
    lines.push(
      `${FG_GREEN}${BOLD}+${RESET}` +
        `  ${FG_GREEN}${it.suggestion.keyword}${RESET}` +
        `  ${DIM}chunk ${it.suggestion.chunk_id}${RESET}` +
        `  ${DIM}${ageStr(it.suggestion.created_at)} ago${RESET}` +
        position,
    );
  } else {
    const verdictColor =
      s?.verdict === "remove" ? FG_RED : s?.verdict === "change" ? FG_BLUE : "";
    const iconChar =
      s?.verdict === "remove" ? "X" : s?.verdict === "change" ? "~" : "•";
    const iconCell = verdictColor
      ? `${verdictColor}${BOLD}${iconChar}${RESET}`
      : `${DIM}${iconChar}${RESET}`;
    const kwPart =
      s?.verdict === "change" && s.replacement
        ? `${FG_RED}${it.query}${RESET} ${DIM}→${RESET} ${FG_BLUE}${s.replacement}${RESET}`
        : s?.verdict === "remove"
          ? `${FG_RED}${it.query}${RESET}`
          : `${it.query}`;
    const scanned = it.last_scanned_at
      ? `${ageStr(it.last_scanned_at)} ago`
      : "never";
    lines.push(
      `${iconCell}  ${kwPart}` +
        `  ${DIM}last scanned${RESET} ${scanned}` +
        (s
          ? `  ${DIM}chunk ${s.chunk_id}${RESET}  ${DIM}${ageStr(s.created_at)} ago${RESET}`
          : "") +
        position,
    );
  }
  lines.push("");

  if (s) {
    lines.push(BOLD + "reason" + RESET);
    for (const l of wrapText(s.reason, width)) lines.push(l);

    if (ctx.detailTweets.length > 0) {
      lines.push("");
      lines.push(
        BOLD +
          `examples (${ctx.detailTweets.length})` +
          RESET +
          DIM +
          " — tweets in chunk that match this keyword" +
          RESET,
      );
      const boxWidth = width;
      // Inner content area is "│ <text> │" → 2 chars of frame + 2 of padding.
      const innerWidth = Math.max(10, boxWidth - 4);
      const top = FG_GRAY + "┌" + "─".repeat(boxWidth - 2) + "┐" + RESET;
      const bot = FG_GRAY + "└" + "─".repeat(boxWidth - 2) + "┘" + RESET;
      const frame = (content: string): string => {
        const visible = stripAnsi(content).length;
        const pad = Math.max(0, innerWidth - visible);
        return (
          FG_GRAY +
          "│ " +
          RESET +
          content +
          " ".repeat(pad) +
          FG_GRAY +
          " │" +
          RESET
        );
      };
      ctx.detailTweets.forEach((t, idx) => {
        if (idx > 0) lines.push("");
        const header =
          `${FG_CYAN}@${t.author}${RESET} ` +
          `${DIM}${ageStr(t.created_at)} · ${t.likes ?? 0}♥ ${t.replies ?? 0}↩${RESET}`;
        lines.push(top);
        lines.push(frame(header));
        lines.push(frame(""));
        for (const l of wrapText(t.text, innerWidth)) lines.push(frame(l));
        lines.push(bot);
      });
    }
  } else {
    lines.push(DIM + "(no pending suggestion for this keyword)" + RESET);
  }

  // Window the content using detailScroll. The chrome budget below matches
  // the debug page so the header + footers + flash line up.
  const rows = stdout.rows || 24;
  const viewRows = Math.max(3, rows - 6);
  if (lines.length <= viewRows) {
    ctx.detailScroll = 0;
    return lines.join("\n");
  }
  const innerRows = Math.max(1, viewRows - 1);
  const maxOffset = Math.max(0, lines.length - innerRows);
  ctx.detailScroll = Math.max(0, Math.min(ctx.detailScroll, maxOffset));
  const offset = ctx.detailScroll;
  const visible = lines.slice(offset, offset + innerRows);
  const above = offset;
  const below = lines.length - offset - visible.length;
  visible.push(
    DIM +
      `  ${offset + 1}-${offset + visible.length} of ${lines.length}` +
      (above > 0 ? `  ↑${above}` : "") +
      (below > 0 ? `  ↓${below}` : "") +
      RESET,
  );
  return visible.join("\n");
}
