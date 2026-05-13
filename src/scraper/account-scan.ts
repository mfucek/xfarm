import type { Config } from "../config.ts";
import type { DB } from "../db.ts";
import type { Browser } from "./browser.ts";
import { parseFollowerCount, parseTweetsOnPage } from "./parse.ts";
import { TokenBucket, jitteredSleep } from "./rate-limit.ts";

const followerCache = new Map<string, number | null>();

export async function scanAuthor(
  browser: Browser,
  db: DB,
  handle: string,
  tier: number,
  bucket: TokenBucket,
): Promise<number> {
  await bucket.acquire();
  let newCount = 0;
  await browser.withPage(async (page) => {
    const url = `https://x.com/${handle}`;
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page
        .waitForSelector('article[data-testid="tweet"]', { timeout: 15000 })
        .catch(() => undefined);

      // follower count (cached per session)
      if (!followerCache.has(handle)) {
        followerCache.set(handle, await parseFollowerCount(page));
      }
      const followers = followerCache.get(handle) ?? null;

      const tweets = await parseTweetsOnPage(page);
      for (const t of tweets.slice(0, 15)) {
        // only authors's own posts (user page can show replies that aren't theirs in some views)
        if (t.author.toLowerCase() !== handle.toLowerCase()) continue;
        const inserted = db.upsertTweet({
          id: t.id,
          author: t.author,
          authorFollowers: followers,
          text: t.text,
          url: t.url,
          createdAt: t.createdAt,
          source: "watchlist",
          likes: t.likes,
          replies: t.replies,
          retweets: t.retweets,
        });
        if (inserted) {
          newCount++;
          if (tier === 1) db.markGatePassed(t.id);
        }
      }
    } catch (e) {
      console.error(`[watchlist] @${handle} scan failed:`, e);
    }
  });
  db.markAuthorScanned(handle);
  return newCount;
}

export async function watchlistLoop(
  browser: Browser,
  db: DB,
  cfg: Config,
  bucket: TokenBucket,
  stop: AbortSignal,
): Promise<void> {
  const { scan_interval_sec } = cfg.watchlist;
  while (!stop.aborted) {
    const due = db.authorsDue(scan_interval_sec);
    if (due.length === 0) {
      await jitteredSleep(
        Math.min(scan_interval_sec, 30) * 1000,
        cfg.scraper.jitter_pct,
      );
      continue;
    }
    for (const { handle, tier } of due) {
      if (stop.aborted) return;
      try {
        const n = await scanAuthor(browser, db, handle, tier, bucket);
        if (n > 0) console.log(`[watchlist] @${handle} +${n} new`);
      } catch (e) {
        console.error(`[watchlist] error on @${handle}:`, e);
      }
      await jitteredSleep(2000, cfg.scraper.jitter_pct);
    }
  }
}
