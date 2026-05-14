// Free, key-less web search the judge can call as a function tool. We hit the
// DuckDuckGo HTML endpoint (no JS / no JSON API), parse out the top results,
// and optionally fetch a few of those pages to extract readable text. Results
// are cached in-memory for a few hours so the same query during the same
// daemon run is free; requests are throttled to one per second so we don't
// look like a bot to DDG.

const DDG_HTML_URL = "https://html.duckduckgo.com/html/";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MIN_REQUEST_INTERVAL_MS = 1000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_RESULTS_RETURNED = 5;
const MAX_PAGES_FETCHED = 3;
const MAX_PAGE_TEXT_CHARS = 3000;

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

export class WebSearchClient {
  private cache = new Map<string, { at: number; data: string }>();
  private lastRequestAt = 0;

  async search(
    query: string,
    opts: { fetchPages?: boolean } = {},
  ): Promise<string> {
    const q = query.trim();
    if (!q) return "<web-search-error: empty query>";
    const fetchPages = Boolean(opts.fetchPages);
    const cacheKey = `${q}|${fetchPages ? "1" : "0"}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;

    let results: SearchResult[];
    try {
      results = await this.ddgSearch(q);
    } catch (e) {
      return `<web-search-error: ${(e as Error).message.slice(0, 200)}>`;
    }
    if (results.length === 0) {
      return `<web-search: no results for "${q.slice(0, 80)}">`;
    }

    const top = results.slice(0, MAX_RESULTS_RETURNED);
    let output = formatResults(top);
    if (fetchPages) {
      const pages = await this.fetchTopPages(top.slice(0, MAX_PAGES_FETCHED));
      if (pages) output += "\n\n--- PAGE CONTENTS ---\n\n" + pages;
    }
    this.cache.set(cacheKey, { at: Date.now(), data: output });
    return output;
  }

  private async throttle(): Promise<void> {
    const wait = this.lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }

  private async ddgSearch(query: string): Promise<SearchResult[]> {
    await this.throttle();
    const body = new URLSearchParams({ q: query }).toString();
    const resp = await fetch(DDG_HTML_URL, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`ddg http ${resp.status}`);
    const html = await resp.text();
    if (looksLikeAnomalyChallenge(html)) {
      throw new Error("ddg rate-limited (anomaly challenge)");
    }
    return parseDdgHtml(html);
  }

  private async fetchTopPages(results: SearchResult[]): Promise<string> {
    const pages: string[] = [];
    for (const r of results) {
      try {
        await this.throttle();
        const text = await fetchAndExtract(r.url);
        if (!text) continue;
        pages.push(
          `URL: ${r.url}\nTITLE: ${r.title}\n\n${text.slice(0, MAX_PAGE_TEXT_CHARS)}`,
        );
      } catch {
        // best-effort; one dead page shouldn't kill the whole search
      }
    }
    return pages.join("\n\n---\n\n");
  }
}

function formatResults(rs: SearchResult[]): string {
  return rs
    .map(
      (r, i) =>
        `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`,
    )
    .join("\n\n");
}

// DDG's HTML endpoint anchors each result with:
//   <a class="result__a" href="//duckduckgo.com/l/?uddg=<encoded-real-url>&...">Title</a>
// followed nearby by a snippet block (class has varied over time:
// result__snippet, result-snippet, result__description). We unwrap the
// `uddg=` redirect to recover the real URL.
export function parseDdgHtml(html: string): SearchResult[] {
  return parseDdgHtmlLoose(html);
}

function parseDdgHtmlLoose(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  // Pull every result__a anchor; then try to find a nearby snippet via several
  // class variants DDG has used over the years (result__snippet, result-snippet,
  // result__description). Snippet may be missing — that's OK, title+URL still
  // carries signal.
  const linkRe = /<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetClassRe =
    /<(?:a|div|span)[^>]*class="[^"]*\b(?:result__snippet|result-snippet|result__description)\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/g;
  const snippetPositions: { start: number; text: string }[] = [];
  let sm: RegExpExecArray | null = snippetClassRe.exec(html);
  while (sm) {
    snippetPositions.push({
      start: sm.index,
      text: stripTags(decodeEntities(sm[1] ?? "")).trim(),
    });
    sm = snippetClassRe.exec(html);
  }
  let m: RegExpExecArray | null = linkRe.exec(html);
  while (m) {
    const url = unwrapDdgRedirect(decodeEntities(m[1] ?? ""));
    const title = stripTags(decodeEntities(m[2] ?? "")).trim();
    // Snippet: the nearest snippet block AFTER this link, within 1500 chars.
    const linkEnd = (m.index ?? 0) + m[0].length;
    const nearest = snippetPositions.find(
      (p) => p.start > linkEnd && p.start - linkEnd < 1500,
    );
    const snippet = nearest?.text ?? "";
    if (url && title) out.push({ url, title, snippet });
    m = linkRe.exec(html);
  }
  return out;
}

/** Detect DDG's anti-bot interstitial. Returned with HTTP 202 + a body that
 * mentions "anomaly" and asks for a CAPTCHA. There are no result blocks in
 * this page, so the normal parser would just return []; we want a clearer
 * error so the agent can see it was rate-limited rather than zero-result. */
function looksLikeAnomalyChallenge(html: string): boolean {
  return (
    html.includes("anomaly-modal") ||
    /Unfortunately,\s*bots use DuckDuckGo too/i.test(html)
  );
}

function unwrapDdgRedirect(href: string): string {
  // Either /l/?uddg=https%3A%2F%2F… or //duckduckgo.com/l/?uddg=…
  const idx = href.indexOf("uddg=");
  if (idx < 0) {
    if (href.startsWith("//")) return "https:" + href;
    return href;
  }
  const tail = href.slice(idx + "uddg=".length);
  const end = tail.indexOf("&");
  const enc = end < 0 ? tail : tail.slice(0, end);
  try {
    return decodeURIComponent(enc);
  } catch {
    return enc;
  }
}

async function fetchAndExtract(url: string): Promise<string> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "follow",
    });
  } catch {
    return "";
  }
  if (!resp.ok) return "";
  const ct = resp.headers.get("content-type") ?? "";
  if (ct && !/html|text/i.test(ct)) return "";
  // Cap raw payload at 200KB so a giant page can't blow up memory.
  const reader = resp.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  const MAX_BYTES = 200_000;
  while (total < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  try { await reader.cancel(); } catch { /* ignore */ }
  const html = new TextDecoder("utf-8", { fatal: false }).decode(
    Buffer.concat(chunks.map((c) => Buffer.from(c))),
  );
  return extractReadableText(html);
}

/** Strip scripts/styles/nav junk, drop tags, collapse whitespace. Crude but
 * keyword/snippet extraction is what the judge actually needs, not perfect
 * article reconstruction. */
export function extractReadableText(html: string): string {
  let s = html;
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ");
  s = s.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ");
  // Replace common block-level closes with newlines so paragraphs survive.
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|br)\b[^>]*>/gi, "\n");
  s = stripTags(s);
  s = decodeEntities(s);
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/\n[ \t]+/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "");
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => named[name.toLowerCase()] ?? m);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
