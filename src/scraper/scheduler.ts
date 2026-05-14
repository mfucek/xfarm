import type { Config } from "../config.ts";
import type { DB } from "../db.ts";
import { scheduleState } from "../schedule.ts";
import { scanAuthor } from "./account-scan.ts";
import type { Browser } from "./browser.ts";
import { scanHome } from "./home-scan.ts";
import { scanKeyword } from "./keyword-scan.ts";
import { sleep, TokenBucket } from "./rate-limit.ts";
import { repollOne } from "./velocity-tracker.ts";

type Target =
  | { type: "author"; handle: string; tier: number }
  | { type: "keyword"; query: string }
  | { type: "feed"; name: string }
  | { type: "tracked_tweet"; id: string };

/**
 * Picks the next scrape target. Priorities:
 *   1. Targets with last_scanned_at = NULL (just-reset or never-scanned) —
 *      matches the user's mental model: clearing cooldowns means scrape now.
 *   2. Tracked tweets overdue for a velocity re-poll (time-sensitive).
 *   3. Otherwise, the configured target (author/keyword/feed) whose
 *      last_scanned_at is oldest.
 */
function pickNext(db: DB, cfg: Config): Target | null {
  const author = db.oldestAuthor();
  const keyword = db.oldestKeyword();
  const feed = db.oldestFeed();

  if (author && author.last_scanned_at === null)
    return { type: "author", handle: author.handle, tier: author.tier };
  if (keyword && keyword.last_scanned_at === null)
    return { type: "keyword", query: keyword.query };
  if (feed && feed.last_scanned_at === null)
    return { type: "feed", name: feed.name };

  const tweet = db.oldestStaleTrackedTweet(
    cfg.velocity.tracker_interval_sec,
    cfg.velocity.max_age_hours,
  );
  if (tweet) return { type: "tracked_tweet", id: tweet.id };

  const candidates: { ts: string; target: Target }[] = [];
  if (author)
    candidates.push({
      ts: author.last_scanned_at ?? "",
      target: { type: "author", handle: author.handle, tier: author.tier },
    });
  if (keyword)
    candidates.push({
      ts: keyword.last_scanned_at ?? "",
      target: { type: "keyword", query: keyword.query },
    });
  if (feed)
    candidates.push({
      ts: feed.last_scanned_at ?? "",
      target: { type: "feed", name: feed.name },
    });

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.ts.localeCompare(b.ts));
  return candidates[0]?.target ?? null;
}

async function execute(
  t: Target,
  browser: Browser,
  db: DB,
  cfg: Config,
  bucket: TokenBucket,
): Promise<string> {
  switch (t.type) {
    case "author": {
      const n = await scanAuthor(browser, db, t.handle, t.tier, cfg, bucket);
      return `watchlist @${t.handle}${n > 0 ? ` +${n}` : ""}`;
    }
    case "keyword": {
      const n = await scanKeyword(browser, db, t.query, cfg, bucket);
      return `keyword ${JSON.stringify(t.query)}${n > 0 ? ` +${n}` : ""}`;
    }
    case "feed": {
      const n = await scanHome(browser, db, bucket);
      return `feed ${t.name}${n > 0 ? ` +${n}` : ""}`;
    }
    case "tracked_tweet": {
      await repollOne(browser, db, t.id, cfg, bucket);
      return `tracker id=${t.id.slice(0, 12)}`;
    }
  }
}

function nextWaitMs(cfg: Config): number {
  const base = cfg.schedule.base_interval_sec * 1000;
  const jitter = cfg.schedule.jitter_sec * 1000;
  const offset = (Math.random() * 2 - 1) * jitter;
  return Math.max(1000, base + offset);
}

export async function runScheduler(
  browser: Browser,
  db: DB,
  cfg: Config,
  bucket: TokenBucket,
  stop: AbortSignal,
): Promise<void> {
  // Seed the feeds table with the home timeline.
  db.syncFeeds([{ name: "home", interval_sec: cfg.schedule.home_interval_sec }]);

  let counter = 0;
  console.log(
    `[scheduler] starting — ~${(60 / cfg.schedule.base_interval_sec).toFixed(1)} scrapes/min, ` +
      `long break every ${cfg.schedule.long_break_after}× scrapes`,
  );

  while (!stop.aborted) {
    // Quiet hours: park until the window opens.
    const state = scheduleState(cfg);
    if (!state.active) {
      console.log(
        `[scheduler] quiet hours — sleeping until ${state.nextActiveAt.toISOString()}`,
      );
      await sleep(Math.min(state.sleepMs, 5 * 60 * 1000));
      continue;
    }

    const target = pickNext(db, cfg);
    if (!target) {
      await sleep(nextWaitMs(cfg));
      continue;
    }

    try {
      const summary = await execute(target, browser, db, cfg, bucket);
      counter++;
      console.log(`[scrape] #${counter} ${summary}`);
    } catch (e) {
      console.error("[scrape] error on", target, e);
    }

    if (stop.aborted) return;

    // Periodic long break to look less robotic.
    if (
      cfg.schedule.long_break_after > 0 &&
      counter % cfg.schedule.long_break_after === 0
    ) {
      const baseMs = cfg.schedule.long_break_sec * 1000;
      const jitterMs = cfg.schedule.long_break_jitter_sec * 1000;
      const offsetMs = (Math.random() * 2 - 1) * jitterMs;
      const breakMs = Math.max(0, baseMs + offsetMs);
      console.log(
        `[scheduler] long break: ${(breakMs / 1000).toFixed(0)}s after ${counter} scrapes`,
      );
      await sleep(breakMs);
      continue;
    }

    await sleep(nextWaitMs(cfg));
  }
}
