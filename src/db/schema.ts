import type { Database } from "bun:sqlite";

export const SCHEMA = `
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
    llm_pitch             TEXT,
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

// ALTER TABLE … ADD COLUMN is idempotent in spirit but errors when the column
// exists. Names encode `<table>.<column>` so we can detect and skip.
const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "tweets.suggestion_chunk_id",
    sql: "ALTER TABLE tweets ADD COLUMN suggestion_chunk_id INTEGER",
  },
  {
    name: "suggestions.replacement",
    sql: "ALTER TABLE suggestions ADD COLUMN replacement TEXT",
  },
  {
    name: "tweets.llm_pitch",
    sql: "ALTER TABLE tweets ADD COLUMN llm_pitch TEXT",
  },
];

export function runMigrations(db: Database): void {
  const tableCols = new Map<string, Set<string>>();
  const cols = (table: string): Set<string> => {
    let s = tableCols.get(table);
    if (s) return s;
    const rows = db
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
      db.exec(m.sql);
      if (table) tableCols.delete(table);
    } catch (e) {
      console.warn(`[db] migration ${m.name} skipped: ${(e as Error).message}`);
    }
  }
}

export const nowIso = (): string => new Date().toISOString();
