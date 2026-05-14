#!/usr/bin/env bun
import { Command } from "commander";
import chalk from "chalk";
import { DEFAULT_CONFIG_PATH, loadConfig } from "./config.ts";
import { DB } from "./db.ts";

const program = new Command();
program
  .name("xfarm")
  .description("Local CLI to surface X reply candidates")
  .version("0.2.0");

program
  .command("daemon")
  .description("Run the background scanner + judge + notifier")
  .action(async () => {
    const { runDaemon } = await import("./daemon.ts");
    await runDaemon();
  });

program
  .command("watch")
  .description("Open the live TUI of reply candidates (auto-starts daemon if not running)")
  .action(async () => {
    const { runTui } = await import("./tui/run.ts");
    await runTui();
  });

program
  .command("stop")
  .description("Stop the background daemon if running")
  .action(async () => {
    const { stopAndWait } = await import("./lifecycle.ts");
    const r = await stopAndWait(5000);
    if (r.state === "not_running") {
      console.log("daemon not running.");
    } else if (r.state === "stopped") {
      console.log(chalk.green(`daemon stopped (PID ${r.pid}).`));
    } else {
      console.log(
        chalk.yellow(
          `PID ${r.pid} still alive after 5s; check \`~/.xfarm/daemon.log\`.`,
        ),
      );
    }
  });

program
  .command("status")
  .description("Show daemon status")
  .action(async () => {
    const { isDaemonRunning, readPid, logFilePath } = await import("./lifecycle.ts");
    if (isDaemonRunning()) {
      console.log(chalk.green(`daemon running (PID ${readPid()})`));
      console.log(`logs: ${logFilePath()}`);
    } else {
      console.log(chalk.dim("daemon not running"));
    }
  });

program
  .command("notify-click <id> <url>")
  .description(
    "Internal: invoked when a macOS alert is clicked — marks the tweet seen and opens the URL",
  )
  .action(async (id: string, url: string) => {
    try {
      const cfg = loadConfig();
      const db = new DB(cfg.storage.db_path);
      try {
        db.markSeen(id);
      } finally {
        db.close();
      }
    } catch (e) {
      console.error("notify-click: mark-seen failed:", e);
    }
    const { spawn } = await import("node:child_process");
    await new Promise<void>((resolve) => {
      const p = spawn("open", [url], { stdio: "ignore" });
      p.on("close", () => resolve());
      p.on("error", () => resolve());
    });
  });

program
  .command("config-init")
  .description("Print the default config location")
  .action(() => {
    console.log(`Config path: ${chalk.bold(DEFAULT_CONFIG_PATH)}`);
    console.log(`Copy from:   ${chalk.bold("./config.example.yaml")}`);
  });

const session = program
  .command("session")
  .description("Burner-session utilities");

session
  .command("test")
  .description("Launch browser, load cookies, confirm we're logged in")
  .action(async () => {
    const { Browser } = await import("./scraper/browser.ts");
    const { isLoggedIn } = await import("./scraper/parse.ts");
    const cfg = loadConfig();
    const browser = new Browser(cfg);
    await browser.start();
    console.log(chalk.green("Burner cookies loaded:"), `@${browser.burnerUsername}`);
    try {
      const ok = await browser.withPage(async (page) => {
        await page.goto("https://x.com/home", {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        await new Promise((r) => setTimeout(r, 2500));
        return await isLoggedIn(page);
      });
      if (ok) {
        console.log(chalk.green("[OK] logged in — feed reachable"));
      } else {
        console.log(
          chalk.red(
            "[FAIL] not logged in. Cookies may be stale, or burner is being challenged. Try `xfarm session debug`.",
          ),
        );
      }
    } finally {
      await browser.stop();
    }
  });

session
  .command("open")
  .description(
    "Open a non-headless burner window with cookies injected (separate profile from daemon)",
  )
  .action(async () => {
    const { openBurnerWindow } = await import("./scraper/burner-window.ts");
    const cfg = loadConfig();
    await openBurnerWindow(cfg);
  });

session
  .command("debug")
  .description("Open a real Chrome window (headful) for manual login or troubleshooting")
  .action(async () => {
    const { Browser } = await import("./scraper/browser.ts");
    const cfg = loadConfig();
    // override to headful for visual debugging
    const debugCfg = {
      ...cfg,
      scraper: { ...cfg.scraper, headless: false },
    } as typeof cfg;
    const browser = new Browser(debugCfg);
    await browser.start();
    console.log(
      chalk.yellow(
        "Headful browser open. Navigate to x.com and inspect. Press Ctrl-C to close.",
      ),
    );
    await browser.withPage(async (page) => {
      await page.goto("https://x.com/home", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      const title = await page.title();
      const path = new URL(page.url()).pathname;
      console.log(`URL : ${page.url()}`);
      console.log(`path: ${path}`);
      console.log(`title: ${title}`);
    });
    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => resolve());
    });
    await browser.stop();
  });

const judge = program.command("judge").description("LLM judge utilities");

judge
  .command("test <text>")
  .description("One-off Vertex judge call on supplied text")
  .option("--author <h>", "author handle", "test_user")
  .option("--followers <n>", "follower count", "10000")
  .option("--likes <n>", "likes", "20")
  .option("--replies <n>", "replies", "3")
  .option("--retweets <n>", "retweets", "1")
  .option("--age-min <n>", "minutes since posted", "15")
  .action(async (text: string, opts) => {
    const { Judge } = await import("./judge.ts");
    const cfg = loadConfig();
    const j = new Judge(cfg);
    const ageMin = Number(opts.ageMin);
    const likes = Number(opts.likes);
    const createdAt = new Date(Date.now() - ageMin * 60_000).toISOString();
    const result = await j.judgeOne({
      id: "test",
      author: opts.author,
      author_followers: Number(opts.followers),
      text,
      url: "https://x.com/test/status/test",
      created_at: createdAt,
      discovered_at: createdAt,
      source: "test",
      likes,
      replies: Number(opts.replies),
      retweets: Number(opts.retweets),
      last_polled_at: null,
      velocity: likes / Math.max(ageMin, 1),
      passed_gate_at: null,
      llm_score: null,
      llm_reason: null,
      llm_angle: null,
      llm_pitch: null,
      llm_context: null,
      llm_links: null,
      notified_at: null,
      seen_at: null,
      replied_at: null,
      hidden_at: null,
    });
    console.log(JSON.stringify(result, null, 2));
  });

judge
  .command("run-pending")
  .description("Run the judge once against tweets pending judgment")
  .action(async () => {
    const { Judge } = await import("./judge.ts");
    const cfg = loadConfig();
    const db = new DB(cfg.storage.db_path);
    const j = new Judge(cfg);
    const pending = db.fetchDueForJudge();
    console.log(`Pending: ${pending.length}`);
    for (const t of pending) {
      const r = await j.judgeOne(t);
      db.markJudged(
        t.id,
        r.score,
        r.reason,
        r.suggested_angle,
        r.pitch_bullets,
        r.context,
        r.links,
      );
      console.log(`  @${t.author} ${t.id.slice(0, 12)} -> ${r.score.toFixed(1)} — ${r.reason}`);
    }
    db.close();
  });

program.parseAsync().catch((e) => {
  console.error(chalk.red("error:"), e instanceof Error ? e.message : e);
  if (process.env.DEBUG) console.error(e);
  process.exit(1);
});
