import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SuggestionRow, TweetRow } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tweets (
    id                    TEXT PRIMARY KEY,
    author                TEXT NOT NULL,
    author_followers      INTEGER,
    text                  TEXT NOT NULL,
    url                   TEXT NOT NULL,
    created_at            TEXT NOT NULL,
    discovered_at         TEXT NOT NULL,
    source                TEXT NOT NULL,
    likes                 INTEGER DEFAULT 0,
    replies               INTEGER DEFAULT 0,
    retweets              INTEGER DEFAULT 0,
    last_polled_at        TEXT,
    velocity              REAL,
    passed_gate_at        TEXT,
    llm_score             REAL,
    llm_reason            TEXT,
    llm_angle             TEXT,
    notified_at           TEXT,
    seen_at               TEXT,
    replied_at            TEXT,
    suggestion_chunk_id   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tweets_active
    ON tweets(seen_at, llm_score DESC) WHERE seen_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tweets_tracking
    ON tweets(created_at) WHERE seen_at IS NULL;

CREATE TABLE IF NOT EXISTS authors (
    handle              TEXT PRIMARY KEY,
    tier                INTEGER DEFAULT 2,
    last_scanned_at     TEXT
);

CREATE TABLE IF NOT EXISTS keywords (
    query               TEXT PRIMARY KEY,
    last_scanned_at     TEXT
);

CREATE TABLE IF NOT EXISTS feeds (
    name                TEXT PRIMARY KEY,
    interval_sec        INTEGER NOT NULL,
    last_scanned_at     TEXT
);

CREATE TABLE IF NOT EXISTS suggestion_chunks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    generated_at    TEXT NOT NULL,
    tweet_count     INTEGER NOT NULL,
    status          TEXT NOT NULL,   -- 'pending' | 'judged' | 'failed'
    error           TEXT
);

CREATE TABLE IF NOT EXISTS suggestions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    chunk_id        INTEGER NOT NULL REFERENCES suggestion_chunks(id),
    verdict         TEXT NOT NULL,   -- 'add' | 'remove' | 'change'
    keyword         TEXT NOT NULL,
    replacement     TEXT,            -- only for verdict='change': the new keyword
    reason          TEXT NOT NULL,
    state           TEXT NOT NULL,   -- 'pending' | 'accepted' | 'rejected'
    created_at      TEXT NOT NULL,
    resolved_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_suggestions_pending
    ON suggestions(state, created_at DESC) WHERE state = 'pending';
