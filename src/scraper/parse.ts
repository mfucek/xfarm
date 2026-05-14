import type { Page } from "playwright";
import type { ScrapedTweet } from "../types.ts";
import { jitteredSleep, TokenBucket } from "./rate-limit.ts";

/** Scraped tweet plus an internal flag the parser sets when X rendered a
 * "Show more" link inside the tweet body — meaning the visible text is the
 * truncated preview, not the full post. Scanners use this to decide whether
 * to refetch the full text from the permalink before writing to the DB. */
export type ParsedTweet = Omit<ScrapedTweet, "authorFollowers"> & {
  truncated: boolean;
};

/**
 * Extracts visible tweets from the current page. Runs in the browser context
 * via page.evaluate. Returns tweets in DOM order.
 *
 * Skips retweets, pinned tweets, and ads. Engagement counts come from
 * aria-labels (more reliable than the K/M-abbreviated visible text).
 */
export async function parseTweetsOnPage(page: Page): Promise<ParsedTweet[]> {
  return await page.evaluate(() => {
    const out: (Omit<ScrapedTweet, "authorFollowers"> & {
      truncated: boolean;
    })[] = [];

    const articles = Array.from(
      document.querySelectorAll('article[data-testid="tweet"]'),
    );

    const parseCountFromAria = (label: string | null): number => {
      if (!label) return 0;
      // examples: "42 Likes. Like", "1,234 reposts. Repost", "5 Replies. Reply"
      const m = label.match(/([\d,]+)/);
      if (!m || !m[1]) return 0;
      return Number(m[1].replace(/,/g, "")) || 0;
    };

    for (const art of articles) {
      // skip retweets / pinned / ads — they have a socialContext slot
      const social = art.querySelector('[data-testid="socialContext"]');
      if (social) {
        const txt = (social.textContent || "").toLowerCase();
        if (
          txt.includes("repost") ||
          txt.includes("pinned") ||
          txt.includes("promoted") ||
          txt.includes("ad")
        ) {
          continue;
        }
      }

      // tweet id + author from the time link
      const timeEl = art.querySelector("time");
      if (!timeEl) continue;
      const datetime = timeEl.getAttribute("datetime");
      if (!datetime) continue;
      const timeLink = timeEl.closest("a");
      const href = timeLink?.getAttribute("href") ?? "";
      const m = href.match(/^\/([^/]+)\/status\/(\d+)/);
      if (!m || !m[1] || !m[2]) continue;
      const author = m[1];
      const id = m[2];

      // text
      const textEl = art.querySelector('[data-testid="tweetText"]');
      const text = textEl ? (textEl as HTMLElement).innerText.trim() : "";

      // X collapses long tweets on timeline/search views, rendering only the
      // first ~280 visible chars inside [data-testid="tweetText"] plus a
      // "Show more" link. We detect that here so the scanner can refetch the
      // full text from the permalink. The testid is X's stable hook; we also
      // fall back to a literal "Show more" link inside the article in case
      // the testid changes.
      let truncated = !!art.querySelector(
        '[data-testid="tweet-text-show-more-link"]',
      );
      if (!truncated) {
        const links = Array.from(art.querySelectorAll("a, button, span"));
        truncated = links.some(
          (el) => (el.textContent || "").trim() === "Show more",
        );
      }

      // engagement
      const replyBtn = art.querySelector('[data-testid="reply"]');
      const retweetBtn = art.querySelector('[data-testid="retweet"]');
      const likeBtn = art.querySelector('[data-testid="like"]');
      const replies = parseCountFromAria(
        replyBtn?.getAttribute("aria-label") ?? null,
      );
      const retweets = parseCountFromAria(
        retweetBtn?.getAttribute("aria-label") ?? null,
      );
      const likes = parseCountFromAria(
        likeBtn?.getAttribute("aria-label") ?? null,
      );

      out.push({
        id,
        author,
        text,
        url: `https://x.com/${author}/status/${id}`,
        createdAt: datetime,
        likes,
        replies,
        retweets,
        truncated,
      });
    }

    // dedupe by id (search results sometimes show the same tweet twice)
    const seen = new Set<string>();
    return out.filter((t) => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });
  });
}

