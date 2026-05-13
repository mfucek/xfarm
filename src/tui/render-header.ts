import {
  BOLD,
  DIM,
  FG_GREEN,
  FG_RED,
  FG_YELLOW,
  RESET,
  REVERSE,
  stripAnsi,
} from "./ansi.ts";
import type { RenderCtx } from "./types.ts";

export function renderHeader(cols: number, ctx: RenderCtx): string {
  const tab = (label: string, active: boolean, badge?: string): string => {
    const base = active ? `${REVERSE} ${label}${badge ?? ""} ${RESET}` : `${DIM} ${label}${badge ?? ""} ${RESET}`;
    return base;
  };
  const setupBad =
    ctx.setupStatus && !ctx.setupStatus.ok ? `${FG_YELLOW}!${RESET}` : "";
  const candTab = tab("Candidates", ctx.page === "candidates");
  const kwTab = tab("Keywords", ctx.page === "keywords");
  const cfgTab = tab("Config", ctx.page === "config", setupBad);
  const debugTab = tab("Debug", ctx.page === "debug");
  const daemon =
    ctx.daemonStatus === "running"
      ? `${FG_GREEN}● daemon ${ctx.daemonPid}${RESET}`
      : `${FG_RED}● daemon stopped${RESET}`;
  const surf = ctx.activity.surfacedTotal;
  const scr = ctx.activity.scrapedTotal;
  const surfStr =
    surf > 0 ? `${FG_YELLOW}${surf}${RESET}` : `${DIM}${surf}${RESET}`;
  const rate = `${surfStr}${DIM}/${scr} last hour${RESET}`;
  const left = `${BOLD}xfarm${RESET}  ${candTab} ${kwTab} ${cfgTab} ${debugTab}`;
  const right = `${rate}  ${daemon}`;
  const leftLen = stripAnsi(left).length;
  const rightLen = stripAnsi(right).length;
  const gap = Math.max(2, cols - leftLen - rightLen);
  return left + " ".repeat(gap) + right;
}
