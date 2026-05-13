import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { stdin, stdout } from "node:process";
import type { Config } from "./config.ts";
import { DB } from "./db.ts";
import {
  isDaemonRunning,
  logFilePath,
  pidFilePath,
  readPid,
  startDaemonBackground,
  stopDaemon,
  waitForDaemonRunning,
  waitForDaemonStopped,
} from "./lifecycle.ts";
import { DEFAULT_CONFIG_PATH, loadConfig } from "./config.ts";
import type { TweetRow } from "./types.ts";

// ---------- ANSI ----------
const ESC = "\x1b[";
const ALT_ON = `${ESC}?1049h`;
const ALT_OFF = `${ESC}?1049l`;
const CLEAR = `${ESC}2J${ESC}H`;
const HOME = `${ESC}H`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const REVERSE = `${ESC}7m`;
const FG_CYAN = `${ESC}36m`;
const FG_GREEN = `${ESC}32m`;
const FG_YELLOW = `${ESC}33m`;
const FG_RED = `${ESC}31m`;
const FG_GRAY = `${ESC}90m`;

const stripAnsi = (s: string): string =>
  s.replace(/\x1b\[[0-9;]*m/g, "");

const padRight = (s: string, n: number): string => {
  const visible = stripAnsi(s).length;
  if (visible >= n) return s;
  return s + " ".repeat(n - visible);
};

const truncVisible = (s: string, n: number): string => {
  const oneLine = s.replace(/\s+/g, " ").trim();
  if (oneLine.length <= n) return oneLine;
  return oneLine.slice(0, Math.max(0, n - 1)) + "…";
};

const ageStr = (iso: string): string => {
  const secs = Math.max(
    0,
    Math.floor((Date.now() - new Date(iso).getTime()) / 1000),
  );
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
};

// ---------- TUI ----------
type Page = "candidates" | "keywords" | "debug";

type DebugSnapshot = {
  stats: ReturnType<DB["stats"]> | null;
  logTail: string[];
  daemonStartedAt: number | null;
};

class TUI {
  private page: Page = "candidates";
  private candidates: TweetRow[] = [];
  private keywords: { query: string; last_scanned_at: string | null }[] = [];
  private debug: DebugSnapshot = { stats: null, logTail: [], daemonStartedAt: null };
  private busy = false;
  private selected = 0;
  private inputMode = false;
  private inputBuffer = "";
  private inputPrompt = "";
  private inputResolver: ((value: string | null) => void) | null = null;
  private daemonStatus = "checking";
  private daemonPid: number | null = null;
  private stopFlag = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private lastFlash: { msg: string; until: number } | null = null;

  constructor(
    private db: DB,
    private cfg: Config,
  ) {}

  async run(): Promise<void> {
    this.setupTerminal();
    this.refresh();
    this.draw();
    this.intervalId = setInterval(() => {
      if (!this.stopFlag) {
        this.refresh();
        this.draw();
      }
    }, 1000);

    stdout.on("resize", () => this.draw());

    await new Promise<void>((resolve) => {
      const check = () => {
        if (this.stopFlag) return resolve();
        setTimeout(check, 100);
      };
      check();
    });
    this.teardownTerminal();
  }

  private setupTerminal(): void {
    stdout.write(ALT_ON + HIDE_CURSOR + CLEAR);
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", (key: string) => this.onKey(key));
    process.on("exit", () => this.teardownTerminal());
  }

  private teardownTerminal(): void {
    if (this.intervalId) clearInterval(this.intervalId);
    try {
      if (stdin.isTTY) stdin.setRawMode(false);
    } catch {
      /* may already be reset */
    }
    stdout.write(SHOW_CURSOR + ALT_OFF);
  }

  private flash(msg: string, ms = 2500): void {
    this.lastFlash = { msg, until: Date.now() + ms };
  }

  // ---------- data ----------
  private refresh(): void {
    const wasRunning = this.daemonStatus === "running";
    this.daemonPid = readPid();
    this.daemonStatus = isDaemonRunning() ? "running" : "stopped";
    if (wasRunning && this.daemonStatus !== "running") {
      this.flash("daemon stopped");
    }

    if (this.page === "candidates") {
      this.candidates = this.db.fetchActive(50);
      this.selected = Math.min(
        this.selected,
        Math.max(0, this.candidates.length - 1),
      );
    } else if (this.page === "keywords") {
      this.keywords = this.db.listKeywords();
      this.selected = Math.min(
        this.selected,
        Math.max(0, this.keywords.length - 1),
      );
    } else if (this.page === "debug") {
      this.refreshDebug();
    }
  }

  private refreshDebug(): void {
    try {
      this.debug.stats = this.db.stats();
    } catch {
      this.debug.stats = null;
    }
    this.debug.logTail = this.readLogTail(12);
    const pf = pidFilePath();
    this.debug.daemonStartedAt =
      this.daemonStatus === "running" && existsSync(pf)
        ? statSync(pf).mtimeMs
        : null;
  }

  private readLogTail(maxLines: number): string[] {
    const path = logFilePath();
    if (!existsSync(path)) return [];
    try {
      const data = readFileSync(path, "utf-8");
      // last ~8KB is enough for maxLines without parsing the whole file every tick
      const tail = data.length > 8192 ? data.slice(data.length - 8192) : data;
      const lines = tail.split("\n").filter((l) => l.length > 0);
      return lines.slice(-maxLines);
    } catch {
      return [];
    }
  }

  // ---------- input ----------
  private async promptInput(prompt: string): Promise<string | null> {
    return new Promise((resolve) => {
      this.inputMode = true;
      this.inputPrompt = prompt;
      this.inputBuffer = "";
      this.inputResolver = (v) => {
        this.inputMode = false;
        this.inputResolver = null;
        this.draw();
        resolve(v);
      };
      this.draw();
    });
  }

  private onKey(key: string): void {
    if (this.inputMode) {
      this.onInputKey(key);
      return;
    }

    // global keys
    if (key === "q" || key === "\x03") {
      this.stopFlag = true;
      return;
    }
    const PAGES: Page[] = ["candidates", "keywords", "debug"];
    if (key === "\t") {
      const next = (PAGES.indexOf(this.page) + 1) % PAGES.length;
      this.page = PAGES[next] ?? "candidates";
      this.selected = 0;
      this.refresh();
      this.draw();
      return;
    }
    if (key === "1" || key === "2" || key === "3") {
      const target = PAGES[Number(key) - 1];
      if (target) {
        this.page = target;
        this.selected = 0;
        this.refresh();
        this.draw();
      }
      return;
    }

    if (this.page === "candidates") this.onCandidatesKey(key);
    else if (this.page === "keywords") this.onKeywordsKey(key);
    else this.onDebugKey(key);
  }

  private onInputKey(key: string): void {
    if (key === "\r" || key === "\n") {
      const r = this.inputResolver;
      const v = this.inputBuffer.trim();
      if (r) r(v.length > 0 ? v : null);
      return;
    }
    if (key === "\x1b" || key === "\x03") {
      const r = this.inputResolver;
      if (r) r(null);
      return;
    }
    if (key === "\x7f" || key === "\b") {
      this.inputBuffer = this.inputBuffer.slice(0, -1);
      this.draw();
      return;
    }
    // printable
    if (key.length === 1 && key >= " " && key !== "\x7f") {
      this.inputBuffer += key;
      this.draw();
    }
  }

  private onCandidatesKey(key: string): void {
    if (this.candidates.length === 0) return;
    let moved = false;
    if (key === "j" || key === `${ESC}B` || key === "\x1b[B") {
      this.selected = Math.min(this.selected + 1, this.candidates.length - 1);
      moved = true;
    } else if (key === "k" || key === `${ESC}A` || key === "\x1b[A") {
      this.selected = Math.max(this.selected - 1, 0);
      moved = true;
    } else if (key === "o") {
      const r = this.candidates[this.selected];
      if (r) {
        spawn("open", [r.url], { stdio: "ignore", detached: true }).unref();
        this.flash(`opened ${r.url}`);
      }
    } else if (key === "s") {
      const r = this.candidates[this.selected];
      if (r) {
        this.db.markSeen(r.id);
        this.refresh();
        this.flash(`marked seen: @${r.author}`);
      }
    } else if (key === "r") {
      const r = this.candidates[this.selected];
      if (r) {
        this.db.markReplied(r.id);
        this.refresh();
        this.flash(`marked replied: @${r.author}`);
      }
    }
    if (moved) this.draw();
    else this.draw();
  }

  private onKeywordsKey(key: string): void {
    if (key === "j" || key === "\x1b[B") {
      this.selected = Math.min(
        this.selected + 1,
        Math.max(0, this.keywords.length - 1),
      );
      this.draw();
    } else if (key === "k" || key === "\x1b[A") {
      this.selected = Math.max(this.selected - 1, 0);
      this.draw();
    } else if (key === "a") {
      void this.handleAddKeyword();
    } else if (key === "d") {
      if (this.keywords.length === 0) return;
      const kw = this.keywords[this.selected];
      if (!kw) return;
      const removed = this.db.removeKeyword(kw.query);
      if (removed) this.flash(`deleted: ${kw.query}`);
      this.refresh();
      this.selected = Math.min(
        this.selected,
        Math.max(0, this.keywords.length - 1),
      );
      this.draw();
    }
  }

  private async handleAddKeyword(): Promise<void> {
    const v = await this.promptInput("Add keyword: ");
    if (!v) return;
    const added = this.db.addKeyword(v);
    if (added) this.flash(`added: ${v}`);
    else this.flash(`already exists: ${v}`);
    this.refresh();
    this.draw();
  }

  // ---------- debug page actions ----------
  private onDebugKey(key: string): void {
    if (this.busy) return;
    if (key === "R") void this.reloadDaemon();
    else if (key === "S") void this.stopDaemonAction();
    else if (key === "B") void this.startDaemonAction();
  }

  private async reloadDaemon(): Promise<void> {
    this.busy = true;
    this.flash("reloading daemon…", 10000);
    this.draw();
    try {
      const pid = stopDaemon();
      if (pid != null) {
        const stopped = await waitForDaemonStopped(8000);
        if (!stopped) {
          this.flash(`daemon ${pid} didn't exit in 8s — aborting reload`, 5000);
          return;
        }
      }
      const newPid = startDaemonBackground();
      const up = await waitForDaemonRunning(8000);
      if (up) {
        this.flash(`daemon reloaded (PID ${newPid})`, 3000);
      } else {
        this.flash(
          `spawned PID ${newPid} but it never wrote a PID file — check the log`,
          5000,
        );
      }
    } catch (e) {
      this.flash(`reload failed: ${(e as Error).message}`, 5000);
    } finally {
      this.busy = false;
      this.refresh();
      this.draw();
    }
  }

  private async stopDaemonAction(): Promise<void> {
    this.busy = true;
    this.flash("stopping daemon…", 8000);
    this.draw();
    try {
      const pid = stopDaemon();
      if (pid == null) {
        this.flash("daemon was not running", 3000);
        return;
      }
      const stopped = await waitForDaemonStopped(8000);
      this.flash(stopped ? `daemon ${pid} stopped` : `daemon ${pid} unresponsive`, 4000);
    } finally {
      this.busy = false;
      this.refresh();
      this.draw();
    }
  }

  private async startDaemonAction(): Promise<void> {
    if (isDaemonRunning()) {
      this.flash("daemon is already running", 3000);
      return;
    }
    this.busy = true;
    this.flash("starting daemon…", 8000);
    this.draw();
    try {
      const pid = startDaemonBackground();
      const up = await waitForDaemonRunning(8000);
      this.flash(
        up
          ? `daemon started (PID ${pid})`
          : `spawned PID ${pid} but never wrote a PID file — check the log`,
        4000,
      );
    } finally {
      this.busy = false;
      this.refresh();
      this.draw();
    }
  }

  // ---------- rendering ----------
  private draw(): void {
    const cols = stdout.columns || 100;
    const out: string[] = [HOME, `${ESC}J`]; // home + clear-to-end
    out.push(this.renderHeader(cols));
    out.push("\n\n");
    if (this.page === "candidates") {
      out.push(this.renderCandidates(cols));
    } else if (this.page === "keywords") {
      out.push(this.renderKeywords(cols));
    } else {
      out.push(this.renderDebug(cols));
    }
    out.push("\n");
    out.push(this.renderFooter());
    if (this.inputMode) {
      out.push("\n\n" + this.renderInputBar());
    } else if (this.lastFlash && Date.now() < this.lastFlash.until) {
      out.push("\n\n" + DIM + this.lastFlash.msg + RESET);
    }
    stdout.write(out.join(""));
  }

  private renderHeader(cols: number): string {
    const tab = (label: string, active: boolean): string =>
      active ? `${REVERSE} ${label} ${RESET}` : `${DIM} ${label} ${RESET}`;
    const candTab = tab("Candidates", this.page === "candidates");
    const kwTab = tab("Keywords", this.page === "keywords");
    const debugTab = tab("Debug", this.page === "debug");
    const daemon =
      this.daemonStatus === "running"
        ? `${FG_GREEN}● daemon ${this.daemonPid}${RESET}`
        : `${FG_RED}● daemon stopped${RESET}`;
    const left = `${BOLD}xfarm${RESET}  ${candTab} ${kwTab} ${debugTab}`;
    const right = daemon;
    const leftLen = stripAnsi(left).length;
    const rightLen = stripAnsi(right).length;
    const gap = Math.max(2, cols - leftLen - rightLen);
    return left + " ".repeat(gap) + right;
  }

  private renderCandidates(cols: number): string {
    const COL_IDX = 3;
    const COL_AGE = 6;
    const COL_AUTHOR = 20;
    const COL_SCORE = 6;
    const COL_VEL = 7;
    const COL_LIKES = 7;
    const COL_FIXED =
      COL_IDX + 1 + COL_AGE + 1 + COL_AUTHOR + 1 + COL_SCORE + 1 + COL_VEL + 1 + COL_LIKES + 1;
    const COL_TEXT = Math.max(20, cols - COL_FIXED);

    const lines: string[] = [];
    const header =
      DIM +
      padRight("#", COL_IDX) +
      " " +
      padRight("age", COL_AGE) +
      " " +
      padRight("author", COL_AUTHOR) +
      " " +
      padRight("score", COL_SCORE) +
      " " +
      padRight("v/min", COL_VEL) +
      " " +
      padRight("likes", COL_LIKES) +
      " text / angle" +
      RESET;
    lines.push(header);

    if (this.candidates.length === 0) {
      lines.push("");
      lines.push(
        DIM +
          "(no candidates yet — daemon is scanning. give it 1-2 minutes.)" +
          RESET,
      );
      return lines.join("\n");
    }

    this.candidates.forEach((r, i) => {
      const isSel = i === this.selected;
      const score = r.llm_score == null ? "—" : r.llm_score.toFixed(1);
      const scoreHot = (r.llm_score ?? 0) >= this.cfg.judge.notify_threshold;
      const scoreCell = scoreHot
        ? `${FG_YELLOW}${BOLD}${score}${RESET}${isSel ? REVERSE : ""}`
        : score;
      const velocity = r.velocity == null ? "—" : r.velocity.toFixed(1);

      const prefix = isSel ? REVERSE : "";
      const suffix = isSel ? RESET : "";
      const authorCell = `${FG_CYAN}@${r.author}${RESET}${isSel ? REVERSE : ""}`;

      const row =
        prefix +
        padRight(String(i), COL_IDX) +
        " " +
        padRight(ageStr(r.created_at), COL_AGE) +
        " " +
        padRight(authorCell, COL_AUTHOR) +
        " " +
        padRight(scoreCell, COL_SCORE) +
        " " +
        padRight(velocity, COL_VEL) +
        " " +
        padRight(String(r.likes ?? 0), COL_LIKES) +
        " " +
        truncVisible(r.text, COL_TEXT) +
        suffix;
      lines.push(row);

      if (r.llm_angle) {
        const indent = " ".repeat(COL_FIXED);
        const anglePrefix = isSel ? REVERSE : "";
        lines.push(
          anglePrefix +
            indent +
            FG_GREEN +
            "└ " +
            truncVisible(r.llm_angle, COL_TEXT - 2) +
            RESET +
            (isSel ? RESET : ""),
        );
      }
    });
    return lines.join("\n");
  }

  private renderKeywords(cols: number): string {
    const COL_IDX = 3;
    const COL_KW = Math.max(20, Math.min(50, cols - 30));

    const lines: string[] = [];
    lines.push(
      DIM +
        padRight("#", COL_IDX) +
        " " +
        padRight("keyword", COL_KW) +
        " last scanned" +
        RESET,
    );

    if (this.keywords.length === 0) {
      lines.push("");
      lines.push(DIM + "(no keywords — press 'a' to add one)" + RESET);
      return lines.join("\n");
    }

    this.keywords.forEach((kw, i) => {
      const isSel = i === this.selected;
      const scanned = kw.last_scanned_at
        ? ageStr(kw.last_scanned_at) + " ago"
        : "never";
      const prefix = isSel ? REVERSE : "";
      const suffix = isSel ? RESET : "";
      lines.push(
        prefix +
          padRight(String(i), COL_IDX) +
          " " +
          padRight(kw.query, COL_KW) +
          " " +
          DIM +
          scanned +
          RESET +
          (isSel ? REVERSE : "") +
          suffix,
      );
    });
    return lines.join("\n");
  }

  private renderFooter(): string {
    if (this.inputMode) {
      return DIM + "enter: confirm · esc: cancel" + RESET;
    }
    if (this.page === "candidates") {
      return (
        DIM +
        "j/k move · o open · s seen · r replied · Tab switch · q quit" +
        RESET
      );
    }
    if (this.page === "keywords") {
      return (
        DIM +
        "j/k move · a add · d delete · Tab switch · q quit" +
        RESET
      );
    }
    return (
      DIM +
      "R reload daemon · S stop · B boot · Tab switch · q quit" +
      RESET
    );
  }

  private renderDebug(cols: number): string {
    const lines: string[] = [];
    const fmtAge = (ms: number): string => {
      const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
      if (sec < 60) return `${sec}s`;
      if (sec < 3600) return `${Math.floor(sec / 60)}m`;
      if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
      return `${Math.floor(sec / 86400)}d`;
    };

    // daemon
    lines.push(BOLD + "daemon" + RESET);
    if (this.daemonStatus === "running") {
      const uptime = this.debug.daemonStartedAt != null
        ? fmtAge(this.debug.daemonStartedAt)
        : "?";
      lines.push(
        `  ${FG_GREEN}● running${RESET}  PID ${this.daemonPid}  uptime ~${uptime}`,
      );
    } else {
      lines.push(`  ${FG_RED}● stopped${RESET}`);
    }
    lines.push("");

    // paths
    lines.push(BOLD + "paths" + RESET);
    lines.push(`  config:  ${DIM}${DEFAULT_CONFIG_PATH}${RESET}`);
    lines.push(`  db:      ${DIM}${this.cfg.storage.db_path}${RESET}`);
    lines.push(`  log:     ${DIM}${logFilePath()}${RESET}`);
    lines.push(`  profile: ${DIM}${this.cfg.scraper.profile_path}${RESET}`);
    lines.push("");

    // stats
    lines.push(BOLD + "stats" + RESET);
    const s = this.debug.stats;
    if (s) {
      const pair = (k: string, v: number) =>
        `  ${DIM}${padRight(k, 16)}${RESET} ${v}`;
      lines.push(pair("tweets total", s.tweets_total));
      lines.push(pair("active", s.active));
      lines.push(pair("pending judge", s.pending_judge));
      lines.push(pair("notified", s.notified));
      lines.push(pair("seen", s.seen));
      lines.push(pair("replied", s.replied));
      lines.push(pair("watchlist", s.watchlist));
      lines.push(pair("keywords", s.keywords));
    } else {
      lines.push(DIM + "  (no stats yet)" + RESET);
    }
    lines.push("");

    // log tail
    lines.push(BOLD + "recent log" + RESET + DIM + " (" + logFilePath() + ")" + RESET);
    if (this.debug.logTail.length === 0) {
      lines.push(DIM + "  (log is empty)" + RESET);
    } else {
      const maxLineLen = Math.max(20, cols - 4);
      for (const l of this.debug.logTail) {
        lines.push("  " + truncVisible(l, maxLineLen));
      }
    }

    return lines.join("\n");
  }

  private renderInputBar(): string {
    return BOLD + this.inputPrompt + RESET + this.inputBuffer + FG_GRAY + "▏" + RESET;
  }
}

export async function runTui(): Promise<void> {
  const cfg = loadConfig();
  const db = new DB(cfg.storage.db_path);

  // Auto-start daemon if not running.
  if (!isDaemonRunning()) {
    try {
      const pid = startDaemonBackground();
      process.stderr.write(
        `${DIM}[xfarm] daemon started in background (PID ${pid}, logs at ~/.xfarm/daemon.log)${RESET}\n`,
      );
      // small wait so the daemon has time to write its real PID file
      await new Promise((r) => setTimeout(r, 800));
    } catch (e) {
      process.stderr.write(
        `${FG_RED}[xfarm] failed to start daemon: ${(e as Error).message}${RESET}\n`,
      );
    }
  }

  const tui = new TUI(db, cfg);
  await tui.run();
  db.close();
}
