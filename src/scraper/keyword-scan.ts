import type { Config } from "../config.ts";
import type { DB } from "../db.ts";
import { scheduleState } from "../schedule.ts";
import type { Browser } from "./browser.ts";
import { parseTweetsOnPage } from "./parse.ts";
import { TokenBucket, jitteredSleep, sleep } from "./rate-limit.ts";
import { passesGate } from "./velocity-tracker.ts";

export async function scanKeyword(
  browser: Browser,
  db: DB,
  query: string,
  cfg: Config,
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
        if (inserted) {
          newCount++;
          // Search often returns tweets that are already older than the
          // velocity tracker's polling window — they'd never reach passesGate
          // otherwise. Apply the gate at discovery so they still get judged.
          const ageMin = (Date.now() - new Date(t.createdAt).getTime()) / 60000;
          if (passesGate(cfg, ageMin, null, t.likes, t.replies)) {
            db.markGatePassed(t.id);
          }
        }
      }
    } catch (e) {
      console.error(`[keyword] ${JSON.stringify(query)} scan failed:`, e);
    }
  });
  db.markKeywordScanned(query);
  return newCount;
}

