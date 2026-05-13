import { stdout } from "node:process";
import {
  BOLD,
  DIM,
  FG_CYAN,
  FG_GREEN,
  FG_RED,
  FG_YELLOW,
  RESET,
  padRight,
  stripAnsi,
  truncVisible,
} from "./ansi.ts";
import { getConfigItems, type ConfigItem } from "./config-items.ts";
import type { RenderCtx, TuiHost } from "./types.ts";

export function renderConfig(cols: number, host: TuiHost): string {
  const items = getConfigItems(host);
  const cur = Math.max(0, Math.min(host.configCursor, items.length - 1));

  // Pre-compute label width across all field/toggle items so values align.
  const labelW = Math.max(
    8,
    ...items
      .filter((it) => it.kind === "field" || it.kind === "toggle")
      .map((it) => stripAnsi((it as { label: string }).label).length),
  );

  const out: string[] = [];
  let curStart = 0;
  let curEnd = 0;

  items.forEach((it, idx) => {
    const isSel = idx === cur;
    if (isSel) curStart = out.length;

    if (it.kind === "header") {
      if (out.length > 0) out.push("");
      out.push(BOLD + it.label + RESET);
    } else if (it.kind === "status") {
      for (const line of renderStatus(host)) out.push("  " + line);
    } else {
      const marker = isSel ? `${FG_CYAN}›${RESET}` : " ";
      const label = isSel
        ? `${BOLD}${padRight(it.label, labelW)}${RESET}`
        : padRight(it.label, labelW);
      const valueColor =
        it.kind === "toggle" ? FG_GREEN : valueColorFor(it.value);
      const valW = Math.max(10, Math.floor((cols - 8 - labelW) * 0.45));
      const value = valueColor + truncVisible(it.value, valW) + RESET;
      const hint = it.hint ? `   ${DIM}${it.hint}${RESET}` : "";
      out.push(`  ${marker} ${label}  ${value}${hint}`);
    }

    if (isSel) curEnd = out.length - 1;
  });

  // Apply same windowing approach as renderDebug.
  const rows = stdout.rows || 24;
  const viewRows = Math.max(3, rows - 6);
  if (out.length <= viewRows) return out.join("\n");

  const innerRows = Math.max(1, viewRows - 1);
  let offset = 0;
  if (curEnd >= innerRows) offset = curEnd - innerRows + 1;
  if (curStart < offset) offset = curStart;
  offset = Math.max(0, Math.min(offset, out.length - innerRows));

  const visible = out.slice(offset, offset + innerRows);
  const above = offset;
  const below = out.length - offset - visible.length;
  visible.push(
    DIM +
      `  ${offset + 1}-${offset + visible.length} of ${out.length}` +
      (above > 0 ? `  ↑${above}` : "") +
      (below > 0 ? `  ↓${below}` : "") +
      RESET,
  );
  return visible.join("\n");
}

function valueColorFor(v: string): string {
  if (v.startsWith("(unset)")) return FG_RED;
  return "";
}

function renderStatus(ctx: RenderCtx): string[] {
  const s = ctx.setupStatus;
  if (!s) return [DIM + "(checking…)" + RESET];
  const lines: string[] = [];
  const overall = s.ok
    ? `${FG_GREEN}● ready${RESET}`
    : `${FG_YELLOW}● incomplete${RESET}`;
  lines.push(overall);
  for (const c of s.checks) {
    const dot = c.ok ? `${FG_GREEN}✓${RESET}` : `${FG_RED}✗${RESET}`;
    const name = padRight(c.id, 8);
    lines.push(`${dot} ${DIM}${name}${RESET} ${c.detail}`);
  }
  return lines;
}
