import type { Database } from "bun:sqlite";

export type Stats = {
  tweets_total: number;
  active: number;
  pending_judge: number;
  notified: number;
  seen: number;
  watchlist: number;
  keywords: number;
  ask_naumu_calls: number;
  web_search_calls: number;
};

export function stats(db: Database): Stats {
  const one = <T>(sql: string): T =>
    (db.prepare(sql).get() as { n: number }).n as unknown as T;
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
    watchlist: one<number>("SELECT COUNT(*) AS n FROM authors"),
    keywords: one<number>("SELECT COUNT(*) AS n FROM keywords"),
    ask_naumu_calls: getCounter(db, "ask_naumu"),
    web_search_calls: getCounter(db, "web_search"),
  };
}

export function bumpCounter(db: Database, name: string): void {
  db.prepare(
    `INSERT INTO counters(name, value) VALUES (?, 1)
     ON CONFLICT(name) DO UPDATE SET value = value + 1`,
  ).run(name);
}

export function getCounter(db: Database, name: string): number {
  const row = db
    .prepare("SELECT value FROM counters WHERE name = ?")
    .get(name) as { value: number } | undefined;
  return row?.value ?? 0;
}

export type Activity = {
  scraped: number[];
  surfaced: number[];
  scrapedTotal: number;
  surfacedTotal: number;
};

/**
 * Bucketed scrape/surface activity over the last `windowSec` seconds. Returns
 * equal-width buckets ordered oldest → newest plus totals.
 */
export function recentActivity(
  db: Database,
  windowSec: number,
  buckets: number,
): Activity {
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

  const discoveredRows = db
    .prepare("SELECT discovered_at FROM tweets WHERE discovered_at >= ?")
    .all(sinceIso) as { discovered_at: string }[];
  for (const r of discoveredRows) place(r.discovered_at, scraped);

  const surfacedRows = db
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
