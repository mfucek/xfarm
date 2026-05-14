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
  renderSectionHeader,
  stripAnsi,
  truncVisible,
} from "./ansi.ts";
import { assignGroups, railPrefix, rowArrow } from "./list-rail.ts";
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

const fmtRemaining = (ms: number): string => {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
};

function renderSection(
  id: DebugSection["id"],
  cols: number,
  ctx: RenderCtx,
): string[] {
  if (id === "daemon") {
    const lines = renderSectionHeader(BOLD + "daemon" + RESET, cols - 4);
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
    const lines = renderSectionHeader(
      BOLD + "activity" + RESET + DIM + " (last 60m, 1-min buckets)" + RESET,
      cols - 4,
    );
    for (const l of renderActivityChart(Math.max(20, cols - 2), ctx.activity)) {
      lines.push(l);
    }
    return lines;
  }
  if (id === "paths") {
    return [
      ...renderSectionHeader(BOLD + "paths" + RESET, cols - 4),
      `  config:  ${DIM}${DEFAULT_CONFIG_PATH}${RESET}`,
      `  db:      ${DIM}${ctx.cfg.storage.db_path}${RESET}`,
      `  log:     ${DIM}${logFilePath()}${RESET}`,
      `  profile: ${DIM}${ctx.cfg.scraper.profile_path}${RESET}`,
    ];
  }
  if (id === "scheduling") {
    const lines: string[] = renderSectionHeader(
      BOLD + "scheduling" + RESET,
      cols - 4,
    );
    const sched = scheduleState(ctx.cfg);
    const window = describeWindow(ctx.cfg);
    const labeled = (k: string, v: string) =>
      `  ${DIM}${padRight(k, 14)}${RESET} ${v}`;
    const hoursDot = sched.active
      ? `${FG_GREEN}●${RESET}`
      : `${FG_YELLOW}○${RESET}`;
    lines.push(labeled("active hours", `${hoursDot} ${window}`));
    const breakRemainingMs =
      ctx.debug.longBreakUntilMs != null
        ? ctx.debug.longBreakUntilMs - Date.now()
        : 0;
    const pausing = sched.active && breakRemainingMs > 0;
    if (pausing) {
      lines.push(
        labeled(
          "state",
          `${FG_RED}■${RESET} pausing for ${fmtRemaining(breakRemainingMs)}`,
        ),
      );
    } else if (sched.active) {
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
          `${ctx.cfg.schedule.long_break_sec}s ± ${ctx.cfg.schedule.long_break_jitter_sec}s every ${ctx.cfg.schedule.long_break_after} scrapes ` +
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
    const lines = renderSectionHeader(BOLD + "stats" + RESET, cols - 4);
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
      lines.push(pair("ask_naumu", s.ask_naumu_calls));
      lines.push(pair("web_search", s.web_search_calls));
    } else {
      lines.push(DIM + "  (no stats yet)" + RESET);
    }
    return lines;
  }
  // recent_log
  const lines = renderSectionHeader(
    BOLD + "recent log" + RESET + DIM + " (" + logFilePath() + ")" + RESET,
    cols - 4,
  );
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
  bodyRows: number,
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

  // Unified grouping: each `section` is a self-contained group of one; each
  // `header` starts a multi-item group of subsequent action rows. Config
  // uses the same `assignGroups` machinery with its own predicate.
  const groupOfItem = assignGroups(
    items,
    (it) => it.kind === "section" || it.kind === "header",
  );
  const curGroup = groupOfItem[cur] ?? -1;

  const out: string[] = [];
  let curStart = 0;
  let curEnd = 0;

  items.forEach((item, idx) => {
    // Blank line between groups: emit before each non-first group-starter.
    const startsGroup = item.kind === "section" || item.kind === "header";
    if (startsGroup && out.length > 0) out.push("");

    const isSel = idx === cur;
    if (isSel) curStart = out.length;
    const prefix = railPrefix(groupOfItem[idx] === curGroup);

    if (item.kind === "section") {
      for (const line of renderSection(item.id, cols, ctx)) {
        out.push(prefix + line);
      }
    } else if (item.kind === "header") {
      const body =
        BOLD +
        item.label +
        RESET +
        (item.suffix ? DIM + item.suffix + RESET : "");
      for (const line of renderSectionHeader(body, cols - 4)) {
        out.push(prefix + line);
      }
    } else {
      // action row
      const marker = rowArrow(isSel);
      const bracketed = `[ ${item.label} ]`;
      const label = isSel
        ? `${BOLD}${padRight(bracketed, labelW)}${RESET}`
        : padRight(bracketed, labelW);
      const hint = item.hint ? `   ${DIM}${item.hint}${RESET}` : "";
      out.push(prefix + `  ${marker} ${label}${hint}`);

      // After the last action in a cluster (next item isn't another action),
      // surface a "working…" indicator if busy and the cursor is in this
      // group. Mirrors the old bespoke loop's behavior.
      const nextIsAction = items[idx + 1]?.kind === "action";
      if (!nextIsAction && ctx.busy && groupOfItem[idx] === curGroup) {
        out.push(prefix + `    ${FG_YELLOW}working…${RESET}`);
      }
    }

    if (isSel) curEnd = out.length - 1;
  });

  const windowed = scrollAnchored(out, bodyRows, curStart, curEnd);
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
      if (n === 0) return DIM + "▁" + RESET;
      const idx = Math.min(
        blocks.length - 1,
        Math.max(0, Math.ceil((n / max) * blocks.length) - 1),
      );
      return FG_CYAN + blocks[idx] + RESET;
    })
    .join("");
  const surLine = sur
    .map((n) => (n > 0 ? FG_YELLOW + "*" + RESET : DIM + "▁" + RESET))
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
