import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";

const expandPath = (p: string): string => {
  if (p.startsWith("~/") || p === "~") {
    return resolve(p.replace(/^~/, homedir()));
  }
  return resolve(p);
};

const PathStr = z.string().transform(expandPath);

const ScraperSchema = z.object({
  burner_cookies_path: PathStr,
  // Path defaults must be pre-expanded: Zod's .default() bypasses .transform().
  profile_path: PathStr.default(expandPath("~/.xfarm/browser-profile")),
  user_agent: z.string(),
  max_requests_per_minute: z.number().int().positive().default(25),
  jitter_pct: z.number().int().min(0).max(100).default(20),
  headless: z.boolean().default(true),
});

const WatchlistAuthorSchema = z.object({
  handle: z.string(),
  tier: z.number().int().min(1).max(3).default(2),
});

const WatchlistSchema = z.object({
  scan_interval_sec: z.number().int().positive().default(60),
  authors: z.array(WatchlistAuthorSchema).default([]),
});

const KeywordsSchema = z.object({
  scan_interval_sec: z.number().int().positive().default(300),
  queries: z.array(z.string()).default([]),
});

const VelocitySchema = z.object({
  tracker_interval_sec: z.number().int().positive().default(180),
  max_age_hours: z.number().int().positive().default(2),
});

const GateSchema = z.object({
  min_velocity: z.number().nonnegative().default(3.0),
  velocity_window_min: z.number().int().positive().default(30),
  min_likes_absolute: z.number().int().nonnegative().default(50),
});

const ScheduleSchema = z.object({
  // Quiet hours: scraping is paused outside this window (local time, 0..23).
  active_hours_start: z.number().int().min(0).max(23).default(0),
  active_hours_end: z.number().int().min(0).max(23).default(0),
  // Global scrape cadence: one scrape every base_interval_sec + uniform(-jitter, +jitter).
  // Default = 30 ± 30s -> 0..60s between scrapes (~2/min mean).
  base_interval_sec: z.number().int().positive().default(30),
  jitter_sec: z.number().int().nonnegative().default(30),
  // Every long_break_after scrapes, take a long_break_sec pause. Set after=0 to disable.
  long_break_after: z.number().int().nonnegative().default(30),
  long_break_sec: z.number().int().nonnegative().default(600),
  // Home timeline: visit roughly this often (seconds between visits).
  home_interval_sec: z.number().int().positive().default(900),
});

// "gemini" → Vertex AI Gemini (pay-per-token GCP). "codex" → OpenAI Codex CLI
// (uses your ChatGPT subscription via `codex login`).
const ProviderSchema = z.enum(["gemini", "codex"]).default("gemini");

const JudgeSchema = z.object({
  provider: ProviderSchema,
  // Gemini / Vertex fields. Required when provider === "gemini" (validated
  // after parse); ignored otherwise.
  vertex_project: z.string().optional().default(""),
  vertex_location: z.string().default("us-central1"),
  model: z.string().default("gemini-2.5-flash"),
  credentials_path: PathStr.nullable().optional(),
  // Codex CLI fields. Used when provider === "codex".
  codex_model: z.string().default("gpt-5-codex"),
  codex_bin: z.string().default("codex"),
  notify_threshold: z.number().min(0).max(10).default(7.0),
  prompt_path: PathStr,
});

const NotifierSchema = z.object({
  enabled: z.boolean().default(true),
  sound: z.string().default("Glass"),
});

const SuggesterSchema = z.object({
  enabled: z.boolean().default(true),
  // Tweets per LLM call. Each tweet is bucketed into exactly one chunk so
  // the model never re-analyzes the same evidence.
  chunk_size: z.number().int().positive().default(100),
  prompt_path: PathStr.default(expandPath("./prompts/keyword-suggester.md")),
});

const StorageSchema = z.object({
  db_path: PathStr.default(expandPath("~/.xfarm/data.db")),
});

const LoggingSchema = z.object({
  level: z.enum(["DEBUG", "INFO", "WARN", "ERROR"]).default("INFO"),
  path: PathStr.default(expandPath("~/.xfarm/xfarm.log")),
});

