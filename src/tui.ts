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
import { describeWindow, scheduleState, summary as scheduleSummary } from "./schedule.ts";
import type { SuggestionRow, TweetRow } from "./types.ts";

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
const FG_BLUE = `${ESC}94m`;
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

const wrapText = (s: string, width: number): string[] => {
  if (width <= 0) return [s];
  const lines: string[] = [];
  for (const para of s.split(/\r?\n/)) {
    if (para.length === 0) {
      lines.push("");
      continue;
    }
    const words = para.split(/\s+/).filter((w) => w.length > 0);
    let cur = "";
    for (const w of words) {
      if (cur.length === 0) {
        cur = w.length > width ? w.slice(0, width) : w;
        if (w.length > width) {
          lines.push(cur);
          cur = w.slice(width);
          while (cur.length > width) {
            lines.push(cur.slice(0, width));
            cur = cur.slice(width);
          }
        }
      } else if (cur.length + 1 + w.length <= width) {
        cur += " " + w;
      } else {
        lines.push(cur);
        cur = w.length > width ? w.slice(0, width) : w;
        if (w.length > width) {
          lines.push(cur);
          cur = w.slice(width);
          while (cur.length > width) {
            lines.push(cur.slice(0, width));
            cur = cur.slice(width);
          }
        }
      }
    }
    if (cur.length > 0) lines.push(cur);
  }
  return lines;
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
type Page = "candidates" | "keywords" | "suggestions" | "debug";

type DebugSnapshot = {
  stats: ReturnType<DB["stats"]> | null;
  logTail: string[];
  daemonStartedAt: number | null;
};

type ActivitySnapshot = ReturnType<DB["recentActivity"]>;

const ACTIVITY_WINDOW_SEC = 3600;
const ACTIVITY_BUCKETS = 60;

class TUI {
  private page: Page = "candidates";
  private candidates: TweetRow[] = [];
  private keywords: { query: string; last_scanned_at: string | null }[] = [];
  private suggestions: SuggestionRow[] = [];
  private unchunkedCount = 0;
  private debug: DebugSnapshot = { stats: null, logTail: [], daemonStartedAt: null };
  private activity: ActivitySnapshot = {
    scraped: [],
    surfaced: [],
    scrapedTotal: 0,
    surfacedTotal: 0,
  };
  private busy = false;
  private selected = 0;
  private detailRow: TweetRow | null = null;
  private detailSuggestion: SuggestionRow | null = null;
  private detailTweets: TweetRow[] = [];
  private inputMode = false;
  private inputBuffer = "";
  private inputPrompt = "";
  private inputResolver: ((value: string | null) => void) | null = null;
  private daemonStatus = "checking";
  private daemonPid: number | null = null;
  private stopFlag = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private lastFlash: { msg: string; until: number } | null = null;
  private debugSection = 0;

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
    // bun --watch sends SIGTERM on file change; make sure we restore the
    // terminal before dying instead of leaving the user in alt-screen.
    const onForceExit = (sig: NodeJS.Signals) => {
      this.teardownTerminal();
      process.exit(sig === "SIGTERM" ? 0 : 130);
    };
    process.on("SIGTERM", onForceExit);
    process.on("SIGHUP", onForceExit);
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

    try {
      this.activity = this.db.recentActivity(
        ACTIVITY_WINDOW_SEC,
        ACTIVITY_BUCKETS,
      );
    } catch {
      /* keep previous snapshot on transient DB errors */
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
    } else if (this.page === "suggestions") {
      this.suggestions = this.db.listPendingSuggestions();
      this.unchunkedCount = this.db.unchunkedTweetCount();
      this.selected = Math.min(
        this.selected,
        Math.max(0, this.suggestions.length - 1),
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

    if (this.detailRow) {
      if (key === "\x03") {
        this.stopFlag = true;
        return;
      }
      // any key closes the detail view
      this.detailRow = null;
      this.draw();
      return;
    }

    if (this.detailSuggestion) {
      if (key === "\x03") {
        this.stopFlag = true;
        return;
      }
      if (key === "j" || key === "\x1b[B") {
        this.navigateDetail(1);
        return;
      }
      if (key === "k" || key === "\x1b[A") {
        this.navigateDetail(-1);
        return;
      }
      if (key === "a" || key === "y") {
        this.resolveDetailSuggestion("accepted");
        return;
      }
      if (key === "r" || key === "n") {
        this.resolveDetailSuggestion("rejected");
        return;
      }
      if (key === "q" || key === "\x1b") {
        // q / esc explicitly close
        this.detailSuggestion = null;
        this.detailTweets = [];
        this.draw();
        return;
      }
      // ignore any other keys — keep the detail view open
      return;
    }

    // global keys
    if (key === "q" || key === "\x03") {
      this.stopFlag = true;
      return;
    }
    const PAGES: Page[] = ["candidates", "keywords", "suggestions", "debug"];
    if (key === "\t" || key === "\x1b[C") {
      const next = (PAGES.indexOf(this.page) + 1) % PAGES.length;
      this.page = PAGES[next] ?? "candidates";
      this.selected = 0;
      this.refresh();
      this.draw();
      return;
    }
    if (key === "\x1b[D") {
      const idx = PAGES.indexOf(this.page);
      const prev = (idx - 1 + PAGES.length) % PAGES.length;
      this.page = PAGES[prev] ?? "candidates";
      this.selected = 0;
      this.refresh();
      this.draw();
      return;
    }
    if (key === "1" || key === "2" || key === "3" || key === "4") {
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
    else if (this.page === "suggestions") this.onSuggestionsKey(key);
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
    } else if (key === "\r" || key === "\n" || key === " ") {
      const r = this.candidates[this.selected];
      if (r) {
        this.detailRow = r;
        this.draw();
        return;
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

  private onSuggestionsKey(key: string): void {
    if (key === "j" || key === "\x1b[B") {
      this.selected = Math.min(
        this.selected + 1,
        Math.max(0, this.suggestions.length - 1),
      );
      this.draw();
      return;
    }
    if (key === "k" || key === "\x1b[A") {
      this.selected = Math.max(this.selected - 1, 0);
      this.draw();
      return;
    }
    if (key === "\r" || key === "\n" || key === " ") {
      if (this.suggestions.length === 0) return;
      const s = this.suggestions[this.selected];
      if (s) this.openSuggestionDetail(s);
      return;
    }
    if (key === "a" || key === "y") {
      this.resolveOne("accepted");
      return;
    }
    if (key === "r" || key === "n") {
      this.resolveOne("rejected");
      return;
    }
    if (key === "A" || key === "Y") {
      this.resolveAll("accepted");
      return;
    }
    if (key === "R" || key === "N") {
      this.resolveAll("rejected");
      return;
    }
  }

  private applySuggestion(s: SuggestionRow): string {
    if (s.verdict === "add") {
      const added = this.db.addKeyword(s.keyword);
      return added ? `added: ${s.keyword}` : `already present: ${s.keyword}`;
    }
    if (s.verdict === "remove") {
      const removed = this.db.removeKeyword(s.keyword);
      return removed ? `removed: ${s.keyword}` : `not in list: ${s.keyword}`;
    }
    // change: swap old → new. Apply the add first so a transient empty state
    // doesn't cause the scheduler to skip a beat if it ticks mid-swap.
    const repl = s.replacement ?? "";
    const added = this.db.addKeyword(repl);
    const removed = this.db.removeKeyword(s.keyword);
    if (added && removed) return `changed: ${s.keyword} → ${repl}`;
    if (added && !removed) return `added ${repl} (${s.keyword} was not in list)`;
    if (!added && removed) return `removed ${s.keyword} (${repl} already present)`;
    return `no change: ${s.keyword} → ${repl}`;
  }

  private resolveOne(state: "accepted" | "rejected"): void {
    if (this.suggestions.length === 0) return;
    const s = this.suggestions[this.selected];
    if (!s) return;
    const updated = this.db.resolveSuggestion(s.id, state);
    if (!updated) {
      this.flash("already resolved");
      this.refresh();
      this.draw();
      return;
    }
    if (state === "accepted") {
      const msg = this.applySuggestion(updated);
      this.flash(msg);
    } else {
      this.flash(`rejected: ${updated.verdict} ${updated.keyword}`);
    }
    this.refresh();
    this.selected = Math.min(
      this.selected,
      Math.max(0, this.suggestions.length - 1),
    );
    this.draw();
  }

  private openSuggestionDetail(s: SuggestionRow): void {
    this.detailSuggestion = s;
    try {
      this.detailTweets = this.db.fetchSuggestionEvidence(s.chunk_id, s.keyword, 5);
    } catch {
      this.detailTweets = [];
    }
    this.draw();
  }

  private navigateDetail(delta: 1 | -1): void {
    if (!this.detailSuggestion || this.suggestions.length === 0) return;
    const idx = this.suggestions.findIndex(
      (s) => s.id === this.detailSuggestion!.id,
    );
    const base = idx === -1 ? this.selected : idx;
    const next = base + delta;
    if (next < 0 || next >= this.suggestions.length) return;
    this.selected = next;
    const target = this.suggestions[next];
    if (target) this.openSuggestionDetail(target);
  }

  private resolveDetailSuggestion(state: "accepted" | "rejected"): void {
    const s = this.detailSuggestion;
    if (!s) return;
    const idx = this.suggestions.findIndex((p) => p.id === s.id);
    const updated = this.db.resolveSuggestion(s.id, state);
    if (!updated) {
      this.detailSuggestion = null;
      this.detailTweets = [];
      this.flash("already resolved");
    } else if (state === "accepted") {
      this.flash(this.applySuggestion(updated));
    } else {
      this.flash(`rejected: ${updated.verdict} ${updated.keyword}`);
    }
    this.refresh();
    if (this.suggestions.length === 0) {
      this.detailSuggestion = null;
      this.detailTweets = [];
      this.selected = 0;
    } else if (updated) {
      // advance to whatever now sits where the resolved row was, or the
      // last item if we just resolved the tail.
      const nextIdx = idx === -1 ? this.selected : Math.min(idx, this.suggestions.length - 1);
      this.selected = nextIdx;
      const target = this.suggestions[nextIdx];
      if (target) this.openSuggestionDetail(target);
    }
    this.draw();
  }

  private resolveAll(state: "accepted" | "rejected"): void {
    if (this.suggestions.length === 0) return;
    const updated = this.db.resolveAllPendingSuggestions(state);
    if (state === "accepted") {
      let added = 0;
      let removed = 0;
      let changed = 0;
      let skipped = 0;
      for (const s of updated) {
        if (s.verdict === "add") {
          if (this.db.addKeyword(s.keyword)) added++;
          else skipped++;
        } else if (s.verdict === "remove") {
          if (this.db.removeKeyword(s.keyword)) removed++;
          else skipped++;
        } else {
          const repl = s.replacement ?? "";
          const a = repl ? this.db.addKeyword(repl) : false;
          const r = this.db.removeKeyword(s.keyword);
          if (a && r) changed++;
          else if (a) added++;
          else if (r) removed++;
          else skipped++;
        }
      }
      this.flash(
        `accepted ${updated.length} · +${added}, -${removed}, ~${changed}${
          skipped ? `, ${skipped} no-op` : ""
        }`,
        4000,
      );
    } else {
      this.flash(`rejected ${updated.length} suggestion(s)`);
    }
    this.refresh();
    this.selected = 0;
    this.draw();
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
    if (key === "j" || key === "\x1b[B") {
      this.debugSection = Math.min(this.debugSection + 1, this.debugSectionCount() - 1);
      this.draw();
      return;
    }
    if (key === "k" || key === "\x1b[A") {
      this.debugSection = Math.max(0, this.debugSection - 1);
      this.draw();
      return;
    }
    if (key === "R") void this.reloadDaemon();
    else if (key === "S") void this.stopDaemonAction();
    else if (key === "B") void this.startDaemonAction();
  }

  private debugSectionCount(): number {
    // keep in sync with renderDebug section order
    return 6;
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
    if (this.detailRow) {
      out.push(this.renderDetail(cols, this.detailRow));
    } else if (this.detailSuggestion) {
      out.push(this.renderSuggestionDetail(cols, this.detailSuggestion));
    } else if (this.page === "candidates") {
      out.push(this.renderCandidates(cols));
    } else if (this.page === "keywords") {
      out.push(this.renderKeywords(cols));
    } else if (this.page === "suggestions") {
      out.push(this.renderSuggestions(cols));
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
    const suggTab = tab("Suggestions", this.page === "suggestions");
    const debugTab = tab("Debug", this.page === "debug");
    const daemon =
      this.daemonStatus === "running"
        ? `${FG_GREEN}● daemon ${this.daemonPid}${RESET}`
        : `${FG_RED}● daemon stopped${RESET}`;
    const surf = this.activity.surfacedTotal;
    const scr = this.activity.scrapedTotal;
    const surfStr =
      surf > 0 ? `${FG_YELLOW}${surf}${RESET}` : `${DIM}${surf}${RESET}`;
    const rate = `${surfStr}${DIM}/${scr} last hour${RESET}`;
    const left = `${BOLD}xfarm${RESET}  ${candTab} ${kwTab} ${suggTab} ${debugTab}`;
    const right = `${rate}  ${daemon}`;
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

    // Reserve: header(1) blank(1) col-header(1) status(1) footer-blank(1) footer(1) flash-blank(1) flash(1)
    const rows = stdout.rows || 24;
    const dataRows = Math.max(3, rows - 8);
    const total = this.keywords.length;
    const sel = Math.max(0, Math.min(this.selected, total - 1));
    let start = Math.max(0, sel - Math.floor(dataRows / 2));
    let end = Math.min(total, start + dataRows);
    start = Math.max(0, end - dataRows);

    for (let i = start; i < end; i++) {
      const kw = this.keywords[i]!;
      const isSel = i === sel;
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
    }

    if (start > 0 || end < total) {
      lines.push(
        DIM +
          `  ${start + 1}-${end} of ${total}` +
          (start > 0 ? `  ↑${start}` : "") +
          (end < total ? `  ↓${total - end}` : "") +
          RESET,
      );
    }
    return lines.join("\n");
  }

  private renderSuggestions(cols: number): string {
    const COL_IDX = 3;
    const COL_ICON = 1;
    // Split the remaining width: roughly equal removed/added cols, reason takes the rest.
    const remaining = Math.max(30, cols - (COL_IDX + 1 + COL_ICON + 1 + 1));
    const COL_KW = Math.max(12, Math.min(24, Math.floor(remaining * 0.28)));
    const COL_REMOVED = COL_KW;
    const COL_ADDED = COL_KW;
    const COL_FIXED =
      COL_IDX + 1 + COL_ICON + 1 + COL_REMOVED + 1 + COL_ADDED + 1;
    const COL_REASON = Math.max(20, cols - COL_FIXED);

    const lines: string[] = [];
    const chunkSize = this.cfg.suggester.chunk_size;
    const pending = this.suggestions.length;
    const sel = Math.max(0, Math.min(this.selected, Math.max(0, pending - 1)));
    const pagination = pending > 0 ? `${sel + 1}/${pending}` : "0/0";
    const progress = `${this.unchunkedCount}/${chunkSize} toward next chunk`;
    lines.push(
      DIM +
        `${pending} pending · ${pagination} · ${progress}` +
        RESET,
    );
    lines.push("");
    lines.push(
      DIM +
        padRight("#", COL_IDX) +
        " " +
        padRight("", COL_ICON) +
        " " +
        padRight("removed", COL_REMOVED) +
        " " +
        padRight("added", COL_ADDED) +
        " reason" +
        RESET,
    );

    if (pending === 0) {
      lines.push("");
      lines.push(
        DIM +
          (this.unchunkedCount < chunkSize
            ? `(no suggestions yet — first chunk ready when ${chunkSize - this.unchunkedCount} more tweets are scraped)`
            : "(no pending suggestions — LLM is processing the next chunk)") +
          RESET,
      );
      return lines.join("\n");
    }

    const rows = stdout.rows || 24;
    const dataRows = Math.max(3, rows - 10);
    const total = pending;
    let start = Math.max(0, sel - Math.floor(dataRows / 2));
    let end = Math.min(total, start + dataRows);
    start = Math.max(0, end - dataRows);

    for (let i = start; i < end; i++) {
      const s = this.suggestions[i]!;
      const isSel = i === sel;
      const prefix = isSel ? REVERSE : "";
      const suffix = isSel ? RESET : "";
      // Reverse-video flips fg/bg; close-and-reopen the highlight around
      // any ANSI escape so colors don't bleed past the selected row.
      const hi = (s: string) => (isSel ? s + REVERSE : s);
      let iconChar = "";
      let iconColor = "";
      let removed = "";
      let added = "";
      if (s.verdict === "add") {
        iconChar = "+";
        iconColor = FG_GREEN;
        added = s.keyword;
      } else if (s.verdict === "remove") {
        iconChar = "X";
        iconColor = FG_RED;
        removed = s.keyword;
      } else {
        iconChar = "~";
        iconColor = FG_BLUE;
        removed = s.keyword;
        added = s.replacement ?? "";
      }
      const iconCell = hi(iconColor + iconChar + RESET);
      const removedCell = removed
        ? hi(FG_RED + truncVisible(removed, COL_REMOVED) + RESET)
        : "";
      const addedCell = added
        ? hi(FG_GREEN + truncVisible(added, COL_ADDED) + RESET)
        : "";
      lines.push(
        prefix +
          padRight(String(i), COL_IDX) +
          " " +
          padRight(iconCell, COL_ICON) +
          " " +
          padRight(removedCell, COL_REMOVED) +
          " " +
          padRight(addedCell, COL_ADDED) +
          " " +
          truncVisible(s.reason, COL_REASON) +
          suffix,
      );
    }

    if (start > 0 || end < total) {
      lines.push(
        DIM +
          `  ${start + 1}-${end} of ${total}` +
          (start > 0 ? `  ↑${start}` : "") +
          (end < total ? `  ↓${total - end}` : "") +
          RESET,
      );
    }
    return lines.join("\n");
  }

  private renderFooter(): string {
    if (this.inputMode) {
      return DIM + "enter: confirm · esc: cancel" + RESET;
    }
    if (this.detailRow) {
      return DIM + "any key: back · o open in browser" + RESET;
    }
    if (this.detailSuggestion) {
      return (
        DIM +
        "j/k ↑/↓ next/prev · a/y accept · r/n reject · esc/q back" +
        RESET
      );
    }
    if (this.page === "candidates") {
      return (
        DIM +
        "j/k move · enter/space view · o open · s seen · r replied · Tab/←→ switch · q quit" +
        RESET
      );
    }
    if (this.page === "keywords") {
      return (
        DIM +
        "j/k move · a add · d delete · Tab/←→ switch · q quit" +
        RESET
      );
    }
    if (this.page === "suggestions") {
      return (
        DIM +
        "j/k move · enter/space view · a/y accept · r/n reject · A accept all · R reject all · Tab/←→ switch · q quit" +
        RESET
      );
    }
    return (
      DIM +
      "j/k section · R reload daemon · S stop · B boot · Tab/←→ switch · q quit" +
      RESET
    );
  }

  private renderDebug(cols: number): string {
    const fmtAge = (ms: number): string => {
      const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
      if (sec < 60) return `${sec}s`;
      if (sec < 3600) return `${Math.floor(sec / 60)}m`;
      if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
      return `${Math.floor(sec / 86400)}d`;
    };

    const sections: string[][] = [];

    // 0: daemon
    {
      const lines: string[] = [];
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
      sections.push(lines);
    }

    // 1: activity chart
    {
      const lines: string[] = [];
      lines.push(BOLD + "activity" + RESET + DIM + " (last 60m, 1-min buckets)" + RESET);
      // chart drawn at cols-2 so it fits with the left margin
      for (const l of this.renderActivityChart(Math.max(20, cols - 2))) lines.push(l);
      sections.push(lines);
    }

    // 2: paths
    {
      const lines: string[] = [];
      lines.push(BOLD + "paths" + RESET);
      lines.push(`  config:  ${DIM}${DEFAULT_CONFIG_PATH}${RESET}`);
      lines.push(`  db:      ${DIM}${this.cfg.storage.db_path}${RESET}`);
      lines.push(`  log:     ${DIM}${logFilePath()}${RESET}`);
      lines.push(`  profile: ${DIM}${this.cfg.scraper.profile_path}${RESET}`);
      sections.push(lines);
    }

    // 3: scheduling
    {
      const lines: string[] = [];
      lines.push(BOLD + "scheduling" + RESET);
      const sched = scheduleState(this.cfg);
      const window = describeWindow(this.cfg);
      const labeled = (k: string, v: string) =>
        `  ${DIM}${padRight(k, 14)}${RESET} ${v}`;
      lines.push(labeled("active hours", window));
      if (sched.active) {
        lines.push(labeled("state", `${FG_GREEN}● active${RESET}`));
      } else {
        const msUntil = sched.sleepMs;
        const hUntil = Math.floor(msUntil / 3_600_000);
        const mUntil = Math.floor((msUntil % 3_600_000) / 60_000);
        const at = sched.nextActiveAt.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        });
        lines.push(
          labeled(
            "state",
            `${FG_YELLOW}○ quiet${RESET} · resumes at ${at} (in ${hUntil}h ${mUntil}m)`,
          ),
        );
      }
      const watchCount = this.debug.stats?.watchlist ?? 0;
      const kwCount = this.debug.stats?.keywords ?? 0;
      const feedCount = 1; // home; if we add more, query db
      const sum = scheduleSummary(this.cfg, {
        watchlist: watchCount,
        keywords: kwCount,
        feeds: feedCount,
      });
      lines.push(
        labeled(
          "cadence",
          `~${sum.scrapesPerMin.toFixed(1)} scrapes/min · ` +
            `${this.cfg.schedule.base_interval_sec}s ± ${this.cfg.schedule.jitter_sec}s gap`,
        ),
      );
      if (this.cfg.schedule.long_break_after > 0) {
        lines.push(
          labeled(
            "long break",
            `${this.cfg.schedule.long_break_sec}s every ${this.cfg.schedule.long_break_after} scrapes ` +
              `${DIM}(≈ every ${sum.longBreakEveryMin.toFixed(0)} min wall-clock)${RESET}`,
          ),
        );
      } else {
        lines.push(labeled("long break", `${DIM}disabled${RESET}`));
      }
      lines.push(
        labeled(
          "targets",
          `${sum.totalTargets} total  ${DIM}(${watchCount}w · ${kwCount}k · ${feedCount}f)${RESET}` +
            ` · tracker priority for fresh tweets`,
        ),
      );
      lines.push(
        labeled(
          "full cycle",
          `~${sum.cycleMinutes.toFixed(0)} min per target ${DIM}(round-robin oldest-first)${RESET}`,
        ),
      );
      sections.push(lines);
    }

    // 4: stats
    {
      const lines: string[] = [];
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
      sections.push(lines);
    }

    // 5: recent log
    {
      const lines: string[] = [];
      lines.push(BOLD + "recent log" + RESET + DIM + " (" + logFilePath() + ")" + RESET);
      if (this.debug.logTail.length === 0) {
        lines.push(DIM + "  (log is empty)" + RESET);
      } else {
        const maxLineLen = Math.max(20, cols - 6);
        for (const l of this.debug.logTail) {
          lines.push("  " + truncVisible(l, maxLineLen));
        }
      }
      sections.push(lines);
    }

    const sel = Math.max(0, Math.min(this.debugSection, sections.length - 1));
    const out: string[] = [];
    let selStart = 0;
    let selEnd = 0;
    sections.forEach((secLines, i) => {
      const isSel = i === sel;
      if (isSel) selStart = out.length;
      const prefix = isSel ? `${FG_CYAN}│${RESET} ` : "  ";
      for (const line of secLines) out.push(prefix + line);
      if (isSel) selEnd = out.length - 1;
      if (i < sections.length - 1) out.push("");
    });

    // Reserve: header(1) + blank(1) + footer-blank(1) + footer(1) + flash-blank(1) + flash(1) = 6
    const rows = stdout.rows || 24;
    const viewRows = Math.max(3, rows - 6);
    if (out.length <= viewRows) return out.join("\n");

    // Overflow: reserve one line for the scroll indicator
    const innerRows = Math.max(1, viewRows - 1);
    let offset = 0;
    if (selEnd >= innerRows) offset = selEnd - innerRows + 1;
    if (selStart < offset) offset = selStart;
    offset = Math.max(0, Math.min(offset, out.length - innerRows));

    const visible = out.slice(offset, offset + innerRows);
    const above = offset;
    const below = out.length - offset - visible.length;
    visible.push(
      DIM +
        `  ${offset + 1}-${offset + visible.length} of ${out.length}` +
        (above > 0 ? `  ↑${above}` : "") +
        (below > 0 ? `  ↓${below}` : "") +
        RESET,
    );
    return visible.join("\n");
  }

  private renderActivityChart(cols: number): string[] {
    const { scraped, surfaced, scrapedTotal, surfacedTotal } = this.activity;
    const label = "  scraped   ";
    const surfLabel = "  surfaced  ";
    const trailing = 8; // room for "  172" etc
    const maxBars = Math.max(10, Math.min(scraped.length, cols - label.length - trailing));
    // Right-align the chart to "now" by taking the last maxBars buckets.
    const start = Math.max(0, scraped.length - maxBars);
    const scr = scraped.slice(start);
    const sur = surfaced.slice(start);

    const blocks = "▁▂▃▄▅▆▇█";
    const max = Math.max(1, ...scr);
    const scrLine = scr
      .map((n) => {
        if (n === 0) return DIM + "·" + RESET;
        const idx = Math.min(
          blocks.length - 1,
          Math.max(0, Math.ceil((n / max) * blocks.length) - 1),
        );
        return FG_CYAN + blocks[idx] + RESET;
      })
      .join("");
    const surLine = sur
      .map((n) => (n > 0 ? FG_YELLOW + "*" + RESET : DIM + "·" + RESET))
      .join("");

    const minutesShown = scr.length;
    const axis =
      DIM +
      " ".repeat(label.length) +
      `-${minutesShown}m` +
      " ".repeat(Math.max(1, scr.length - `-${minutesShown}m`.length - "now".length)) +
      "now" +
      RESET;

    return [
      DIM + label + RESET + scrLine + `  ${BOLD}${scrapedTotal}${RESET}`,
      DIM + surfLabel + RESET + surLine + `  ${BOLD}${surfacedTotal}${RESET}`,
      axis,
    ];
  }

  private renderDetail(cols: number, r: TweetRow): string {
    const width = Math.max(20, Math.min(100, cols - 4));
    const lines: string[] = [];

    const score = r.llm_score == null ? "—" : r.llm_score.toFixed(1);
    const velocity = r.velocity == null ? "—" : r.velocity.toFixed(1);
    const meta =
      `${FG_CYAN}@${r.author}${RESET}` +
      `  ${DIM}${ageStr(r.created_at)} ago${RESET}` +
      `  ${DIM}score${RESET} ${score}` +
      `  ${DIM}v/min${RESET} ${velocity}` +
      `  ${DIM}likes${RESET} ${r.likes ?? 0}`;
    lines.push(meta);
    lines.push(DIM + r.url + RESET);
    lines.push("");

    lines.push(BOLD + "text" + RESET);
    for (const l of wrapText(r.text, width)) {
      lines.push(l);
    }

    if (r.llm_angle) {
      lines.push("");
      lines.push(BOLD + FG_GREEN + "angle" + RESET);
      for (const l of wrapText(r.llm_angle, width)) {
        lines.push(FG_GREEN + l + RESET);
      }
    }

    return lines.join("\n");
  }

  private renderSuggestionDetail(cols: number, s: SuggestionRow): string {
    const width = Math.max(20, Math.min(100, cols - 4));
    const lines: string[] = [];
    const verdictColor =
      s.verdict === "add"
        ? FG_GREEN
        : s.verdict === "remove"
          ? FG_RED
          : FG_BLUE;
    const iconChar =
      s.verdict === "add" ? "+" : s.verdict === "remove" ? "X" : "~";
    const keywordPart =
      s.verdict === "change" && s.replacement
        ? `${FG_RED}${s.keyword}${RESET} ${DIM}→${RESET} ${FG_GREEN}${s.replacement}${RESET}`
        : s.verdict === "remove"
          ? `${FG_RED}${s.keyword}${RESET}`
          : `${FG_GREEN}${s.keyword}${RESET}`;
    // Position within the current pending list, so j/k navigation has a clear anchor.
    const idx = this.suggestions.findIndex((p) => p.id === s.id);
    const position =
      idx === -1
        ? ""
        : `  ${DIM}${idx + 1}/${this.suggestions.length}${RESET}`;
    const meta =
      `${verdictColor}${BOLD}${iconChar}${RESET}` +
      `  ${keywordPart}` +
      `  ${DIM}chunk ${s.chunk_id}${RESET}` +
      `  ${DIM}${ageStr(s.created_at)} ago${RESET}` +
      position;
    lines.push(meta);
    lines.push("");

    lines.push(BOLD + "reason" + RESET);
    for (const l of wrapText(s.reason, width)) {
      lines.push(l);
    }

    if (this.detailTweets.length > 0) {
      lines.push("");
      lines.push(
        BOLD +
          `examples (${this.detailTweets.length})` +
          RESET +
          DIM +
          " — tweets in chunk that match this keyword" +
          RESET,
      );
      for (const t of this.detailTweets) {
        const header =
          `${FG_GRAY}[${truncVisible(t.source, 28)}]${RESET} ` +
          `${FG_CYAN}@${t.author}${RESET} ` +
          `${DIM}${ageStr(t.created_at)} · ${t.likes ?? 0}♥ ${t.replies ?? 0}↩${RESET}`;
        lines.push(header);
        const body = wrapText(t.text, width - 2);
        for (const l of body.slice(0, 3)) {
          lines.push("  " + l);
        }
        if (body.length > 3) {
          lines.push("  " + DIM + `…(+${body.length - 3} more lines)` + RESET);
        }
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
