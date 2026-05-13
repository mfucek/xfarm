import type { Database } from "bun:sqlite";
import type { SuggestionRow, TweetRow } from "../types.ts";
import { nowIso } from "./schema.ts";

export function unchunkedTweetCount(db: Database): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM tweets WHERE suggestion_chunk_id IS NULL")
    .get() as { n: number };
  return row.n;
}

/**
 * Atomically claim the next `size` oldest unchunked tweets into a new chunk.
 * Returns the chunk id + tweet rows, or null if there are fewer than `size`
 * unchunked tweets.
 */
export function claimNextSuggestionChunk(
  db: Database,
  size: number,
): { chunkId: number; tweets: TweetRow[] } | null {
  const tx = db.transaction(() => {
    const avail = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM tweets WHERE suggestion_chunk_id IS NULL",
        )
        .get() as { n: number }
    ).n;
    if (avail < size) return null;
    const created = db
      .prepare(
        `INSERT INTO suggestion_chunks(generated_at, tweet_count, status)
         VALUES (?, ?, 'pending') RETURNING id`,
      )
      .get(nowIso(), size) as { id: number };
    db.prepare(
      `UPDATE tweets SET suggestion_chunk_id = ?
       WHERE id IN (
         SELECT id FROM tweets
         WHERE suggestion_chunk_id IS NULL
         ORDER BY discovered_at ASC
         LIMIT ?
       )`,
    ).run(created.id, size);
    const tweets = db
      .prepare(
        "SELECT * FROM tweets WHERE suggestion_chunk_id = ? ORDER BY discovered_at ASC",
      )
      .all(created.id) as TweetRow[];
    return { chunkId: created.id, tweets };
  });
  return tx();
}

export function markChunkJudged(db: Database, chunkId: number): void {
  db.prepare("UPDATE suggestion_chunks SET status='judged' WHERE id=?").run(
    chunkId,
  );
}

export function markChunkFailed(
  db: Database,
  chunkId: number,
  err: string,
): void {
  db.prepare(
    "UPDATE suggestion_chunks SET status='failed', error=? WHERE id=?",
  ).run(err.slice(0, 500), chunkId);
}

export function insertSuggestions(
  db: Database,
  chunkId: number,
  rows: {
    verdict: "add" | "remove" | "change";
    keyword: string;
    replacement?: string | null;
    reason: string;
  }[],
): void {
  const stmt = db.prepare(
    `INSERT INTO suggestions(chunk_id, verdict, keyword, replacement, reason, state, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
  );
  const now = nowIso();
  const tx = db.transaction(() => {
    for (const r of rows) {
      if (!r.keyword || !r.keyword.trim()) continue;
      if (
        r.verdict !== "add" &&
        r.verdict !== "remove" &&
        r.verdict !== "change"
      )
        continue;
      if (r.verdict === "change" && (!r.replacement || !r.replacement.trim()))
        continue;
      const repl = r.verdict === "change" ? (r.replacement ?? "").trim() : null;
      stmt.run(chunkId, r.verdict, r.keyword.trim(), repl, r.reason ?? "", now);
    }
  });
  tx();
}

export function listPendingSuggestions(db: Database): SuggestionRow[] {
  return db
    .prepare(
      `SELECT id, chunk_id, verdict, keyword, replacement, reason, state, created_at, resolved_at
       FROM suggestions
       WHERE state = 'pending'
       ORDER BY created_at DESC, id DESC`,
    )
    .all() as SuggestionRow[];
}

export function resolveSuggestion(
  db: Database,
  id: number,
  state: "accepted" | "rejected",
): SuggestionRow | null {
  const row = db
    .prepare(
      `UPDATE suggestions SET state=?, resolved_at=? WHERE id=? AND state='pending'
       RETURNING id, chunk_id, verdict, keyword, replacement, reason, state, created_at, resolved_at`,
    )
    .get(state, nowIso(), id) as SuggestionRow | undefined;
  return row ?? null;
}

export function resolveAllPendingSuggestions(
  db: Database,
  state: "accepted" | "rejected",
): SuggestionRow[] {
  return db
    .prepare(
      `UPDATE suggestions SET state=?, resolved_at=? WHERE state='pending'
       RETURNING id, chunk_id, verdict, keyword, replacement, reason, state, created_at, resolved_at`,
    )
    .all(state, nowIso()) as SuggestionRow[];
}

/**
 * Tweets from the suggestion's chunk that are likely the evidence behind it:
 * either pulled directly by `keyword:<keyword>` or with the keyword substring
 * in the text. Falls back to top-engaged tweets in the chunk if nothing
 * matches (useful for ADD suggestions whose proposed keyword doesn't appear
 * verbatim in the posts).
 */
export function fetchSuggestionEvidence(
  db: Database,
  chunkId: number,
  keyword: string,
  limit = 5,
): TweetRow[] {
  const src = `keyword:${keyword}`;
  const like = `%${keyword.toLowerCase()}%`;
  const rows = db
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
  return db
    .prepare(
      `SELECT * FROM tweets WHERE suggestion_chunk_id = ?
       ORDER BY (COALESCE(likes,0) + COALESCE(replies,0) + COALESCE(retweets,0)) DESC,
                discovered_at DESC
       LIMIT ?`,
    )
    .all(chunkId, limit) as TweetRow[];
}
