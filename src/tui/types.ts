import type { Config } from "../config.ts";
import type { DB } from "../db.ts";
import type { SetupStatus } from "../setup-check.ts";
import type { SuggestionRow, TweetRow } from "../types.ts";

// Re-export so handler modules don't need to know about ../types.ts internals.
export type { TweetRow };

export type Page = "candidates" | "keywords" | "config" | "debug";

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

export type DebugItem = DebugSection | DebugAction;

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
  tweetDetailCursor: number;
  /** Timestamp of last successful copy from the tweet-detail bullets. The
   * bullets section renders a "✓ copied" notice while this is recent; null
   * means show the default "Enter to copy" hint instead. */
  tweetDetailCopiedAt: number | null;
  setupStatus: SetupStatus | null;
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
  /** Reload config from disk and refresh setup-status. */
  reloadConfig(): void;
}
