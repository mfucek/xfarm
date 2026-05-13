import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "../config.ts";
import { queryCodexRateLimits, type CodexRateLimits } from "./codex-rpc.ts";

// Codex usage = result of `account/rateLimits/read` on the local
// `codex app-server`. Cached on disk so the TUI can render immediately on
// open, with a 60s TTL-driven background refresh. Spawning codex per render
// would cost ~1s of latency, so we never do that synchronously.

const CACHE_PATH = join(homedir(), ".xfarm", ".cache", "codex-usage.json");
const TTL_MS = 60_000;
const ERROR_BACKOFF_MS = 30_000;

export interface CodexBucket {
  used_percent: number;
  window_minutes: number;
  reset_at: string | null;
}

export interface CodexUsage {
  observed_at: string;
  plan_type: string | null;
  primary: CodexBucket | null;
  secondary: CodexBucket | null;
  error: string | null;
}

let inflight: Promise<CodexUsage | null> | null = null;
let lastErrorAt = 0;

/** Read the cached observation. Returns null if no refresh has succeeded. */
export function loadCodexUsage(): CodexUsage | null {
  try {
    const raw = readFileSync(CACHE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<CodexUsage>;
    if (typeof parsed.observed_at !== "string") return null;
    return {
      observed_at: parsed.observed_at,
      plan_type: parsed.plan_type ?? null,
      primary: parsed.primary ?? null,
      secondary: parsed.secondary ?? null,
      error: parsed.error ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Trigger a refresh if the cache is stale and we're not already mid-refresh
 * or in error-backoff. Returns immediately; the caller does NOT await this.
 * Reads `loadCodexUsage()` on subsequent renders to pick up the fresh data.
 */
export function refreshCodexUsageIfStale(cfg: Config): void {
  if (cfg.judge.provider !== "codex") return;
  if (inflight) return;
  const existing = loadCodexUsage();
  if (existing) {
    const ageMs = Date.now() - new Date(existing.observed_at).getTime();
    if (ageMs < TTL_MS) return;
  }
  if (lastErrorAt && Date.now() - lastErrorAt < ERROR_BACKOFF_MS) return;

  inflight = (async () => {
    try {
      const result = await queryCodexRateLimits(cfg);
      const usage = toCodexUsage(result);
      saveCodexUsage(usage);
      return usage;
    } catch (e) {
      lastErrorAt = Date.now();
      const usage: CodexUsage = {
        observed_at: new Date().toISOString(),
        plan_type: null,
        primary: null,
        secondary: null,
        error: (e as Error).message,
      };
      // Persist the error too so the UI can show what went wrong; preserve
      // the last good bucket data if we have any.
      const prior = loadCodexUsage();
      saveCodexUsage({
        ...usage,
        plan_type: prior?.plan_type ?? null,
        primary: prior?.primary ?? null,
        secondary: prior?.secondary ?? null,
      });
      return usage;
    } finally {
      inflight = null;
    }
  })();
  // Swallow unhandled rejections — the cache file is the only consumer.
  inflight.catch(() => {});
}

function toCodexUsage(r: CodexRateLimits): CodexUsage {
  return {
    observed_at: new Date(r.observedAt).toISOString(),
    plan_type: r.planType,
    primary: bucketFromWindow(r.primary),
    secondary: bucketFromWindow(r.secondary),
    error: null,
  };
}

function bucketFromWindow(w: CodexRateLimits["primary"]): CodexBucket | null {
  if (!w) return null;
  return {
    used_percent: w.usedPercent,
    window_minutes: w.windowDurationMins ?? 0,
    reset_at: w.resetsAt
      ? new Date(w.resetsAt * 1000).toISOString()
      : null,
  };
}

export function saveCodexUsage(usage: CodexUsage): void {
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(usage, null, 2));
}

export const CODEX_USAGE_CACHE_PATH = CACHE_PATH;
