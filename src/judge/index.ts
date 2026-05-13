import { readFileSync } from "node:fs";
import type { Config } from "../config.ts";
import type { DB } from "../db.ts";
import { sleep } from "../scraper/rate-limit.ts";
import type { JudgeResult, TweetRow } from "../types.ts";
import { CodexClient } from "./codex-client.ts";
import type { JsonSchema, LlmClient, Tool } from "./llm.ts";
import type { NaumuMcpClient } from "./naumu-mcp.ts";
import { VertexClient } from "./vertex-client.ts";

export { resolveCredentialsPath } from "./vertex-client.ts";
export type { LlmClient } from "./llm.ts";

/** Build the LLM client matching cfg.judge.provider. */
export function makeLlmClient(cfg: Config): LlmClient {
  return cfg.judge.provider === "codex"
    ? new CodexClient(cfg)
    : new VertexClient(cfg);
}

const JUDGE_SCHEMA: JsonSchema = {
  type: "object",
  required: ["score", "reason", "suggested_angle", "pitch_bullets"],
  properties: {
    score: { type: "number" },
    reason: { type: "string" },
    suggested_angle: { type: "string" },
    pitch_bullets: { type: "array", items: { type: "string" } },
  },
};

export class Judge {
  private template: string | null = null;
  private llm: LlmClient;

  constructor(
    private cfg: Config,
    private naumu: NaumuMcpClient | null = null,
  ) {
    this.llm = makeLlmClient(cfg);
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
    return this.getTemplate().replace(/\$(\w+)/g, (m, k) => vars[k] ?? m);
  }

  private buildNaumuTool(): Tool | null {
    const naumu = this.naumu;
    if (!naumu) return null;
    return {
      name: "ask_naumu",
      description:
        "Ask the naumu knowledge graph a directed question (e.g. \"what does naumu say about agent memory vs chunked RAG?\"). Returns a short prose answer grounded in the graph. Use sparingly — only when grounding will sharpen pitch_bullets with a concrete naumu-specific claim.",
      parameters: {
        type: "object",
        required: ["question"],
        properties: { question: { type: "string" } },
      },
      handler: async (args) => naumu.ask(String(args.question ?? "")),
    };
  }

  async judgeOne(t: TweetRow): Promise<JudgeResult> {
    const prompt = this.render(t);
    try {
      const naumuTool = this.buildNaumuTool();
      const useAgentic =
        naumuTool != null &&
        this.naumu?.ready === true &&
        typeof this.llm.generateJsonAgentic === "function";
      const data = useAgentic
        ? await this.llm.generateJsonAgentic!<JudgeResult>(
            prompt,
            JUDGE_SCHEMA,
            [naumuTool!],
            this.cfg.judge.naumu.max_tool_calls + 1,
          )
        : await this.llm.generateJson<JudgeResult>(prompt, JUDGE_SCHEMA);
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
        `[judge] bad response for id=${t.id}: ${(e as Error).message}`,
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
