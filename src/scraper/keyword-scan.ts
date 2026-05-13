import type { Config } from "../config.ts";
import type { DB } from "../db.ts";
import type { Browser } from "./browser.ts";
import { parseTweetsOnPage } from "./parse.ts";
import { TokenBucket, jitteredSleep } from "./rate-limit.ts";

export async function scanKeyword(
  browser: Browser,
  db: DB,
  query: string,
  bucket: TokenBucket,
): Promise<number> {
  await bucket.acquire();
  let newCount = 0;
  await browser.withPage(async (page) => {
    const url = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=live`;
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page
        .waitForSelector('article[data-testid="tweet"]', { timeout: 15000 })
        .catch(() => undefined);

      const tweets = await parseTweetsOnPage(page);
      for (const t of tweets.slice(0, 20)) {
        const inserted = db.upsertTweet({
          id: t.id,
          author: t.author,
          authorFollowers: null, // not visible on search results
          text: t.text,
          url: t.url,
          createdAt: t.createdAt,
          source: `keyword:${query}`,
          likes: t.likes,
          replies: t.replies,
          retweets: t.retweets,
        });
        if (inserted) newCount++;
      }
    } catch (e) {
      console.error(`[keyword] ${JSON.stringify(query)} scan failed:`, e);
    }
  });
  db.markKeywordScanned(query);
  return newCount;
}

export async function keywordLoop(
  browser: Browser,
  db: DB,
  cfg: Config,
  bucket: TokenBucket,
  stop: AbortSignal,
): Promise<void> {
  const { scan_interval_sec } = cfg.keywords;
  while (!stop.aborted) {
    const due = db.keywordsDue(scan_interval_sec);
    if (due.length === 0) {
      await jitteredSleep(
        Math.min(scan_interval_sec, 60) * 1000,
        cfg.scraper.jitter_pct,
      );
      continue;
    }
    for (const query of due) {
      if (stop.aborted) return;
      try {
        const n = await scanKeyword(browser, db, query, bucket);
        if (n > 0) console.log(`[keyword] ${JSON.stringify(query)} +${n} new`);
      } catch (e) {
        console.error(`[keyword] error on ${JSON.stringify(query)}:`, e);
      }
      await jitteredSleep(3000, cfg.scraper.jitter_pct);
    }
  }
}
