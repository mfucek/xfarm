import {
  loadCodexUsage,
  refreshCodexUsageIfStale,
  type CodexBucket,
} from "../judge/codex-usage.ts";
import {
  BOLD,
  DIM,
  FG_GREEN,
  FG_RED,
  FG_YELLOW,
  RESET,
  padRight,
  renderSectionHeader,
  stripAnsi,
  truncVisible,
} from "./ansi.ts";
import { getConfigItems } from "./config-items.ts";
import { assignGroups, railPrefix, rowArrow } from "./list-rail.ts";
import type { RenderCtx, TuiHost } from "./types.ts";

// Layout: each header starts a group that owns every following non-header
// item up to the next header. `railPrefix` adds the cyan `│ ` left rail to
// every line of the group containing the cursor; other groups get a plain
// 2-space indent. Selected actionable rows get a `›` arrow + bold label.
// Section titles, status, and codex usage are not selectable — the cursor
// skips them.

export function renderConfig(
  cols: number,
  bodyRows: number,
  host: TuiHost,
): string {
  const items = getConfigItems(host);
  const cur = Math.max(0, Math.min(host.configCursor, items.length - 1));

  // Label column width: widest plain label across all interactive rows.
  // No `[ brackets ]` to budget for anymore.
  const labelW = Math.max(
    8,
    ...items
      .filter((it) => it.kind === "field" || it.kind === "toggle")
      .map((it) => stripAnsi((it as { label: string }).label).length),
  );

  // Unified grouping: each `header` starts a new group; non-header items
  // (status, codex_usage, field, toggle) belong to the preceding group.
  // Debug uses the same `assignGroups` machinery with its own predicate
  // (section + header items as group-starters).
  const groupOfItem = assignGroups(items, (it) => it.kind === "header");
  const curGroup = groupOfItem[cur] ?? -1;

  const out: string[] = [];
  let curStart = 0;
  let curEnd = 0;

  items.forEach((it, idx) => {
    const isSel = idx === cur;
    const prefix = railPrefix(groupOfItem[idx] === curGroup);
    if (isSel) curStart = out.length;

    if (it.kind === "header") {
      if (out.length > 0) out.push("");
      const headerLines = renderSectionHeader(
        BOLD + it.label + RESET,
        cols - 4,
      );
      for (const line of headerLines) out.push(prefix + line);
    } else if (it.kind === "status") {
      for (const line of renderStatus(host)) out.push(prefix + line);
    } else if (it.kind === "codex_usage") {
      for (const line of renderCodexUsage(cols, labelW, host)) {
        out.push(prefix + line);
      }
    } else {
      // field or toggle row
      const marker = rowArrow(isSel);
      const label = isSel
        ? BOLD + padRight(it.label, labelW) + RESET
        : padRight(it.label, labelW);

      let valueStr: string;
      if (it.kind === "toggle") {
        if (it.value === "off") {
          valueStr = `${DIM}○ off${RESET}`;
        } else if (it.value === "on") {
          valueStr = `${FG_GREEN}● on${RESET}`;
        } else {
          // Non-boolean toggle (e.g. provider: codex / gemini). Filled
          // circle in green communicates "stateful selection" same as the
          // on-pill — the value text differs but the affordance is identical.
          valueStr = `${FG_GREEN}● ${it.value}${RESET}`;
        }
      } else {
        const color = valueColorFor(it.value);
        const valW = Math.max(10, Math.floor((cols - 8 - labelW) * 0.45));
        valueStr = color + truncVisible(it.value, valW) + RESET;
      }

      // Inline hint only on the focused row. Trim to fit remaining width
      // so it never wraps past the right edge.
      let hint = "";
      if (isSel && it.hint) {
        // prefix=2, "  "=2, marker=1, " "=1, label=labelW, "  "=2, value, "   "=3
        const used = 8 + labelW + stripAnsi(valueStr).length + 3;
        const remaining = Math.max(8, cols - used);
        hint = `   ${DIM}${truncVisible(it.hint, remaining)}${RESET}`;
      }

      out.push(prefix + `  ${marker} ${label}  ${valueStr}${hint}`);
    }

    if (isSel) curEnd = out.length - 1;
  });

  // Windowing (unchanged from previous version).
  if (out.length <= bodyRows) return out.join("\n");

  const innerRows = Math.max(1, bodyRows - 1);
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

function renderCodexUsage(
  cols: number,
  labelW: number,
  host: TuiHost,
): string[] {
  // Kick off a background refresh if the cache is stale. Doesn't block —
  // the fresh data shows up on the next tick (1s) once codex app-server
  // responds.
  refreshCodexUsageIfStale(host.cfg);

  const usage = loadCodexUsage();
  if (!usage) {
    return [DIM + "(querying codex app-server…)" + RESET];
  }
  const out: string[] = [];
  out.push(renderBucket("primary", usage.primary, cols, labelW));
  out.push(renderBucket("secondary", usage.secondary, cols, labelW));
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
  labelW: number,
): string {
  // Pad to labelW so percentage/bar starts at the same column as field
  // values do above and below.
  const friendlyLabel = label === "primary" ? "5h window" : "weekly";
  if (!b) {
    return `${padRight(friendlyLabel, labelW)}  ${DIM}—${RESET}`;
  }
  const pct = b.used_percent;
  const bar = renderBar(pct, Math.max(10, Math.min(40, cols - 50)));
  const pctStr = colorForPct(pct) + `${pct.toFixed(1)}%`.padStart(6) + RESET;
  const reset = b.reset_at ? ` ${DIM}· resets in ${humanizeUntil(b.reset_at)}${RESET}` : "";
  const windowHint =
    b.window_minutes > 0 && label === "secondary"
      ? ` ${DIM}(${formatWindow(b.window_minutes)})${RESET}`
      : "";
  return `${padRight(friendlyLabel, labelW)}  ${pctStr} ${bar}${reset}${windowHint}`;
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
