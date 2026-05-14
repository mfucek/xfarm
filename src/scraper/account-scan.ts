import type { Config } from "../config.ts";
import type { DB } from "../db.ts";
import { scheduleState } from "../schedule.ts";
import type { Browser } from "./browser.ts";
import {
  expandTruncatedTweets,
  parseFollowerCount,
  parseTweetsOnPage,
} from "./parse.ts";
import { TokenBucket, jitteredSleep, sleep } from "./rate-limit.ts";
import { passesGate } from "./velocity-tracker.ts";

const followerCache = new Map<string, number | null>();

export async function scanAuthor(
  browser: Browser,
  db: DB,
  handle: string,
  tier: number,
  cfg: Config,
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
      const slice = tweets
        .slice(0, 15)
        .filter((t) => t.author.toLowerCase() === handle.toLowerCase());
      // Refetch full text for any tweet X collapsed with "Show more" before
      // upserting, so the DB never holds a truncated preview.
      await expandTruncatedTweets(page, bucket, slice);
      for (const t of slice) {
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
          if (tier === 1) {
            db.markGatePassed(t.id);
          } else {
            const ageMin =
              (Date.now() - new Date(t.createdAt).getTime()) / 60000;
            if (passesGate(cfg, ageMin, null, t.likes, t.replies)) {
              db.markGatePassed(t.id);
            }
          }
        }
      }
    } catch (e) {
      console.error(`[watchlist] @${handle} scan failed:`, e);
    }
  });
  db.markAuthorScanned(handle);
  return newCount;
}

