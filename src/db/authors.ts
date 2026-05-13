import type { Database } from "bun:sqlite";
import { nowIso } from "./schema.ts";

export function syncAuthors(
  db: Database,
  rows: { handle: string; tier: number }[],
): void {
  const stmt = db.prepare(
    `INSERT INTO authors(handle, tier) VALUES (?, ?)
     ON CONFLICT(handle) DO UPDATE SET tier=excluded.tier`,
  );
  const tx = db.transaction((items: { handle: string; tier: number }[]) => {
    for (const r of items) stmt.run(r.handle, r.tier);
  });
  tx(rows);
}

export function authorTier(db: Database, handle: string): number | null {
  const row = db
    .prepare("SELECT tier FROM authors WHERE handle = ?")
    .get(handle) as { tier: number } | undefined;
  return row?.tier ?? null;
}

/** Author with the oldest last_scanned_at (NULL counts as oldest). */
export function oldestAuthor(
  db: Database,
): { handle: string; tier: number; last_scanned_at: string | null } | null {
  const row = db
    .prepare(
      `SELECT handle, tier, last_scanned_at FROM authors
       ORDER BY last_scanned_at IS NULL DESC, last_scanned_at ASC
       LIMIT 1`,
    )
    .get();
  return row
    ? (row as { handle: string; tier: number; last_scanned_at: string | null })
    : null;
}

export function authorsDue(
  db: Database,
  intervalSec: number,
): { handle: string; tier: number }[] {
  const cutoff = new Date(Date.now() - intervalSec * 1000).toISOString();
  return db
    .prepare(
      `SELECT handle, tier FROM authors
       WHERE last_scanned_at IS NULL OR last_scanned_at < ?
       ORDER BY COALESCE(last_scanned_at, '0') ASC`,
    )
    .all(cutoff) as { handle: string; tier: number }[];
}

export function markAuthorScanned(db: Database, handle: string): void {
  db.prepare("UPDATE authors SET last_scanned_at=? WHERE handle=?").run(
    nowIso(),
    handle,
  );
}
