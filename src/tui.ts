import { stdin, stdout } from "node:process";
import type { Config } from "./config.ts";
import { loadConfigLoose } from "./config.ts";
import { DB } from "./db.ts";
import { isDaemonRunning, readLongBreakUntil, readPid } from "./lifecycle.ts";
import { checkSetup, type SetupStatus } from "./setup-check.ts";
import type { TweetRow } from "./types.ts";
import {
  ALT_OFF,
  ALT_ON,
  BRACKETED_PASTE_OFF,
  BRACKETED_PASTE_ON,
  CLEAR,
  DIM,
  ESC,
  HIDE_CURSOR,
  HOME,
  RESET,
  SHOW_CURSOR,
} from "./tui/ansi.ts";
import {
  bootstrapTui,
  maybeStartDaemon,
  startVersionCheckPoll,
} from "./tui/bootstrap.ts";
import type {
  ActivitySnapshot,
  DebugSnapshot,
  KeywordItem,
  Page,
  TuiHost,
} from "./tui/types.ts";
import { buildKeywordItems } from "./tui/keyword-items.ts";
import { renderHeader } from "./tui/render-header.ts";
import { renderFooter, renderInputBar } from "./tui/render-footer.ts";
import {
  renderCandidates,
  renderTweetDetail,
} from "./tui/render-candidates.ts";
import {
  renderKeywordDetail,
  renderKeywords,
} from "./tui/render-keywords.ts";
import {
  debugDaemonStartedAt,
  readLogTail,
  renderDebug,
} from "./tui/render-debug.ts";
import { handleCandidatesKey } from "./tui/keys-candidates.ts";
import { handleKeywordDetailKey, handleKeywordsKey } from "./tui/keys-keywords.ts";
import { getDebugItems, handleDebugKey } from "./tui/keys-debug.ts";
import { handleConfigKey } from "./tui/keys-config.ts";
import { renderConfig } from "./tui/render-config.ts";
import { handleTweetDetailKey } from "./tui/keys-tweet-detail.ts";
import { handleAboutKey } from "./tui/keys-about.ts";
import { renderAbout } from "./tui/render-about.ts";
import { isChar, parseKey, type ParsedKey } from "./tui/keys.ts";
import { handleBannerKey, renderBanner } from "./tui/banner.ts";

const ACTIVITY_WINDOW_SEC = 3600;
const ACTIVITY_BUCKETS = 60;
const PAGES: Page[] = ["candidates", "keywords", "config", "debug", "about"];

export class TUI implements TuiHost {
  page: Page = "candidates";
  candidates: TweetRow[] = [];
  nonCandidates: TweetRow[] = [];
  keywordItems: KeywordItem[] = [];
  pendingSuggestionCount = 0;
  unchunkedCount = 0;
  debug: DebugSnapshot = {
    stats: null,
    logTail: [],
    daemonStartedAt: null,
    longBreakUntilMs: null,
  };
  activity: ActivitySnapshot = {
    scraped: [],
    surfaced: [],
    scrapedTotal: 0,
    surfacedTotal: 0,
  };
  busy = false;
  selected = 0;
  detailRow: TweetRow | null = null;
  detailKeyword: KeywordItem | null = null;
  detailTweets: TweetRow[] = [];
  detailScroll = 0;
  inputMode = false;
  inputBuffer = "";
  inputPrompt = "";
  daemonStatus = "checking";
  daemonPid: number | null = null;
  // Unified cursor across the Debug page: walks through sections AND actions
  // as one linear list. Sections are read-only; actions execute on Enter.
  debugCursor = 0;
  configCursor = 1; // start past the first header so j/k feels right
  aboutScroll = 0;
  tweetDetailCursor = 0;
  tweetDetailCopiedAt: number | null = null;
  tweetDetailBusyAction: string | null = null;
  tweetDetailJudgeStatus: string | null = null;
  tweetDetailRefineStatus: string | null = null;
  setupStatus: SetupStatus | null = null;
  updateAvailable: { behind: number } | null = null;
  bannerSelected = false;
  bannerButton = 0;
  autoUpdating = false;

  private inputResolver: ((value: string | null) => void) | null = null;
  private stopFlag = false;
  private restartFlag = false;
  private stopResolver: (() => void) | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private bannerAnimId: ReturnType<typeof setInterval> | null = null;
  private lastFlash: { msg: string; until: number } | null = null;
  private onData: ((key: string) => void) | null = null;
  private torndown = false;

  constructor(
    public readonly db: DB,
    public cfg: Config,
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
    // Banner gradient animation. Only draws when the banner is visible, so
    // the 10fps cadence costs nothing while no update is available.
    this.bannerAnimId = setInterval(() => {
      if (!this.stopFlag && this.updateAvailable) this.draw();
    }, 100);

    stdout.on("resize", () => this.draw());

    await new Promise<void>((resolve) => {
      if (this.stopFlag) return resolve();
      this.stopResolver = resolve;
    });
    this.teardownTerminal();
  }

