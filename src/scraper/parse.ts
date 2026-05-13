import type { Page } from "playwright";
import type { ScrapedTweet } from "../types.ts";

/**
 * Extracts visible tweets from the current page. Runs in the browser context
 * via page.evaluate. Returns tweets in DOM order.
 *
 * Skips retweets, pinned tweets, and ads. Engagement counts come from
 * aria-labels (more reliable than the K/M-abbreviated visible text).
 */
export async function parseTweetsOnPage(
  page: Page,
): Promise<Omit<ScrapedTweet, "authorFollowers">[]> {
  return await page.evaluate(() => {
    const out: Omit<ScrapedTweet, "authorFollowers">[] = [];

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
