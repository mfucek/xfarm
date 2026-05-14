import type { Database } from "bun:sqlite";
import type { TweetRow } from "../types.ts";
import { nowIso } from "./schema.ts";

/** Returns true if newly inserted, false if updated. */
export function upsertTweet(
  db: Database,
  t: {
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
  },
): boolean {
  const exists = db.prepare("SELECT 1 FROM tweets WHERE id = ?").get(t.id);
  const now = nowIso();
  if (!exists) {
    db.prepare(
      `INSERT INTO tweets(
         id, author, author_followers, text, url, created_at,
         discovered_at, source, likes, replies, retweets, last_polled_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
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
  db.prepare(
    `UPDATE tweets SET likes=?, replies=?, retweets=?, last_polled_at=? WHERE id=?`,
  ).run(t.likes, t.replies, t.retweets, now, t.id);
  return false;
}

export function updateEngagement(
  db: Database,
  id: string,
  likes: number,
  replies: number,
  retweets: number,
  velocity: number,
): void {
  db.prepare(
    `UPDATE tweets
     SET likes=?, replies=?, retweets=?, velocity=?, last_polled_at=?
     WHERE id=?`,
  ).run(likes, replies, retweets, velocity, nowIso(), id);
}

export function markGatePassed(db: Database, id: string): void {
  db.prepare(
    "UPDATE tweets SET passed_gate_at=COALESCE(passed_gate_at, ?) WHERE id=?",
  ).run(nowIso(), id);
}

export function markJudged(
  db: Database,
  id: string,
  score: number,
  reason: string,
  angle: string,
  pitchBullets: string[],
): void {
  const pitchJson =
    pitchBullets.length > 0 ? JSON.stringify(pitchBullets) : null;
  db.prepare(
    "UPDATE tweets SET llm_score=?, llm_reason=?, llm_angle=?, llm_pitch=? WHERE id=?",
  ).run(score, reason, angle, pitchJson, id);
}

export function markNotified(db: Database, id: string): void {
  db.prepare("UPDATE tweets SET notified_at=? WHERE id=?").run(nowIso(), id);
}

export function markSeen(db: Database, id: string): void {
  db.prepare("UPDATE tweets SET seen_at=? WHERE id=?").run(nowIso(), id);
}

export function markReplied(db: Database, id: string): void {
  const now = nowIso();
  db.prepare(
    "UPDATE tweets SET replied_at=?, seen_at=COALESCE(seen_at, ?) WHERE id=?",
  ).run(now, now, id);
}

export function markHidden(db: Database, id: string): void {
  db.prepare("UPDATE tweets SET hidden_at=? WHERE id=?").run(nowIso(), id);
}

export function fetchTrackingSet(db: Database, maxAgeHours: number): string[] {
  const cutoff = new Date(Date.now() - maxAgeHours * 3600 * 1000).toISOString();
  const rows = db
    .prepare(`SELECT id FROM tweets WHERE created_at > ? AND seen_at IS NULL`)
    .all(cutoff) as { id: string }[];
  return rows.map((r) => r.id);
}

export function fetchDueForJudge(db: Database, limit = 20): TweetRow[] {
  return db
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

export function fetchDueForNotify(
  db: Database,
  threshold: number,
  limit = 5,
): TweetRow[] {
  return db
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

export function fetchActive(
  db: Database,
  maxAgeHours: number,
  limit = 50,
): TweetRow[] {
  const cutoff = new Date(Date.now() - maxAgeHours * 3600 * 1000).toISOString();
  return db
    .prepare(
      `SELECT * FROM tweets
       WHERE passed_gate_at IS NOT NULL
         AND hidden_at IS NULL
         AND created_at > ?
       ORDER BY llm_score IS NULL, llm_score DESC, created_at DESC
       LIMIT ?`,
    )
    .all(cutoff, limit) as TweetRow[];
}

/** Scraped but unsurfaced tweets — the inverse of fetchActive. */
export function fetchNonCandidates(
  db: Database,
  maxAgeHours: number,
  limit = 50,
): TweetRow[] {
  const cutoff = new Date(Date.now() - maxAgeHours * 3600 * 1000).toISOString();
  return db
    .prepare(
      `SELECT * FROM tweets
       WHERE passed_gate_at IS NULL
         AND hidden_at IS NULL
         AND created_at > ?
       ORDER BY discovered_at DESC
       LIMIT ?`,
    )
    .all(cutoff, limit) as TweetRow[];
}

/** Tracked tweet (fresh + unseen) overdue for velocity re-poll. */
export function oldestStaleTrackedTweet(
  db: Database,
  intervalSec: number,
  maxAgeHours: number,
): { id: string } | null {
  const ageCutoff = new Date(
    Date.now() - maxAgeHours * 3600 * 1000,
  ).toISOString();
  const pollCutoff = new Date(Date.now() - intervalSec * 1000).toISOString();
  const row = db
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
