import { stdout } from "node:process";
import { existsSync, readFileSync, statSync } from "node:fs";
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
import { DEFAULT_CONFIG_PATH } from "../config.ts";
import { logFilePath, pidFilePath } from "../lifecycle.ts";
import {
  describeWindow,
  scheduleState,
  summary as scheduleSummary,
} from "../schedule.ts";
import { scrollAnchored } from "./scroll-view.ts";
import type {
  ActivitySnapshot,
  DebugAction,
  DebugItem,
  DebugSection,
  RenderCtx,
} from "./types.ts";

export function readLogTail(maxLines: number): string[] {
  const path = logFilePath();
  if (!existsSync(path)) return [];
  try {
    const data = readFileSync(path, "utf-8");
    // last ~8KB is enough for maxLines without parsing the whole file every tick
    const tail = data.length > 8192 ? data.slice(data.length - 8192) : data;
    const lines = tail.split("\n").filter((l) => l.length > 0);
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

export function debugDaemonStartedAt(running: boolean): number | null {
  const pf = pidFilePath();
  return running && existsSync(pf) ? statSync(pf).mtimeMs : null;
}

const fmtAge = (ms: number): string => {
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400)
    return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d`;
};

function renderSection(
  id: DebugSection["id"],
  cols: number,
  ctx: RenderCtx,
): string[] {
  if (id === "daemon") {
    const lines = [BOLD + "daemon" + RESET];
    if (ctx.daemonStatus === "running") {
      const uptime =
        ctx.debug.daemonStartedAt != null
          ? fmtAge(ctx.debug.daemonStartedAt)
          : "?";
      lines.push(
        `  ${FG_GREEN}● running${RESET}  PID ${ctx.daemonPid}  uptime ~${uptime}`,
      );
    } else {
      lines.push(`  ${FG_RED}● stopped${RESET}`);
    }
    return lines;
  }
  if (id === "activity") {
    const lines = [
      BOLD + "activity" + RESET + DIM + " (last 60m, 1-min buckets)" + RESET,
    ];
    for (const l of renderActivityChart(Math.max(20, cols - 2), ctx.activity)) {
      lines.push(l);
    }
    return lines;
  }
  if (id === "paths") {
    return [
      BOLD + "paths" + RESET,
      `  config:  ${DIM}${DEFAULT_CONFIG_PATH}${RESET}`,
      `  db:      ${DIM}${ctx.cfg.storage.db_path}${RESET}`,
      `  log:     ${DIM}${logFilePath()}${RESET}`,
      `  profile: ${DIM}${ctx.cfg.scraper.profile_path}${RESET}`,
    ];
  }
  if (id === "scheduling") {
    const lines: string[] = [BOLD + "scheduling" + RESET];
    const sched = scheduleState(ctx.cfg);
    const window = describeWindow(ctx.cfg);
    const labeled = (k: string, v: string) =>
      `  ${DIM}${padRight(k, 14)}${RESET} ${v}`;
    lines.push(labeled("active hours", window));
    if (sched.active) {
      lines.push(labeled("state", `${FG_GREEN}● active${RESET}`));
    } else {
      const msUntil = sched.sleepMs;
      const hUntil = Math.floor(msUntil / 3_600_000);
      const mUntil = Math.floor((msUntil % 3_600_000) / 60_000);
      const at = sched.nextActiveAt.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
      lines.push(
        labeled(
          "state",
          `${FG_YELLOW}○ quiet${RESET} · resumes at ${at} (in ${hUntil}h ${mUntil}m)`,
        ),
      );
    }
    const watchCount = ctx.debug.stats?.watchlist ?? 0;
    const kwCount = ctx.debug.stats?.keywords ?? 0;
    const feedCount = 1;
    const sum = scheduleSummary(ctx.cfg, {
      watchlist: watchCount,
      keywords: kwCount,
      feeds: feedCount,
    });
    lines.push(
      labeled(
        "cadence",
        `~${sum.scrapesPerMin.toFixed(1)} scrapes/min · ` +
          `${ctx.cfg.schedule.base_interval_sec}s ± ${ctx.cfg.schedule.jitter_sec}s gap`,
      ),
    );
    if (ctx.cfg.schedule.long_break_after > 0) {
      lines.push(
        labeled(
          "long break",
          `${ctx.cfg.schedule.long_break_sec}s every ${ctx.cfg.schedule.long_break_after} scrapes ` +
            `${DIM}(≈ every ${sum.longBreakEveryMin.toFixed(0)} min wall-clock)${RESET}`,
        ),
      );
    } else {
      lines.push(labeled("long break", `${DIM}disabled${RESET}`));
    }
    lines.push(
      labeled(
        "targets",
        `${sum.totalTargets} total  ${DIM}(${watchCount}w · ${kwCount}k · ${feedCount}f)${RESET}` +
          ` · tracker priority for fresh tweets`,
      ),
    );
    lines.push(
      labeled(
        "full cycle",
        `~${sum.cycleMinutes.toFixed(0)} min per target ${DIM}(round-robin oldest-first)${RESET}`,
      ),
    );
    return lines;
  }
  if (id === "stats") {
    const lines = [BOLD + "stats" + RESET];
    const s = ctx.debug.stats;
    if (s) {
      const pair = (k: string, v: number) =>
        `  ${DIM}${padRight(k, 16)}${RESET} ${v}`;
      lines.push(pair("tweets total", s.tweets_total));
      lines.push(pair("active", s.active));
      lines.push(pair("pending judge", s.pending_judge));
      lines.push(pair("notified", s.notified));
      lines.push(pair("seen", s.seen));
      lines.push(pair("watchlist", s.watchlist));
      lines.push(pair("keywords", s.keywords));
    } else {
      lines.push(DIM + "  (no stats yet)" + RESET);
    }
    return lines;
  }
  // recent_log
  const lines = [
    BOLD + "recent log" + RESET + DIM + " (" + logFilePath() + ")" + RESET,
  ];
  if (ctx.debug.logTail.length === 0) {
    lines.push(DIM + "  (log is empty)" + RESET);
  } else {
    const maxLineLen = Math.max(20, cols - 6);
    for (const l of ctx.debug.logTail) {
      lines.push("  " + truncVisible(l, maxLineLen));
    }
  }
  return lines;
}

export function renderDebug(
  cols: number,
  ctx: RenderCtx,
  items: DebugItem[],
): string {
  const cur = Math.max(0, Math.min(ctx.debugCursor, items.length - 1));

  // Pre-compute action label width so the menu lines up. Labels render
  // wrapped in `[ ... ]` brackets, so account for the 4 extra chars here.
  const actionItems = items.filter(
    (it): it is DebugAction => it.kind === "action",
  );
  const labelW = actionItems.length
    ? Math.max(...actionItems.map((a) => stripAnsi(a.label).length + 4))
    : 0;

  const out: string[] = [];
  let curStart = 0;
  let curEnd = 0;

  let i = 0;
  while (i < items.length) {
    const item = items[i]!;
    if (item.kind === "section") {
      const isSel = i === cur;
      if (isSel) curStart = out.length;
      const prefix = isSel ? `${FG_CYAN}│${RESET} ` : "  ";
      for (const line of renderSection(item.id, cols, ctx)) out.push(prefix + line);
      if (isSel) curEnd = out.length - 1;
      i++;
      if (i < items.length) out.push("");
      continue;
    }
    // Action group: gather consecutive action items.
    const groupStart = i;
    let groupEnd = i;
    while (groupEnd < items.length && items[groupEnd]!.kind === "action") {
      groupEnd++;
    }
    const groupSelected = cur >= groupStart && cur < groupEnd;
    const groupPrefix = groupSelected ? `${FG_CYAN}│${RESET} ` : "  ";

    out.push(
      groupPrefix + BOLD + "actions" + RESET + DIM + " (Enter run)" + RESET,
    );
    for (let k = groupStart; k < groupEnd; k++) {
      const a = items[k] as DebugAction;
      const isSel = k === cur;
      if (isSel) curStart = out.length;
      const marker = isSel ? `${FG_CYAN}›${RESET}` : " ";
      const bracketed = `[ ${a.label} ]`;
      const label = isSel
        ? `${BOLD}${padRight(bracketed, labelW)}${RESET}`
        : padRight(bracketed, labelW);
      const hint = a.hint ? `   ${DIM}${a.hint}${RESET}` : "";
      out.push(groupPrefix + `  ${marker} ${label}${hint}`);
      if (isSel) curEnd = out.length - 1;
    }
    if (ctx.busy && groupSelected) {
      out.push(groupPrefix + `    ${FG_YELLOW}working…${RESET}`);
    }
    i = groupEnd;
    if (i < items.length) out.push("");
  }

  // Reserve: header + blank + footer-blank + footer + flash-blank + flash = 6
  const rows = stdout.rows || 24;
  const viewRows = Math.max(3, rows - 6);
  const windowed = scrollAnchored(out, viewRows, curStart, curEnd);
  return (windowed ?? out).join("\n");
}

export function renderActivityChart(
  cols: number,
  activity: ActivitySnapshot,
): string[] {
  const { scraped, surfaced, scrapedTotal, surfacedTotal } = activity;
  const label = "  scraped   ";
  const surfLabel = "  surfaced  ";
  const trailing = 8; // room for "  172" etc
  const maxBars = Math.max(
    10,
    Math.min(scraped.length, cols - label.length - trailing),
  );
  // Right-align the chart to "now" by taking the last maxBars buckets.
  const start = Math.max(0, scraped.length - maxBars);
  const scr = scraped.slice(start);
  const sur = surfaced.slice(start);

  const blocks = "▁▂▃▄▅▆▇█";
  const max = Math.max(1, ...scr);
  const scrLine = scr
    .map((n) => {
      if (n === 0) return DIM + "·" + RESET;
      const idx = Math.min(
        blocks.length - 1,
        Math.max(0, Math.ceil((n / max) * blocks.length) - 1),
      );
      return FG_CYAN + blocks[idx] + RESET;
    })
    .join("");
  const surLine = sur
    .map((n) => (n > 0 ? FG_YELLOW + "*" + RESET : DIM + "·" + RESET))
    .join("");

  const minutesShown = scr.length;
  const axis =
    DIM +
    " ".repeat(label.length) +
    `-${minutesShown}m` +
    " ".repeat(
      Math.max(1, scr.length - `-${minutesShown}m`.length - "now".length),
    ) +
    "now" +
    RESET;

  return [
    DIM + label + RESET + scrLine + `  ${BOLD}${scrapedTotal}${RESET}`,
    DIM + surfLabel + RESET + surLine + `  ${BOLD}${surfacedTotal}${RESET}`,
    axis,
  ];
}
