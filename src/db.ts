import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { TweetRow } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tweets (
    id                  TEXT PRIMARY KEY,
    author              TEXT NOT NULL,
    author_followers    INTEGER,
    text                TEXT NOT NULL,
    url                 TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    discovered_at       TEXT NOT NULL,
    source              TEXT NOT NULL,
    likes               INTEGER DEFAULT 0,
    replies             INTEGER DEFAULT 0,
    retweets            INTEGER DEFAULT 0,
    last_polled_at      TEXT,
    velocity            REAL,
    passed_gate_at      TEXT,
    llm_score           REAL,
    llm_reason          TEXT,
    llm_angle           TEXT,
    notified_at         TEXT,
    seen_at             TEXT,
    replied_at          TEXT
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
`;

const nowIso = (): string => new Date().toISOString();

export class DB {
  private db: Database;

  constructor(public readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA synchronous=NORMAL;");
    this.db.exec(SCHEMA);
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
}
