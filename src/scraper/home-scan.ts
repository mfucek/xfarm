import type { DB } from "../db.ts";
import type { Browser } from "./browser.ts";
import { expandTruncatedTweets, parseTweetsOnPage } from "./parse.ts";
import { TokenBucket } from "./rate-limit.ts";

/**
 * Visit https://x.com/home (the "For You" feed for logged-in users) and
 * collect whatever tweets are on screen. Lower-signal than the watchlist
 * but useful for ambient discovery — anything good will pass the gate
 * via velocity tracking.
 */
export async function scanHome(
  browser: Browser,
  db: DB,
  bucket: TokenBucket,
): Promise<number> {
  await bucket.acquire();
  let newCount = 0;
  await browser.withPage(async (page) => {
    try {
      await page.goto("https://x.com/home", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await page
        .waitForSelector('article[data-testid="tweet"]', { timeout: 15000 })
        .catch(() => undefined);
      const tweets = await parseTweetsOnPage(page);
      const slice = tweets.slice(0, 20);
      // Refetch full text for any tweet X collapsed with "Show more" before
      // upserting, so the DB never holds a truncated preview.
      await expandTruncatedTweets(page, bucket, slice);
      for (const t of slice) {
        const inserted = db.upsertTweet({
          id: t.id,
          author: t.author,
          authorFollowers: null,
          text: t.text,
          url: t.url,
          createdAt: t.createdAt,
          source: "feed:home",
          likes: t.likes,
          replies: t.replies,
          retweets: t.retweets,
        });
        if (inserted) newCount++;
      }
    } catch (e) {
      console.error("[home] scan failed:", e);
    }
  });
  db.markFeedScanned("home");
  return newCount;
}
