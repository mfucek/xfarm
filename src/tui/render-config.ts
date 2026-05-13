import { stdout } from "node:process";
import {
  loadCodexUsage,
  refreshCodexUsageIfStale,
  type CodexBucket,
} from "../judge/codex-usage.ts";
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
import { getConfigItems } from "./config-items.ts";
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

  // Each header starts a group that owns every following non-header item up
  // to the next header. When the cursor lives in a group, the entire group
  // gets the cyan `│` rail — same visual contract as the Debug page's action
  // groups. Sections rendered without grouping would be flush-left and the
  // user couldn't see which section their cursor is in.
  const groupOfItem: number[] = [];
  let g = -1;
  items.forEach((it, idx) => {
    if (it.kind === "header") g++;
    groupOfItem[idx] = g;
  });
  const curGroup = groupOfItem[cur] ?? -1;

  const out: string[] = [];
  let curStart = 0;
  let curEnd = 0;

  items.forEach((it, idx) => {
    const isSel = idx === cur;
    const inSelectedGroup = groupOfItem[idx] === curGroup;
    const prefix = inSelectedGroup ? `${FG_CYAN}│${RESET} ` : "  ";
    if (isSel) curStart = out.length;

    if (it.kind === "header") {
      if (out.length > 0) out.push("");
      out.push(prefix + BOLD + it.label + RESET);
    } else if (it.kind === "status") {
      for (const line of renderStatus(host)) out.push(prefix + line);
    } else if (it.kind === "codex_usage") {
      for (const line of renderCodexUsage(cols, host)) out.push(prefix + line);
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
      out.push(prefix + `  ${marker} ${label}  ${value}${hint}`);
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

function renderCodexUsage(cols: number, host: TuiHost): string[] {
  // Kick off a background refresh if the cache is stale. Doesn't block —
  // the fresh data shows up on the next tick (1s) once codex app-server
  // responds.
  refreshCodexUsageIfStale(host.cfg);

  const usage = loadCodexUsage();
  if (!usage) {
    return [DIM + "(querying codex app-server…)" + RESET];
  }
  const out: string[] = [];
  out.push(renderBucket("primary", usage.primary, cols));
  out.push(renderBucket("secondary", usage.secondary, cols));
  const obs = new Date(usage.observed_at);
  const ageSec = Math.max(0, Math.floor((Date.now() - obs.getTime()) / 1000));
  const ageStr = ageSec < 60 ? `${ageSec}s` : `${Math.floor(ageSec / 60)}m`;
  const plan = usage.plan_type
    ? ` · plan: ${BOLD}${usage.plan_type}${RESET}${DIM}`
    : "";
  out.push(DIM + `observed ${ageStr} ago${plan}` + RESET);
  if (usage.error) {
    out.push(FG_RED + `refresh failed: ${usage.error.slice(0, cols - 20)}` + RESET);
  }
  return out;
}

function renderBucket(
  label: "primary" | "secondary",
  b: CodexBucket | null,
  cols: number,
): string {
  const friendlyLabel =
    label === "primary"
      ? `5h window  ${DIM}(primary)${RESET}`
      : `weekly     ${DIM}(secondary)${RESET}`;
  if (!b) {
    return `${padRight(friendlyLabel, 28)} ${DIM}—${RESET}`;
  }
  const pct = b.used_percent;
  const bar = renderBar(pct, Math.max(10, Math.min(40, cols - 50)));
  const pctStr = colorForPct(pct) + `${pct.toFixed(1)}%`.padStart(6) + RESET;
  const reset = b.reset_at ? ` ${DIM}· resets in ${humanizeUntil(b.reset_at)}${RESET}` : "";
  const windowHint =
    b.window_minutes > 0 && label === "secondary"
      ? ` ${DIM}(${formatWindow(b.window_minutes)})${RESET}`
      : "";
  return `${padRight(friendlyLabel, 28)} ${pctStr} ${bar}${reset}${windowHint}`;
}

function renderBar(pct: number, width: number): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  const color = colorForPct(clamped);
  return `${color}${"█".repeat(filled)}${RESET}${DIM}${"░".repeat(width - filled)}${RESET}`;
}

function colorForPct(pct: number): string {
  if (pct >= 90) return FG_RED;
  if (pct >= 70) return FG_YELLOW;
  return FG_GREEN;
}

function humanizeUntil(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const ms = t - Date.now();
  if (ms <= 0) return "now";
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function formatWindow(min: number): string {
  if (min < 60) return `${min}m window`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h}h window`;
  return `${Math.round(h / 24)}d window`;
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
