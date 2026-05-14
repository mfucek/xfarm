import type { Database } from "bun:sqlite";
import { nowIso } from "./schema.ts";

// Seed the keywords table from config.yaml on first boot only. Once the table
// has any rows, the DB is the source of truth — re-running with a yaml entry
// the user deleted in the TUI used to resurrect it on every restart.
export function syncKeywords(db: Database, queries: string[]): void {
  const row = db
    .prepare("SELECT 1 FROM keywords LIMIT 1")
    .get() as { 1: number } | undefined;
  if (row) return;
  const stmt = db.prepare("INSERT OR IGNORE INTO keywords(query) VALUES (?)");
  const tx = db.transaction((qs: string[]) => {
    for (const q of qs) stmt.run(q);
  });
  tx(queries);
}

export function addKeyword(db: Database, q: string): boolean {
  const trimmed = q.trim();
  if (!trimmed) return false;
  const r = db
    .prepare("INSERT OR IGNORE INTO keywords(query) VALUES (?)")
    .run(trimmed);
  return r.changes > 0;
}

export function removeKeyword(db: Database, q: string): boolean {
  const r = db.prepare("DELETE FROM keywords WHERE query = ?").run(q);
  return r.changes > 0;
}

export function listKeywords(
  db: Database,
): { query: string; last_scanned_at: string | null }[] {
  return db
    .prepare("SELECT query, last_scanned_at FROM keywords ORDER BY query ASC")
    .all() as { query: string; last_scanned_at: string | null }[];
}

export function oldestKeyword(
  db: Database,
): { query: string; last_scanned_at: string | null } | null {
  const row = db
    .prepare(
      `SELECT query, last_scanned_at FROM keywords
       ORDER BY last_scanned_at IS NULL DESC, last_scanned_at ASC
       LIMIT 1`,
    )
    .get();
  return row
    ? (row as { query: string; last_scanned_at: string | null })
    : null;
}

export function keywordsDue(db: Database, intervalSec: number): string[] {
  const cutoff = new Date(Date.now() - intervalSec * 1000).toISOString();
  const rows = db
    .prepare(
      `SELECT query FROM keywords
       WHERE last_scanned_at IS NULL OR last_scanned_at < ?
       ORDER BY COALESCE(last_scanned_at, '0') ASC`,
    )
    .all(cutoff) as { query: string }[];
  return rows.map((r) => r.query);
}

export function markKeywordScanned(db: Database, q: string): void {
  db.prepare("UPDATE keywords SET last_scanned_at=? WHERE query=?").run(
    nowIso(),
    q,
  );
}
