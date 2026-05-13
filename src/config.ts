import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
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

const JudgeSchema = z.object({
  vertex_project: z.string(),
  vertex_location: z.string().default("us-central1"),
  model: z.string().default("gemini-2.5-flash"),
  notify_threshold: z.number().min(0).max(10).default(7.0),
  prompt_path: PathStr,
  credentials_path: PathStr.nullable().optional(),
});

const NotifierSchema = z.object({
  enabled: z.boolean().default(true),
  sound: z.string().default("Glass"),
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
  judge: JudgeSchema,
  notifier: NotifierSchema.default({ enabled: true, sound: "Glass" }),
  storage: StorageSchema.default({ db_path: expandPath("~/.xfarm/data.db") }),
  logging: LoggingSchema.default({
    level: "INFO",
    path: expandPath("~/.xfarm/xfarm.log"),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG_PATH = expandPath("~/.xfarm/config.yaml");

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
  return ConfigSchema.parse(parsed);
}
