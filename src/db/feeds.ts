import type { Database } from "bun:sqlite";
import { nowIso } from "./schema.ts";

/** Idempotent upsert. Updates interval_sec but preserves last_scanned_at. */
export function syncFeeds(
  db: Database,
  feeds: { name: string; interval_sec: number }[],
): void {
  const stmt = db.prepare(
    `INSERT INTO feeds(name, interval_sec) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET interval_sec=excluded.interval_sec`,
  );
  const tx = db.transaction(
    (rows: { name: string; interval_sec: number }[]) => {
      for (const r of rows) stmt.run(r.name, r.interval_sec);
    },
  );
  tx(feeds);
}

export function oldestFeed(
  db: Database,
): { name: string; interval_sec: number; last_scanned_at: string | null } | null {
  const row = db
    .prepare(
      `SELECT name, interval_sec, last_scanned_at FROM feeds
       ORDER BY last_scanned_at IS NULL DESC, last_scanned_at ASC
       LIMIT 1`,
    )
    .get();
  return row
    ? (row as {
        name: string;
        interval_sec: number;
        last_scanned_at: string | null;
      })
    : null;
}

export function listFeeds(
  db: Database,
): { name: string; interval_sec: number; last_scanned_at: string | null }[] {
  return db
    .prepare("SELECT name, interval_sec, last_scanned_at FROM feeds ORDER BY name ASC")
    .all() as {
    name: string;
    interval_sec: number;
    last_scanned_at: string | null;
  }[];
}

export function markFeedScanned(db: Database, name: string): void {
  db.prepare("UPDATE feeds SET last_scanned_at=? WHERE name=?").run(
    nowIso(),
    name,
  );
}
