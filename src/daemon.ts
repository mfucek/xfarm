import { loadConfig } from "./config.ts";
import { DB } from "./db.ts";
import { Judge, judgeLoop } from "./judge.ts";
import { clearPid, isDaemonRunning, readPid, writePid } from "./lifecycle.ts";
import { notifyLoop } from "./notifier.ts";
import { Browser } from "./scraper/browser.ts";
import { watchlistLoop } from "./scraper/account-scan.ts";
import { keywordLoop } from "./scraper/keyword-scan.ts";
import { TokenBucket } from "./scraper/rate-limit.ts";
import { trackerLoop } from "./scraper/velocity-tracker.ts";

export async function runDaemon(): Promise<void> {
  if (isDaemonRunning()) {
    console.error(
      `[daemon] already running (PID ${readPid()}). Stop it first: bun run src/cli.ts stop`,
    );
    process.exit(1);
  }

  const cfg = loadConfig();
  console.log(`[daemon] starting (PID ${process.pid}, db=${cfg.storage.db_path})`);
  writePid(process.pid);

  const db = new DB(cfg.storage.db_path);
  db.syncAuthors(cfg.watchlist.authors);
  db.syncKeywords(cfg.keywords.queries);

  const browser = new Browser(cfg);
  await browser.start();
  console.log(`[daemon] burner loaded: @${browser.burnerUsername}`);

  const bucket = new TokenBucket(cfg.scraper.max_requests_per_minute);
  const judge = new Judge(cfg);
  const ac = new AbortController();
  const { signal } = ac;

  const shutdown = async (sig: string) => {
    console.log(`[daemon] ${sig} received — shutting down`);
    ac.abort();
    await browser.stop();
    db.close();
    clearPid();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await Promise.all([
    watchlistLoop(browser, db, cfg, bucket, signal).catch((e) =>
      console.error("[watchlist] fatal:", e),
    ),
    keywordLoop(browser, db, cfg, bucket, signal).catch((e) =>
      console.error("[keyword] fatal:", e),
    ),
    trackerLoop(browser, db, cfg, bucket, signal).catch((e) =>
      console.error("[tracker] fatal:", e),
    ),
    judgeLoop(judge, db, signal).catch((e) =>
      console.error("[judge] fatal:", e),
    ),
    notifyLoop(db, cfg, signal).catch((e) =>
      console.error("[notifier] fatal:", e),
    ),
  ]);
}
