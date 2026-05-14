import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

const VERSION = ((): string => {
  try {
    const pkg = JSON.parse(
      readFileSync(resolve(import.meta.dir, "../../package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

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
  // Brand title doubles as the About tab — highlighted when active,
  // brand-styled otherwise.
  const title =
    ctx.page === "about"
      ? `${REVERSE}${BOLD} xfarm${RESET}${REVERSE} v${VERSION} ${RESET}`
      : `${BOLD}xfarm${RESET} ${DIM}v${VERSION}${RESET}`;
  const daemon =
    ctx.daemonStatus === "running"
      ? `${FG_GREEN}● daemon ${ctx.daemonPid}${RESET}`
      : `${FG_RED}● daemon stopped${RESET}`;
  const surf = ctx.activity.surfacedTotal;
  const scr = ctx.activity.scrapedTotal;
  const surfStr =
    surf > 0 ? `${FG_YELLOW}${surf}${RESET}` : `${DIM}${surf}${RESET}`;
  const rate = `${surfStr}${DIM}/${scr} last hour${RESET}`;
  const left = `${title}  ${candTab} ${kwTab} ${cfgTab} ${debugTab}`;
  const right = `${rate}  ${daemon}`;
  const leftLen = stripAnsi(left).length;
  const rightLen = stripAnsi(right).length;
  const gap = Math.max(2, cols - leftLen - rightLen);
  return left + " ".repeat(gap) + right;
}