/**
 * Attempts to read the author's follower count from a user profile page.
 * Returns null if not parseable (the page layout sometimes hides this for
 * suspended/protected accounts).
 */
export async function parseFollowerCount(
  page: Page,
): Promise<number | null> {
  return await page.evaluate(() => {
    // The followers link looks like:
    //   <a href="/handle/verified_followers"> ... <span>1,234</span> Followers </a>
    // We grab the link to the verified followers page and parse the count.
    const candidates = Array.from(
      document.querySelectorAll<HTMLAnchorElement>('a[href$="/verified_followers"], a[href$="/followers"]'),
    );
    for (const a of candidates) {
      const txt = (a.textContent || "").trim();
      const m = txt.match(/([\d.,KMB]+)\s*Followers/i);
      if (!m || !m[1]) continue;
      const raw = m[1];
      const n = Number(raw.replace(/[,]/g, ""));
      if (!isNaN(n) && !/[KMB]/i.test(raw)) return n;
      // K/M/B abbreviated — best effort
      const num = parseFloat(raw);
      if (isNaN(num)) continue;
      if (/K/i.test(raw)) return Math.round(num * 1_000);
      if (/M/i.test(raw)) return Math.round(num * 1_000_000);
      if (/B/i.test(raw)) return Math.round(num * 1_000_000_000);
      return Math.round(num);
    }
    return null;
  });
}

/**
 * Reads the focal tweet's full text from a permalink page. On a standalone
 * tweet view (x.com/<author>/status/<id>) X renders the whole post body
 * inside [data-testid="tweetText"] without the "Show more" collapse, so we
 * just find the article whose status link matches the given id and read its
 * tweetText. Returns null if the article or text element isn't found —
 * caller should keep the truncated preview as fallback.
 */
async function parseTweetTextFromPermalink(
  page: Page,
  tweetId: string,
): Promise<string | null> {
  return await page.evaluate((id) => {
    const articles = Array.from(
      document.querySelectorAll('article[data-testid="tweet"]'),
    );
    for (const art of articles) {
      const link = art.querySelector(`a[href*="/status/${id}"]`);
      if (!link) continue;
      const textEl = art.querySelector('[data-testid="tweetText"]');
      if (!textEl) continue;
      return (textEl as HTMLElement).innerText.trim();
    }
    return null;
  }, tweetId);
}

/**
 * For each tweet flagged as truncated, navigate to its permalink and replace
 * its `.text` with the full post body. Mutates the items in place — callers
 * pass the same array they're about to upsert. Each visit costs one bucket
 * token plus a jittered delay to stay polite to X. Failures are logged and
 * fall back to the truncated preview.
 *
 * The caller already holds `withPage`, so we navigate the same shared page.
 * That destroys the original search/timeline state, which is fine: by the
 * time this is called, parsing is done and we only need the permalink view.
 */
export async function expandTruncatedTweets(
  page: Page,
  bucket: TokenBucket,
  tweets: ParsedTweet[],
): Promise<void> {
  for (const t of tweets) {
    if (!t.truncated) continue;
    await bucket.acquire();
    try {
      await page.goto(t.url, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await page
        .waitForSelector('article[data-testid="tweet"]', { timeout: 15000 })
        .catch(() => undefined);
      const full = await parseTweetTextFromPermalink(page, t.id);
      if (full && full.length > t.text.length) t.text = full;
    } catch (e) {
      console.warn(
        `[scan] full-text fetch failed for ${t.id}: ${(e as Error).message}`,
      );
    }
    // Pace permalink visits so a single scan doesn't blast 20 requests
    // back-to-back. The bucket already caps overall rate; this just spaces
    // them within the scan.
    await jitteredSleep(800, 50);
  }
}

/**
 * Returns true if the page looks like a logged-in X view.
 * False if redirected to /login or showing a login wall.
 */
export async function isLoggedIn(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    if (location.pathname.startsWith("/i/flow/login")) return false;
    if (location.pathname === "/login" || location.pathname === "/i/login")
      return false;
    if (document.querySelector('[data-testid="loginButton"]')) return false;
    if (document.querySelector('[data-testid="SignupButton"]')) return false;
    // Logged-in users always have the side nav with "AccountSwitcher"
    return !!document.querySelector('[data-testid="AppTabBar_Home_Link"]');
  });
}