`;

const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "tweets.suggestion_chunk_id",
    sql: "ALTER TABLE tweets ADD COLUMN suggestion_chunk_id INTEGER",
  },
  {
    name: "suggestions.replacement",
    sql: "ALTER TABLE suggestions ADD COLUMN replacement TEXT",
  },
];

const nowIso = (): string => new Date().toISOString();

export class DB {
  private db: Database;

  constructor(public readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA synchronous=NORMAL;");
    this.db.exec(SCHEMA);
    this.runMigrations();
    // Indexes that reference migration-added columns go here so they survive
    // a first-boot on a pre-existing DB.
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_tweets_unchunked
         ON tweets(discovered_at) WHERE suggestion_chunk_id IS NULL`,
    );
  }

  private runMigrations(): void {
    // Pre-existing databases lack columns added after v0.2. ALTER TABLE …
    // ADD COLUMN is idempotent in spirit but errors if the column exists, so
    // detect & skip per-migration. Migration names encode `<table>.<column>`.
    const tableCols = new Map<string, Set<string>>();
    const cols = (table: string): Set<string> => {
      let s = tableCols.get(table);
      if (s) return s;
      const rows = this.db
        .prepare(`PRAGMA table_info(${table})`)
        .all() as { name: string }[];
      s = new Set(rows.map((c) => c.name));
      tableCols.set(table, s);
      return s;
    };
    for (const m of MIGRATIONS) {
      const [table, col] = m.name.split(".");
      if (table && col && cols(table).has(col)) continue;
      try {
        this.db.exec(m.sql);
        if (table) tableCols.delete(table); // force re-read next iteration
      } catch (e) {
        // Race or already-applied via a different path — log and continue.
        console.warn(`[db] migration ${m.name} skipped: ${(e as Error).message}`);
      }
    }
  }

  close(): void {
    this.db.close();
  }

  // ---------- authors ----------

  syncAuthors(authors: { handle: string; tier: number }[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO authors(handle, tier) VALUES (?, ?)
       ON CONFLICT(handle) DO UPDATE SET tier=excluded.tier`,
    );
    const tx = this.db.transaction((rows: { handle: string; tier: number }[]) => {
      for (const r of rows) stmt.run(r.handle, r.tier);
    });
    tx(authors);
  }

  authorTier(handle: string): number | null {
    const row = this.db
      .prepare("SELECT tier FROM authors WHERE handle = ?")
      .get(handle) as { tier: number } | undefined;
    return row?.tier ?? null;
  }

  /** Author with the oldest last_scanned_at (NULL counts as oldest). */
  oldestAuthor(): { handle: string; tier: number; last_scanned_at: string | null } | null {
    const row = this.db
      .prepare(
        `SELECT handle, tier, last_scanned_at FROM authors
         ORDER BY last_scanned_at IS NULL DESC, last_scanned_at ASC
         LIMIT 1`,
      )
      .get();
    return row ? (row as { handle: string; tier: number; last_scanned_at: string | null }) : null;
  }

  authorsDue(intervalSec: number): { handle: string; tier: number }[] {
    const cutoff = new Date(Date.now() - intervalSec * 1000).toISOString();
    return this.db
      .prepare(
        `SELECT handle, tier FROM authors
         WHERE last_scanned_at IS NULL OR last_scanned_at < ?
         ORDER BY COALESCE(last_scanned_at, '0') ASC`,
      )
      .all(cutoff) as { handle: string; tier: number }[];
  }

  markAuthorScanned(handle: string): void {
    this.db
      .prepare("UPDATE authors SET last_scanned_at=? WHERE handle=?")
      .run(nowIso(), handle);
  }

  // ---------- keywords ----------

  syncKeywords(queries: string[]): void {
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO keywords(query) VALUES (?)",
    );
    const tx = this.db.transaction((qs: string[]) => {
      for (const q of qs) stmt.run(q);
    });
    tx(queries);
  }

  addKeyword(q: string): boolean {
    const trimmed = q.trim();
    if (!trimmed) return false;
    const r = this.db
      .prepare("INSERT OR IGNORE INTO keywords(query) VALUES (?)")
      .run(trimmed);
    return r.changes > 0;
  }

  removeKeyword(q: string): boolean {
    const r = this.db
      .prepare("DELETE FROM keywords WHERE query = ?")
      .run(q);
    return r.changes > 0;
  }

  listKeywords(): { query: string; last_scanned_at: string | null }[] {
    return this.db
      .prepare(
        "SELECT query, last_scanned_at FROM keywords ORDER BY query ASC",
      )
      .all() as { query: string; last_scanned_at: string | null }[];
  }

  oldestKeyword(): { query: string; last_scanned_at: string | null } | null {
    const row = this.db
      .prepare(
        `SELECT query, last_scanned_at FROM keywords
         ORDER BY last_scanned_at IS NULL DESC, last_scanned_at ASC
         LIMIT 1`,
      )
      .get();
    return row ? (row as { query: string; last_scanned_at: string | null }) : null;
  }

  keywordsDue(intervalSec: number): string[] {
    const cutoff = new Date(Date.now() - intervalSec * 1000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT query FROM keywords
         WHERE last_scanned_at IS NULL OR last_scanned_at < ?
         ORDER BY COALESCE(last_scanned_at, '0') ASC`,
      )
      .all(cutoff) as { query: string }[];
    return rows.map((r) => r.query);
  }

  markKeywordScanned(q: string): void {
    this.db
      .prepare("UPDATE keywords SET last_scanned_at=? WHERE query=?")
      .run(nowIso(), q);
  }

  // ---------- feeds ----------

  /** Idempotent upsert. Updates interval_sec but preserves last_scanned_at. */
  syncFeeds(feeds: { name: string; interval_sec: number }[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO feeds(name, interval_sec) VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET interval_sec=excluded.interval_sec`,
    );
    const tx = this.db.transaction((rows: { name: string; interval_sec: number }[]) => {
      for (const r of rows) stmt.run(r.name, r.interval_sec);
    });
    tx(feeds);
  }

  oldestFeed(): { name: string; interval_sec: number; last_scanned_at: string | null } | null {
    const row = this.db
      .prepare(
        `SELECT name, interval_sec, last_scanned_at FROM feeds
         ORDER BY last_scanned_at IS NULL DESC, last_scanned_at ASC
         LIMIT 1`,
      )
      .get();
    return row
      ? (row as { name: string; interval_sec: number; last_scanned_at: string | null })
      : null;
  }

  listFeeds(): { name: string; interval_sec: number; last_scanned_at: string | null }[] {
    return this.db
      .prepare("SELECT name, interval_sec, last_scanned_at FROM feeds ORDER BY name ASC")
      .all() as { name: string; interval_sec: number; last_scanned_at: string | null }[];
  }

  markFeedScanned(name: string): void {
    this.db
      .prepare("UPDATE feeds SET last_scanned_at=? WHERE name=?")
      .run(nowIso(), name);
  }

  /** Tracked tweet (fresh + unseen) overdue for velocity re-poll. */
  oldestStaleTrackedTweet(
    intervalSec: number,
    maxAgeHours: number,
  ): { id: string } | null {
    const ageCutoff = new Date(Date.now() - maxAgeHours * 3600 * 1000).toISOString();
    const pollCutoff = new Date(Date.now() - intervalSec * 1000).toISOString();
    const row = this.db
      .prepare(
        `SELECT id FROM tweets
         WHERE created_at > ?
           AND seen_at IS NULL
           AND (last_polled_at IS NULL OR last_polled_at < ?)
         ORDER BY last_polled_at IS NULL DESC, last_polled_at ASC
         LIMIT 1`,
      )
      .get(ageCutoff, pollCutoff);
    return row ? (row as { id: string }) : null;
  }

  // ---------- tweets ----------

  /** Returns true if newly inserted, false if updated. */
  upsertTweet(t: {
    id: string;
    author: string;
    authorFollowers: number | null;
    text: string;
    url: string;
    createdAt: string;
    source: string;
    likes: number;
    replies: number;
    retweets: number;
  }): boolean {
    const exists = this.db
      .prepare("SELECT 1 FROM tweets WHERE id = ?")
      .get(t.id);
    const now = nowIso();
    if (!exists) {
      this.db
        .prepare(
          `INSERT INTO tweets(
             id, author, author_followers, text, url, created_at,
             discovered_at, source, likes, replies, retweets, last_polled_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          t.id,
          t.author,
          t.authorFollowers,
          t.text,
          t.url,
          t.createdAt,
          now,
          t.source,
          t.likes,
          t.replies,
          t.retweets,
          now,
        );
      return true;
    }
    this.db
      .prepare(
        `UPDATE tweets SET likes=?, replies=?, retweets=?, last_polled_at=? WHERE id=?`,
      )
      .run(t.likes, t.replies, t.retweets, now, t.id);
    return false;
  }

  updateEngagement(
    id: string,
    likes: number,
    replies: number,
    retweets: number,
    velocity: number,
  ): void {
    this.db
      .prepare(
        `UPDATE tweets
         SET likes=?, replies=?, retweets=?, velocity=?, last_polled_at=?
         WHERE id=?`,
      )
      .run(likes, replies, retweets, velocity, nowIso(), id);
  }

  markGatePassed(id: string): void {
    this.db
      .prepare(
        "UPDATE tweets SET passed_gate_at=COALESCE(passed_gate_at, ?) WHERE id=?",
      )
      .run(nowIso(), id);
  }

  markJudged(
    id: string,
    score: number,
    reason: string,
    angle: string,
  ): void {
    this.db
      .prepare(
        "UPDATE tweets SET llm_score=?, llm_reason=?, llm_angle=? WHERE id=?",
      )
      .run(score, reason, angle, id);
  }

  markNotified(id: string): void {
    this.db
      .prepare("UPDATE tweets SET notified_at=? WHERE id=?")
      .run(nowIso(), id);
  }

  markSeen(id: string): void {
    this.db
      .prepare("UPDATE tweets SET seen_at=? WHERE id=?")
      .run(nowIso(), id);
  }

  markReplied(id: string): void {
    const now = nowIso();
    this.db
      .prepare(
        "UPDATE tweets SET replied_at=?, seen_at=COALESCE(seen_at, ?) WHERE id=?",
      )
      .run(now, now, id);
  }

  fetchTrackingSet(maxAgeHours: number): string[] {
    const cutoff = new Date(
      Date.now() - maxAgeHours * 3600 * 1000,
    ).toISOString();
    const rows = this.db
      .prepare(
        `SELECT id FROM tweets WHERE created_at > ? AND seen_at IS NULL`,
      )
      .all(cutoff) as { id: string }[];
    return rows.map((r) => r.id);
  }

  fetchDueForJudge(limit = 20): TweetRow[] {
    return this.db
      .prepare(
        `SELECT * FROM tweets
         WHERE passed_gate_at IS NOT NULL
           AND llm_score IS NULL
           AND seen_at IS NULL
         ORDER BY passed_gate_at ASC
         LIMIT ?`,
      )
      .all(limit) as TweetRow[];
  }

  fetchDueForNotify(threshold: number, limit = 5): TweetRow[] {
    return this.db
      .prepare(
        `SELECT * FROM tweets
         WHERE llm_score >= ?
           AND notified_at IS NULL
           AND seen_at IS NULL
         ORDER BY llm_score DESC
         LIMIT ?`,
      )
      .all(threshold, limit) as TweetRow[];
  }

  stats(): {
    tweets_total: number;
    active: number;
    pending_judge: number;
    notified: number;
    seen: number;
    replied: number;
    watchlist: number;
    keywords: number;
  } {
    const one = <T>(sql: string): T =>
      (this.db.prepare(sql).get() as { n: number }).n as unknown as T;
    return {
      tweets_total: one<number>("SELECT COUNT(*) AS n FROM tweets"),
      active: one<number>(
        "SELECT COUNT(*) AS n FROM tweets WHERE seen_at IS NULL AND passed_gate_at IS NOT NULL",
      ),
      pending_judge: one<number>(
        "SELECT COUNT(*) AS n FROM tweets WHERE passed_gate_at IS NOT NULL AND llm_score IS NULL AND seen_at IS NULL",
      ),
      notified: one<number>(
        "SELECT COUNT(*) AS n FROM tweets WHERE notified_at IS NOT NULL",
      ),
      seen: one<number>(
        "SELECT COUNT(*) AS n FROM tweets WHERE seen_at IS NOT NULL",
      ),
      replied: one<number>(
        "SELECT COUNT(*) AS n FROM tweets WHERE replied_at IS NOT NULL",
      ),
      watchlist: one<number>("SELECT COUNT(*) AS n FROM authors"),
      keywords: one<number>("SELECT COUNT(*) AS n FROM keywords"),
    };
  }

  /**
   * Bucketed scrape/surface activity over the last `windowSec` seconds.
   * Returns equal-width buckets ordered oldest → newest plus totals.
   */
  recentActivity(
    windowSec: number,
    buckets: number,
  ): { scraped: number[]; surfaced: number[]; scrapedTotal: number; surfacedTotal: number } {
    const sinceMs = Date.now() - windowSec * 1000;
    const sinceIso = new Date(sinceMs).toISOString();
    const bucketMs = (windowSec * 1000) / buckets;
    const scraped = new Array<number>(buckets).fill(0);
    const surfaced = new Array<number>(buckets).fill(0);

    const place = (iso: string, arr: number[]) => {
      const t = new Date(iso).getTime();
      const idx = Math.floor((t - sinceMs) / bucketMs);
      if (idx >= 0 && idx < buckets) arr[idx] = (arr[idx] ?? 0) + 1;
    };

    const discoveredRows = this.db
      .prepare("SELECT discovered_at FROM tweets WHERE discovered_at >= ?")
      .all(sinceIso) as { discovered_at: string }[];
    for (const r of discoveredRows) place(r.discovered_at, scraped);

    const surfacedRows = this.db
      .prepare(
        "SELECT passed_gate_at FROM tweets WHERE passed_gate_at IS NOT NULL AND passed_gate_at >= ?",
      )
      .all(sinceIso) as { passed_gate_at: string }[];
    for (const r of surfacedRows) place(r.passed_gate_at, surfaced);

    const sum = (a: number[]) => a.reduce((s, n) => s + n, 0);
    return {
      scraped,
      surfaced,
      scrapedTotal: sum(scraped),
      surfacedTotal: sum(surfaced),
    };
  }

  fetchActive(limit = 50): TweetRow[] {
    return this.db
      .prepare(
        `SELECT * FROM tweets
         WHERE seen_at IS NULL AND passed_gate_at IS NOT NULL
         ORDER BY llm_score IS NULL, llm_score DESC, discovered_at DESC
         LIMIT ?`,
      )
      .all(limit) as TweetRow[];
  }

  // ---------- suggestions ----------

  unchunkedTweetCount(): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM tweets WHERE suggestion_chunk_id IS NULL",
      )
      .get() as { n: number };
    return row.n;
  }

  /**
   * Atomically claim the next `size` oldest unchunked tweets into a new
   * chunk. Returns the chunk id + tweet rows, or null if there are fewer
   * than `size` unchunked tweets.
   */
  claimNextSuggestionChunk(
    size: number,
  ): { chunkId: number; tweets: TweetRow[] } | null {
    const tx = this.db.transaction(() => {
      const avail = (
        this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM tweets WHERE suggestion_chunk_id IS NULL",
          )
          .get() as { n: number }
      ).n;
      if (avail < size) return null;
      const created = this.db
        .prepare(
          `INSERT INTO suggestion_chunks(generated_at, tweet_count, status)
           VALUES (?, ?, 'pending') RETURNING id`,
        )
        .get(nowIso(), size) as { id: number };
      this.db
        .prepare(
          `UPDATE tweets SET suggestion_chunk_id = ?
           WHERE id IN (
             SELECT id FROM tweets
             WHERE suggestion_chunk_id IS NULL
             ORDER BY discovered_at ASC
             LIMIT ?
           )`,
        )
        .run(created.id, size);
      const tweets = this.db
        .prepare(
          "SELECT * FROM tweets WHERE suggestion_chunk_id = ? ORDER BY discovered_at ASC",
        )
        .all(created.id) as TweetRow[];
      return { chunkId: created.id, tweets };
    });
    return tx();
  }

  markChunkJudged(chunkId: number): void {
    this.db
      .prepare("UPDATE suggestion_chunks SET status='judged' WHERE id=?")
      .run(chunkId);
  }

  markChunkFailed(chunkId: number, err: string): void {
    this.db
      .prepare("UPDATE suggestion_chunks SET status='failed', error=? WHERE id=?")
      .run(err.slice(0, 500), chunkId);
  }

  insertSuggestions(
    chunkId: number,
    rows: {
      verdict: "add" | "remove" | "change";
      keyword: string;
      replacement?: string | null;
      reason: string;
    }[],
  ): void {
    const stmt = this.db.prepare(
      `INSERT INTO suggestions(chunk_id, verdict, keyword, replacement, reason, state, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    );
    const now = nowIso();
    const tx = this.db.transaction(() => {
      for (const r of rows) {
        if (!r.keyword || !r.keyword.trim()) continue;
        if (r.verdict !== "add" && r.verdict !== "remove" && r.verdict !== "change") continue;
        if (r.verdict === "change" && (!r.replacement || !r.replacement.trim())) continue;
        const repl =
          r.verdict === "change" ? (r.replacement ?? "").trim() : null;
        stmt.run(chunkId, r.verdict, r.keyword.trim(), repl, r.reason ?? "", now);
      }
    });
    tx();
  }

  listPendingSuggestions(): SuggestionRow[] {
    return this.db
      .prepare(
        `SELECT id, chunk_id, verdict, keyword, replacement, reason, state, created_at, resolved_at
         FROM suggestions
         WHERE state = 'pending'
         ORDER BY created_at DESC, id DESC`,
      )
      .all() as SuggestionRow[];
  }

  resolveSuggestion(id: number, state: "accepted" | "rejected"): SuggestionRow | null {
    const row = this.db
      .prepare(
        `UPDATE suggestions SET state=?, resolved_at=? WHERE id=? AND state='pending'
         RETURNING id, chunk_id, verdict, keyword, replacement, reason, state, created_at, resolved_at`,
      )
      .get(state, nowIso(), id) as SuggestionRow | undefined;
    return row ?? null;
  }

  resolveAllPendingSuggestions(state: "accepted" | "rejected"): SuggestionRow[] {
    return this.db
      .prepare(
        `UPDATE suggestions SET state=?, resolved_at=? WHERE state='pending'
         RETURNING id, chunk_id, verdict, keyword, replacement, reason, state, created_at, resolved_at`,
      )
      .all(state, nowIso()) as SuggestionRow[];
  }

  /**
   * Tweets from the suggestion's chunk that are likely the evidence behind
   * it: either pulled directly by `keyword:<keyword>` or with the keyword
   * substring in the text. Falls back to top-engaged tweets in the chunk if
   * nothing matches (useful for ADD suggestions whose proposed keyword
   * doesn't appear verbatim in the posts).
   */
  fetchSuggestionEvidence(
    chunkId: number,
    keyword: string,
    limit = 5,
  ): TweetRow[] {
    const src = `keyword:${keyword}`;
    const like = `%${keyword.toLowerCase()}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM tweets
         WHERE suggestion_chunk_id = ?
           AND (source = ? OR LOWER(text) LIKE ?)
         ORDER BY (COALESCE(likes,0) + COALESCE(replies,0) + COALESCE(retweets,0)) DESC,
                  discovered_at DESC
         LIMIT ?`,
      )
      .all(chunkId, src, like, limit) as TweetRow[];
    if (rows.length > 0) return rows;
    return this.db
      .prepare(
        `SELECT * FROM tweets WHERE suggestion_chunk_id = ?
         ORDER BY (COALESCE(likes,0) + COALESCE(replies,0) + COALESCE(retweets,0)) DESC,
                  discovered_at DESC
         LIMIT ?`,
      )
      .all(chunkId, limit) as TweetRow[];
  }
}
