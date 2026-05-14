import type { Config } from "../config.ts";
import type { DB } from "../db.ts";
import type { SetupStatus } from "../setup-check.ts";
import type { SuggestionRow, TweetRow } from "../types.ts";

// Re-export so handler modules don't need to know about ../types.ts internals.
export type { TweetRow };

export type Page = "candidates" | "keywords" | "config" | "debug" | "about";

// A row on the keywords page. "add" rows are pending suggestions to create a
// new keyword; "keyword" rows are real keyword entries that may have a pending
// remove/change suggestion attached.
export type KeywordItem =
  | { kind: "add"; suggestion: SuggestionRow }
  | {
      kind: "keyword";
      query: string;
      last_scanned_at: string | null;
      suggestion: SuggestionRow | null;
    };

export type DebugSnapshot = {
  stats: ReturnType<DB["stats"]> | null;
  logTail: string[];
  daemonStartedAt: number | null;
  /** Epoch-ms when the current long break ends, or null if not pausing. */
  longBreakUntilMs: number | null;
};

export type ActivitySnapshot = ReturnType<DB["recentActivity"]>;

export type DebugAction = {
  kind: "action";
  label: string;
  hint?: string;
  run: () => Promise<void> | void;
};

export type DebugSection = {
  kind: "section";
  id: "daemon" | "activity" | "paths" | "scheduling" | "stats" | "recent_log";
};

/** Explicit group-header row. Used to introduce a cluster of rows that
 * share a title (e.g. the "actions (Enter run)" block above the action
 * buttons). Self-contained sections render their own title inline, so they
 * don't need a separate header item. Mirrors Config's `header` kind so
 * both pages use the same grouping machinery. */
export type DebugHeader = {
  kind: "header";
  label: string;
  /** Dim trailing text after the label, e.g. " (Enter run)". */
  suffix?: string;
};

export type DebugItem = DebugSection | DebugAction | DebugHeader;

// Read view passed to render functions. The TUI class implements this and
// passes `this`; renderers may write `detailScroll` to clamp scroll position
// against the rendered content size.
export interface RenderCtx {
  cfg: Config;
  page: Page;
  selected: number;
  candidates: TweetRow[];
  nonCandidates: TweetRow[];
  keywordItems: KeywordItem[];
  pendingSuggestionCount: number;
  unchunkedCount: number;
  detailRow: TweetRow | null;
  detailKeyword: KeywordItem | null;
  detailTweets: TweetRow[];
  detailScroll: number;
  debug: DebugSnapshot;
  activity: ActivitySnapshot;
  daemonStatus: string;
  daemonPid: number | null;
  inputMode: boolean;
  inputPrompt: string;
  inputBuffer: string;
  busy: boolean;
  debugCursor: number;
  configCursor: number;
  /** Free-scroll offset for the About page (release notes). */
  aboutScroll: number;
  tweetDetailCursor: number;
  /** Timestamp of last successful copy from the tweet-detail bullets. The
   * bullets section renders a "✓ copied" notice while this is recent; null
   * means show the default "Enter to copy" hint instead. */
  tweetDetailCopiedAt: number | null;
  /** When non-null, the action item with this label renders inline as
   * "judging… <spinner>" instead of its normal text. The action that sets
   * this should also kick a fast redraw timer so the spinner animates. */
  tweetDetailBusyAction: string | null;
  /** Latest progress step emitted by the judge agentic loop, e.g.
   * "Thinking…" or "Browsing the web…". Rendered next to the spinner. */
  tweetDetailJudgeStatus: string | null;
  /** When non-null, a placeholder "refining… <status> <spinner>" bullet is
   * inserted into the reply-ideas list. Set by the `p` refine flow before
   * it calls the LLM; cleared when the new bullet is persisted (or the
   * call fails). Mirrors `tweetDetailJudgeStatus` but for the per-bullet
   * spinner rather than the action-row spinner. */
  tweetDetailRefineStatus: string | null;
  setupStatus: SetupStatus | null;
  /** Set when `git fetch` reveals upstream commits we don't have yet. The
   * header renders a "new version available" banner while this is non-null. */
  updateAvailable: { behind: number } | null;
  /** True when the user has navigated up past the top of the page onto the
   * "new version available" banner. Enter triggers the pull; Down returns
   * focus to the page. Only meaningful while updateAvailable is non-null. */
  bannerSelected: boolean;
  /** Which banner CTA has focus while `bannerSelected` is true.
   * 0 = "Update", 1 = "Enable Auto-Update". Left/Right cycles. */
  bannerButton: number;
  /** True while an auto-triggered `git pull` is in flight. The banner
   * switches to a non-interactive "Auto-updating…" state and key handling
   * is disabled until the pull completes (success → restart, failure →
   * back to interactive). */
  autoUpdating: boolean;
}

// What handler modules need from the TUI orchestrator. The TUI class
// implements this; handlers mutate state directly (RenderCtx fields are
// writable) and call back into the orchestrator through these methods.
export interface TuiHost extends RenderCtx {
  readonly db: DB;
  cfg: Config;
  flash(msg: string, ms?: number): void;
  draw(): void;
  refresh(): void;
  promptInput(prompt: string): Promise<string | null>;
  requestStop(): void;
  /** Stop the TUI loop and signal `runTui` to relaunch a fresh bun process in
   * the same terminal session (after stopping the daemon). Used by the
   * "new version available" banner after a successful `git pull`. */
  requestRestart(): void;
  /** Reload config from disk and refresh setup-status. */
  reloadConfig(): void;
}
