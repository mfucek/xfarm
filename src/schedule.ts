import type { Config } from "./config.ts";

export type ScheduleState =
  | { active: true }
  | { active: false; nextActiveAt: Date; sleepMs: number };

/**
 * Returns whether scraping should run right now per the configured
 * `schedule.active_hours_start/end` window. When the start and end hours
 * are equal, the schedule is "always active" (no quiet hours).
 *
 * Hours are local-time, integer 0..23. Window is inclusive on start,
 * exclusive on end. Overnight windows (e.g. start=22, end=6) are supported.
 */
export function scheduleState(
  cfg: Config,
  now: Date = new Date(),
): ScheduleState {
  const start = cfg.schedule.active_hours_start;
  const end = cfg.schedule.active_hours_end;
  if (start === end) return { active: true };

  const h = now.getHours();
  const overnight = start > end;
  const inWindow = overnight
    ? h >= start || h < end
    : h >= start && h < end;
  if (inWindow) return { active: true };

  // Next active boundary: today at `start` if we haven't passed it yet,
  // otherwise tomorrow at `start`.
  const next = new Date(now);
  next.setMinutes(0);
  next.setSeconds(0);
  next.setMilliseconds(0);
  next.setHours(start);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return {
    active: false,
    nextActiveAt: next,
    sleepMs: next.getTime() - now.getTime(),
  };
}

export function describeWindow(cfg: Config): string {
  const start = cfg.schedule.active_hours_start;
  const end = cfg.schedule.active_hours_end;
  if (start === end) return "24/7";
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(start)}:00–${pad(end)}:00 local`;
}

/**
 * Summary of the unified scheduler's effective cadence given how many
 * targets are configured. The scheduler picks one target per scrape,
 * paced by base_interval_sec ± jitter_sec, with a long break every
 * long_break_after scrapes.
 */
export function summary(
  cfg: Config,
  counts: { watchlist: number; keywords: number; feeds: number },
): {
  scrapesPerMin: number;
  avgGapSec: number;
  totalTargets: number;
  cycleMinutes: number; // approx time for one full round through all targets
  longBreakEveryMin: number;
} {
  const base = cfg.schedule.base_interval_sec;
  const jitter = cfg.schedule.jitter_sec;
  // average gap with jitter is just base (uniform jitter has zero mean offset)
  const avgGapSec = base;
  const totalTargets = counts.watchlist + counts.keywords + counts.feeds;
  // Account for long breaks amortized across the cycle.
  const breakEvery = cfg.schedule.long_break_after;
  const breakSec = cfg.schedule.long_break_sec;
  const breakAmortizedPerScrape =
    breakEvery > 0 ? breakSec / breakEvery : 0;
  const realAvgGap = avgGapSec + breakAmortizedPerScrape;
  return {
    scrapesPerMin: 60 / realAvgGap,
    avgGapSec,
    totalTargets,
    cycleMinutes: (totalTargets * realAvgGap) / 60,
    longBreakEveryMin: (breakEvery * realAvgGap) / 60,
  };
}
