import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { GoogleGenAI, Type } from "@google/genai";
import type { Config } from "./config.ts";
import type { DB } from "./db.ts";
import { sleep } from "./scraper/rate-limit.ts";
import type { JudgeResult, TweetRow } from "./types.ts";

/**
 * Resolve credentials. Priority:
 *   1. GOOGLE_VERTEX_CREDENTIALS_B64 env var (decoded to a cache file)
 *   2. cfg.judge.credentials_path (explicit SA key)
 *   3. ADC (gcloud auth application-default login) — handled by google-auth
 */
export function resolveCredentialsPath(cfg: Config): string | null {
  const b64 = process.env.GOOGLE_VERTEX_CREDENTIALS_B64;
  if (b64 && b64.trim().length > 0) {
    const cachePath = join(homedir(), ".xfarm", ".cache", "vertex-sa.json");
    mkdirSync(dirname(cachePath), { recursive: true });
    const decoded = Buffer.from(b64.replace(/\s+/g, ""), "base64");
    // sanity-check it's valid JSON before committing to disk
    try {
      const parsed = JSON.parse(decoded.toString("utf-8"));
      if (parsed.type !== "service_account") {
        throw new Error(`expected type=service_account, got ${parsed.type}`);
      }
    } catch (e) {
      throw new Error(
        `GOOGLE_VERTEX_CREDENTIALS_B64 decode failed: ${(e as Error).message}`,
      );
    }
    writeFileSync(cachePath, decoded);
    chmodSync(cachePath, 0o600);
    return cachePath;
  }
  if (cfg.judge.credentials_path) return cfg.judge.credentials_path.toString();
  return null;
}

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  required: ["score", "reason", "suggested_angle", "pitch_bullets"],
  properties: {
    score: { type: Type.NUMBER },
    reason: { type: Type.STRING },
    suggested_angle: { type: Type.STRING },
    pitch_bullets: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
  },
};

export class Judge {
  private ai: GoogleGenAI;
  private template: string | null = null;

  constructor(private cfg: Config) {
    const credPath = resolveCredentialsPath(cfg);
    if (credPath) {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = credPath;
    }
    this.ai = new GoogleGenAI({
      vertexai: true,
      project: cfg.judge.vertex_project,
      location: cfg.judge.vertex_location,
    });
  }

  private getTemplate(): string {
    if (this.template == null) {
      this.template = readFileSync(this.cfg.judge.prompt_path, "utf-8");
    }
    return this.template;
  }

  private render(t: TweetRow): string {
    const created = new Date(t.created_at).getTime();
    const minutesAgo = Math.max(0, Math.floor((Date.now() - created) / 60000));
    const vars: Record<string, string> = {
      author_handle: t.author,
      author_followers:
        t.author_followers != null ? String(t.author_followers) : "?",
      created_at: t.created_at,
      minutes_ago: String(minutesAgo),
      likes: String(t.likes ?? 0),
      replies: String(t.replies ?? 0),
      retweets: String(t.retweets ?? 0),
      velocity: t.velocity != null ? t.velocity.toFixed(2) : "?",
      text: t.text,
    };
    return this.getTemplate().replace(
      /\$(\w+)/g,
      (m, k) => vars[k] ?? m,
    );
  }

  async judgeOne(t: TweetRow): Promise<JudgeResult> {
    const prompt = this.render(t);
    const resp = await this.ai.models.generateContent({
      model: this.cfg.judge.model,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      },
    });
    const txt = resp.text ?? "";
    try {
      const data = JSON.parse(txt) as JudgeResult;
      if (typeof data.score !== "number") throw new Error("score not number");
      const bullets = Array.isArray(data.pitch_bullets)
        ? data.pitch_bullets.filter((b) => typeof b === "string" && b.trim())
        : [];
      return {
        score: data.score,
        reason: data.reason ?? "",
        suggested_angle: data.suggested_angle ?? "",
        pitch_bullets: bullets,
      };
    } catch (e) {
      console.warn(
        `[judge] non-JSON response for id=${t.id}: ${(e as Error).message}\nbody: ${txt.slice(0, 300)}`,
      );
      return {
        score: 0,
        reason: "parse_error",
        suggested_angle: "",
        pitch_bullets: [],
      };
    }
  }
}

export async function judgeLoop(
  judge: Judge,
  db: DB,
  stop: AbortSignal,
): Promise<void> {
  while (!stop.aborted) {
    const pending = db.fetchDueForJudge();
    if (pending.length === 0) {
      await sleep(5000);
      continue;
    }
    for (const t of pending) {
      if (stop.aborted) return;
      try {
        const r = await judge.judgeOne(t);
        db.markJudged(
          t.id,
          r.score,
          r.reason,
          r.suggested_angle,
          r.pitch_bullets,
        );
        console.log(
          `[judge] @${t.author} id=${t.id.slice(0, 12)} -> ${r.score.toFixed(
            1,
          )} (${r.reason.slice(0, 80)})`,
        );
      } catch (e) {
        console.error(`[judge] error on id=${t.id}:`, e);
        db.markJudged(t.id, 0, "judge_error", "", []);
      }
      await sleep(500);
    }
  }
}