const ConfigSchema = z.object({
  scraper: ScraperSchema,
  watchlist: WatchlistSchema.default({ scan_interval_sec: 60, authors: [] }),
  keywords: KeywordsSchema.default({ scan_interval_sec: 300, queries: [] }),
  velocity: VelocitySchema.default({ tracker_interval_sec: 180, max_age_hours: 2 }),
  gate: GateSchema.default({
    min_velocity: 3.0,
    velocity_window_min: 30,
    min_likes_absolute: 50,
  }),
  schedule: ScheduleSchema.default({
    active_hours_start: 0,
    active_hours_end: 0,
    base_interval_sec: 30,
    jitter_sec: 30,
    long_break_after: 30,
    long_break_sec: 600,
    home_interval_sec: 900,
  }),
  judge: JudgeSchema,
  notifier: NotifierSchema.default({ enabled: true, sound: "Glass" }),
  suggester: SuggesterSchema.default({
    enabled: true,
    chunk_size: 100,
    prompt_path: expandPath("./prompts/keyword-suggester.md"),
  }),
  storage: StorageSchema.default({ db_path: expandPath("~/.xfarm/data.db") }),
  logging: LoggingSchema.default({
    level: "INFO",
    path: expandPath("~/.xfarm/xfarm.log"),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG_PATH = expandPath("~/.xfarm/config.yaml");

function applyEnvOverrides(cfg: Config): Config {
  // .env values (loaded automatically by Bun) override config.yaml.
  // Keeps secrets and per-environment values out of the YAML.
  const projectEnv = process.env.GOOGLE_VERTEX_PROJECT_ID;
  if (projectEnv && projectEnv.trim().length > 0) {
    cfg.judge.vertex_project = projectEnv.trim();
  }
  const locationEnv = process.env.GOOGLE_VERTEX_LOCATION;
  if (locationEnv && locationEnv.trim().length > 0) {
    cfg.judge.vertex_location = locationEnv.trim();
  }
  return cfg;
}

/**
 * Ensure a config.yaml exists at the default path, seeding it from
 * config.example.yaml on first run. Returns the resolved config path.
 */
export function ensureConfigFile(): string {
  const dest = DEFAULT_CONFIG_PATH;
  if (existsSync(dest)) return dest;
  mkdirSync(dirname(dest), { recursive: true });
  // src/config.ts lives at src/; the example sits at the repo root.
  const example = resolve(import.meta.dir, "..", "config.example.yaml");
  if (existsSync(example)) {
    copyFileSync(example, dest);
  } else {
    writeFileSync(dest, "scraper: {}\njudge: {}\n");
  }
  return dest;
}

/**
 * Parse-only loader that does NOT enforce cross-field invariants like
 * "Vertex project required when provider=gemini". Used by the Config tab so
 * the user can edit their way out of an invalid state from inside the app.
 * Falls back to a default-shaped config if the file is missing or unparseable.
 */
export function loadConfigLoose(path?: string): Config {
  const p = path ? expandPath(path) : DEFAULT_CONFIG_PATH;
  let parsed: unknown = {};
  if (existsSync(p)) {
    try {
      parsed = yaml.load(readFileSync(p, "utf-8")) ?? {};
    } catch {
      parsed = {};
    }
  }
  const validated = ConfigSchema.safeParse(parsed);
  if (validated.success) return applyEnvOverrides(validated.data);
  // Fall back to fully-defaulted shape so the TUI has something to work with.
  // prompt_path is the only field without a sensible default; supply the bundled one.
  const fallback = ConfigSchema.parse({
    scraper: {
      burner_cookies_path: "~/.xfarm/cookies.json",
      user_agent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    },
    judge: { prompt_path: "./prompts/judge.md" },
  });
  return applyEnvOverrides(fallback);
}

/**
 * Persist arbitrary patches into ~/.xfarm/config.yaml. Reads the existing
 * YAML (so we don't drop comments-adjacent keys we don't know about),
 * deep-merges the patch, and writes it back.
 */
export function patchConfigFile(patch: Record<string, unknown>): void {
  ensureConfigFile();
  const p = DEFAULT_CONFIG_PATH;
  let current: Record<string, unknown> = {};
  try {
    const loaded = yaml.load(readFileSync(p, "utf-8"));
    if (loaded && typeof loaded === "object") current = loaded as Record<string, unknown>;
  } catch {
    /* fall through to empty */
  }
  const merged = deepMerge(current, patch);
  writeFileSync(p, yaml.dump(merged, { lineWidth: 120 }));
}

function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k];
    if (
      v && typeof v === "object" && !Array.isArray(v) &&
      cur && typeof cur === "object" && !Array.isArray(cur)
    ) {
      out[k] = deepMerge(cur as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Path to the burner cookies file expected by the scraper. */
export const DEFAULT_COOKIES_PATH = expandPath("~/.xfarm/cookies.json");

/** Write burner cookies to ~/.xfarm/cookies.json with 0600 perms. */
export function writeBurnerCookies(
  username: string,
  auth_token: string,
  ct0: string,
): string {
  mkdirSync(dirname(DEFAULT_COOKIES_PATH), { recursive: true });
  const cleaned = {
    username: username.trim().replace(/^@/, ""),
    auth_token: auth_token.trim(),
    ct0: ct0.trim(),
  };
  writeFileSync(DEFAULT_COOKIES_PATH, JSON.stringify(cleaned, null, 2));
  try {
    chmodSync(DEFAULT_COOKIES_PATH, 0o600);
  } catch {
    /* platforms without POSIX perms — fine */
  }
  return DEFAULT_COOKIES_PATH;
}

export function loadConfig(path?: string): Config {
  const p = path ? expandPath(path) : DEFAULT_CONFIG_PATH;
  let raw: string;
  try {
    raw = readFileSync(p, "utf-8");
  } catch {
    throw new Error(
      `Config not found at ${p}. Copy config.example.yaml there and edit.`,
    );
  }
  const parsed = yaml.load(raw);
  const validated = ConfigSchema.parse(parsed);
  const final = applyEnvOverrides(validated);
  if (final.judge.provider === "gemini" && !final.judge.vertex_project) {
    throw new Error(
      "Vertex project ID is required when judge.provider='gemini'. " +
        "Set `judge.vertex_project` in config.yaml, GOOGLE_VERTEX_PROJECT_ID " +
        "in .env, or switch to provider='codex' in the Config tab.",
    );
  }
  return final;
}
