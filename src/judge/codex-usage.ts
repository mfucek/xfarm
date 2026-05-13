import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Codex CLI emits `account/rateLimits/updated` events on its JSONL stream
// during/after a request. The payload carries primary (short-window, typically
// 5h) and secondary (long-window, weekly) buckets. We cache the most recent
// values so the Config tab can show usage without making a probe call.

const CACHE_PATH = join(homedir(), ".xfarm", ".cache", "codex-usage.json");

export interface CodexBucket {
  used_percent: number;
  window_minutes: number;
  reset_at: string | null;
}

export interface CodexUsage {
  observed_at: string;
  primary: CodexBucket | null;
  secondary: CodexBucket | null;
}

/**
 * Inspect one parsed JSONL event from `codex exec --json`. Return the
 * extracted usage record, or null if the event isn't a rate-limit update.
 *
 * Codex names the event `account/rateLimits/updated`. The payload shape may
 * vary across CLI versions, so we accept both snake-case fields directly
 * under the event and nested objects with `primary` / `secondary` keys.
 */
export function tryExtractUsage(event: unknown): CodexUsage | null {
  if (!event || typeof event !== "object") return null;
  const ev = event as Record<string, unknown>;
  const method = pickString(ev, ["method", "type", "event", "name"]);
  // Only consider rate-limit events; ignore everything else on the bus.
  if (method && !/rateLimits|rate_limits/i.test(method)) return null;

  // The actual payload is usually one level deep under params/payload/data.
  const body =
    pickObject(ev, ["params", "payload", "data", "value", "result"]) ?? ev;

  const primary = readBucket(body, "primary");
  const secondary = readBucket(body, "secondary");
  if (!primary && !secondary) return null;

  return {
    observed_at: new Date().toISOString(),
    primary,
    secondary,
  };
}

function readBucket(obj: Record<string, unknown>, label: "primary" | "secondary"): CodexBucket | null {
  // Variant A: nested object → { primary: { used_percent, window_minutes, reset_at } }
  const nested = obj[label];
  if (nested && typeof nested === "object") {
    const o = nested as Record<string, unknown>;
    return finalizeBucket(
      o["used_percent"] ?? o["usedPercent"],
      o["window_minutes"] ?? o["windowMinutes"],
      o["reset_at"] ?? o["resetAt"] ?? o["resets_at"],
    );
  }
  // Variant B: flat keys → primary_used_percent, primary_window_minutes, primary_reset_at
  return finalizeBucket(
    obj[`${label}_used_percent`],
    obj[`${label}_window_minutes`],
    obj[`${label}_reset_at`],
  );
}

function finalizeBucket(
  used: unknown,
  window: unknown,
  resetAt: unknown,
): CodexBucket | null {
  const u = toNumber(used);
  if (u == null) return null;
  return {
    used_percent: u,
    window_minutes: toNumber(window) ?? 0,
    reset_at: typeof resetAt === "string" ? resetAt : null,
  };
}

function pickString(o: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string") return v;
  }
  return null;
}

function pickObject(o: Record<string, unknown>, keys: string[]): Record<string, unknown> | null {
  for (const k of keys) {
    const v = o[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  }
  return null;
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return null;
}

/** Persist the latest observation, merging missing buckets from prior cache. */
export function saveCodexUsage(usage: CodexUsage): void {
  const existing = loadCodexUsage();
  const merged: CodexUsage = {
    observed_at: usage.observed_at,
    primary: usage.primary ?? existing?.primary ?? null,
    secondary: usage.secondary ?? existing?.secondary ?? null,
  };
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(merged, null, 2));
}

/** Read the cached observation. Returns null if no judge call has run yet. */
export function loadCodexUsage(): CodexUsage | null {
  try {
    const raw = readFileSync(CACHE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<CodexUsage>;
    if (typeof parsed.observed_at !== "string") return null;
    return {
      observed_at: parsed.observed_at,
      primary: parsed.primary ?? null,
      secondary: parsed.secondary ?? null,
    };
  } catch {
    return null;
  }
}

export const CODEX_USAGE_CACHE_PATH = CACHE_PATH;
