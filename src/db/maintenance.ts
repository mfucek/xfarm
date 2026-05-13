import type { Database } from "bun:sqlite";

/**
 * Reset last_scanned_at on every author/keyword/feed so the unified scheduler
 * treats them all as never-scanned. Useful when you've just added a batch and
 * want them rotated in immediately. Returns the total number of rows
 * affected.
 */
export function clearScanCooldowns(db: Database): number {
  const a = db.prepare("UPDATE authors SET last_scanned_at = NULL").run();
  const k = db.prepare("UPDATE keywords SET last_scanned_at = NULL").run();
  const f = db.prepare("UPDATE feeds SET last_scanned_at = NULL").run();
  return a.changes + k.changes + f.changes;
}

/**
 * Delete tweets with 0 likes that were posted more than `minAgeSec` seconds
 * ago. Returns the number of rows deleted.
 */
export function clearLowEngagementOldTweets(
  db: Database,
  minAgeSec: number,
): number {
  const cutoff = new Date(Date.now() - minAgeSec * 1000).toISOString();
  const r = db
    .prepare(
      "DELETE FROM tweets WHERE COALESCE(likes, 0) = 0 AND created_at < ?",
    )
    .run(cutoff);
  return r.changes;
}

/**
 * Wipe all suggester history: unchunk every tweet, drop every chunk and
 * suggestion. The suggester will re-process tweets from scratch on its next
 * tick. Returns the number of tweets that were re-marked unchunked.
 */
export function clearSuggestionsHistory(db: Database): number {
  const tx = db.transaction(() => {
    const t = db
      .prepare(
        "UPDATE tweets SET suggestion_chunk_id = NULL WHERE suggestion_chunk_id IS NOT NULL",
      )
      .run();
    db.prepare("DELETE FROM suggestions").run();
    db.prepare("DELETE FROM suggestion_chunks").run();
    return t.changes;
  });
  return tx();
}
