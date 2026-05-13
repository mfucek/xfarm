import type { Config } from "../config.ts";
import type { DB } from "../db.ts";
import { scheduleState } from "../schedule.ts";
import type { Browser } from "./browser.ts";
import { parseTweetsOnPage } from "./parse.ts";
import { TokenBucket, jitteredSleep, sleep } from "./rate-limit.ts";

function likesPerMinute(likes: number, createdAtIso: string): number {
  const created = new Date(createdAtIso).getTime();
  const ageMin = Math.max((Date.now() - created) / 60000, 1);
  return likes / ageMin;
}

export function passesGate(
  cfg: Config,
  ageMin: number,
  velocity: number | null,
  likes: number,
): boolean {
  if (
    velocity != null &&
    ageMin <= cfg.gate.velocity_window_min &&
    velocity >= cfg.gate.min_velocity
  ) {
    return true;
  }
  // Absolute-likes branch is age-agnostic: if a tweet already has enough
  // engagement to be worth judging, surface it even if it was discovered late
  // (e.g. keyword search returned an older post) or never re-polled.
  if (likes >= cfg.gate.min_likes_absolute) {
    return true;
  }
  return false;
}

export async function repollOne(
  browser: Browser,
  db: DB,
  id: string,
  cfg: Config,
  bucket: TokenBucket,
): Promise<void> {
  await bucket.acquire();
  await browser.withPage(async (page) => {
    const url = `https://x.com/i/status/${id}`;
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page
        .waitForSelector('article[data-testid="tweet"]', { timeout: 15000 })
        .catch(() => undefined);
      const tweets = await parseTweetsOnPage(page);
      // tweet detail page shows the focal tweet first, then thread replies
      const focal = tweets.find((t) => t.id === id) ?? tweets[0];
      if (!focal) return;
      const velocity = likesPerMinute(focal.likes, focal.createdAt);
      db.updateEngagement(
        id,
        focal.likes,
        focal.replies,
        focal.retweets,
        velocity,
      );
      const ageMin = (Date.now() - new Date(focal.createdAt).getTime()) / 60000;
      if (passesGate(cfg, ageMin, velocity, focal.likes)) {
        db.markGatePassed(id);
        console.log(
          `[tracker] gate passed @${focal.author} id=${id} v=${velocity.toFixed(
            2,
          )} likes=${focal.likes} age=${ageMin.toFixed(1)}m`,
        );
      }
    } catch (e) {
      console.error(`[tracker] error on id=${id}:`, e);
    }
  });
}