  private setupTerminal(): void {
    stdout.write(ALT_ON + HIDE_CURSOR + BRACKETED_PASTE_ON + CLEAR);
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    this.onData = (key: string) => this.onKey(key);
    stdin.on("data", this.onData);
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
    if (this.torndown) return;
    this.torndown = true;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.bannerAnimId) {
      clearInterval(this.bannerAnimId);
      this.bannerAnimId = null;
    }
    if (this.onData) {
      stdin.off("data", this.onData);
      this.onData = null;
    }
    try {
      if (stdin.isTTY) stdin.setRawMode(false);
    } catch {
      /* may already be reset */
    }
    // Release stdin so the event loop can exit. Without this the listener is
    // gone but the flowing-mode resume() keeps a handle open and the process
    // hangs after the user quits.
    try {
      stdin.pause();
    } catch {
      /* ignore */
    }
    stdout.write(BRACKETED_PASTE_OFF + SHOW_CURSOR + ALT_OFF);
  }

  flash(msg: string, ms = 2500): void {
    this.lastFlash = { msg, until: Date.now() + ms };
  }

  requestStop(): void {
    this.stopFlag = true;
    if (this.stopResolver) {
      const r = this.stopResolver;
      this.stopResolver = null;
      r();
    }
  }

  requestRestart(): void {
    this.restartFlag = true;
    this.requestStop();
  }

  get shouldRestart(): boolean {
    return this.restartFlag;
  }

  /** Re-read config.yaml + setup status. Called after the Config tab writes. */
  reloadConfig(): void {
    this.cfg = loadConfigLoose();
    this.setupStatus = checkSetup(this.cfg);
  }

  // ---------- data ----------
  refresh(): void {
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
      const maxAge = this.cfg.candidates.max_age_hours;
      this.candidates = this.db.fetchActive(maxAge, 50);
      this.nonCandidates = this.db.fetchNonCandidates(maxAge, 50);
      const total = this.candidates.length + this.nonCandidates.length;
      this.selected = Math.min(this.selected, Math.max(0, total - 1));
    } else if (this.page === "keywords") {
      const built = buildKeywordItems(this.db);
      this.keywordItems = built.items;
      this.pendingSuggestionCount = built.pendingCount;
      this.unchunkedCount = this.db.unchunkedTweetCount();
      this.selected = Math.min(
        this.selected,
        Math.max(0, this.keywordItems.length - 1),
      );
    } else if (this.page === "debug") {
      try {
        this.debug.stats = this.db.stats();
      } catch {
        this.debug.stats = null;
      }
      this.debug.logTail = readLogTail(12);
      this.debug.daemonStartedAt = debugDaemonStartedAt(
        this.daemonStatus === "running",
      );
      this.debug.longBreakUntilMs =
        this.daemonStatus === "running" ? readLongBreakUntil() : null;
    } else if (this.page === "config") {
      this.setupStatus = checkSetup(this.cfg);
    }
  }

  // ---------- input ----------
  promptInput(prompt: string): Promise<string | null> {
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

  private onKey(raw: string): void {
    // Bracketed paste: the terminal wraps clipboard pastes in
    // \x1b[200~ ... \x1b[201~. Strip the markers and treat the inside as a
    // single paste event so the user's API key lands in the input buffer
    // intact instead of being shredded by parseKey.
    const PASTE_START = "\x1b[200~";
    const PASTE_END = "\x1b[201~";
    if (raw.startsWith(PASTE_START)) {
      const endIdx = raw.indexOf(PASTE_END, PASTE_START.length);
      if (endIdx >= 0) {
        this.onPaste(raw.slice(PASTE_START.length, endIdx));
        const tail = raw.slice(endIdx + PASTE_END.length);
        if (tail.length > 0) this.onKey(tail);
      } else {
        // Open-ended paste — terminal split the chunk. Best effort: take what
        // we have. A trailing partial \x1b[201~ in the next chunk will then
        // hit parseKey and be ignored as "other"; acceptable for API keys.
        this.onPaste(raw.slice(PASTE_START.length));
      }
      return;
    }
    // Fallback for terminals that don't support bracketed paste: any chunk
    // longer than 1 char with no escape sequences inside is almost certainly
    // a paste (single keypresses are either 1 char or start with \x1b).
    if (raw.length > 1 && !raw.includes("\x1b")) {
      this.onPaste(raw);
      return;
    }

    const key = parseKey(raw);

    if (this.inputMode) {
      this.onInputKey(key);
      return;
    }

    if (this.detailRow) {
      handleTweetDetailKey(this, key);
      return;
    }

    if (this.detailKeyword) {
      handleKeywordDetailKey(this, key);
      return;
    }

    if (key.kind === "ctrl-c" || isChar("q")(key)) {
      this.requestStop();
      return;
    }
    if (key.kind === "tab" || key.kind === "right") {
      const next = (PAGES.indexOf(this.page) + 1) % PAGES.length;
      this.page = PAGES[next] ?? "candidates";
      this.selected = 0;
      this.refresh();
      this.draw();
      return;
    }
    if (key.kind === "left") {
      const idx = PAGES.indexOf(this.page);
      const prev = (idx - 1 + PAGES.length) % PAGES.length;
      this.page = PAGES[prev] ?? "candidates";
      this.selected = 0;
      this.refresh();
      this.draw();
      return;
    }
    if (isChar("1", "2", "3", "4", "5")(key)) {
      const target =
        key.kind === "char" ? PAGES[Number(key.char) - 1] : undefined;
      if (target) {
        this.page = target;
        this.selected = 0;
        this.bannerSelected = false;
        this.bannerButton = 0;
        this.refresh();
        this.draw();
      }
      return;
    }

    if (handleBannerKey(this, key)) return;

    if (this.page === "candidates") handleCandidatesKey(this, key);
    else if (this.page === "keywords") handleKeywordsKey(this, key);
    else if (this.page === "config") handleConfigKey(this, key);
    else if (this.page === "about") handleAboutKey(this, key);
    else handleDebugKey(this, key);
  }

  private onPaste(text: string): void {
    // Drop control chars (newlines, tabs, NUL, …) — pasting a key with a
    // trailing newline shouldn't commit the input nor leave a literal LF in
    // the buffer.
    const clean = text.replace(/[\x00-\x1f\x7f]+/g, "");
    if (!clean) return;
    if (this.inputMode) {
      this.inputBuffer += clean;
      this.draw();
    }
    // Outside input mode: ignore. Page handlers expect one key at a time;
    // dumping a paste into them would just produce noise.
  }

  private onInputKey(key: ParsedKey): void {
    if (key.kind === "enter") {
      const r = this.inputResolver;
      const v = this.inputBuffer.trim();
      if (r) r(v.length > 0 ? v : null);
      return;
    }
    if (key.kind === "escape" || key.kind === "ctrl-c") {
      const r = this.inputResolver;
      if (r) r(null);
      return;
    }
    if (key.kind === "backspace") {
      this.inputBuffer = this.inputBuffer.slice(0, -1);
      this.draw();
      return;
    }
    if (key.kind === "char") {
      this.inputBuffer += key.char;
      this.draw();
      return;
    }
    if (key.kind === "space") {
      this.inputBuffer += " ";
      this.draw();
    }
  }

  // ---------- rendering ----------
  draw(): void {
    const cols = stdout.columns || 100;
    const rows = stdout.rows || 24;
    const out: string[] = [HOME, `${ESC}J`];
    const banner = renderBanner(this, cols);

    // Chrome accounting — every line above/below the body must be subtracted
    // from `rows` so the body can't overflow the screen and scroll the header
    // off the top.
    //   banner block: N banner lines + 1 blank separator
    //   header block: 1 header line + 1 blank separator
    //   footer block: 1 footer line (directly after body, no blank above)
    //   flash/input block (when visible): 1 blank separator + 1 content line
    const showFlash =
      this.inputMode ||
      (this.lastFlash !== null && Date.now() < this.lastFlash.until);
    const chromeAbove = (banner ? banner.length + 1 : 0) + 2;
    const chromeBelow = 1 + (showFlash ? 2 : 0);
    // -1 safety margin: cheap insurance against any off-by-one in the chrome
    // accounting. Always leaves an empty row at the very bottom instead of
    // risking a scroll that nukes the header.
    const bodyRows = Math.max(3, rows - chromeAbove - chromeBelow - 1);

    if (banner) out.push(banner.join("\n") + "\n\n");
    out.push(renderHeader(cols, this));
    out.push("\n\n");
    if (this.detailRow) {
      out.push(renderTweetDetail(cols, bodyRows, this));
    } else if (this.detailKeyword) {
      out.push(renderKeywordDetail(cols, bodyRows, this));
    } else if (this.page === "candidates") {
      out.push(renderCandidates(cols, bodyRows, this));
    } else if (this.page === "keywords") {
      out.push(renderKeywords(cols, bodyRows, this));
    } else if (this.page === "config") {
      out.push(renderConfig(cols, bodyRows, this));
    } else if (this.page === "about") {
      out.push(renderAbout(cols, bodyRows, this));
    } else {
      out.push(renderDebug(cols, bodyRows, this, getDebugItems(this)));
    }
    out.push("\n");
    out.push(renderFooter(this));
    if (this.inputMode) {
      out.push("\n\n" + renderInputBar(this));
    } else if (this.lastFlash && Date.now() < this.lastFlash.until) {
      out.push("\n\n" + DIM + this.lastFlash.msg + RESET);
    }

    // Safety net: clip the final output to `rows` line positions so a body
    // that miscounted its budget can never push the header off-screen. Control
    // sequences (HOME, CLEAR) don't contain newlines so they're harmless in
    // the count.
    const joined = out.join("");
    const lines = joined.split("\n");
    const clipped =
      lines.length > rows ? lines.slice(0, rows).join("\n") : joined;
    stdout.write(clipped);
  }
}

