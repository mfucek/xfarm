import { readFileSync } from "node:fs";
import { GoogleGenAI, Type } from "@google/genai";
import type { Config } from "./config.ts";
import type { DB } from "./db.ts";
import { resolveCredentialsPath } from "./judge.ts";
import { sleep } from "./scraper/rate-limit.ts";
import type { SuggestionVerdict, TweetRow } from "./types.ts";

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  required: ["suggestions"],
  properties: {
    suggestions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: ["verdict", "keyword", "reason"],
        properties: {
          verdict: { type: Type.STRING, enum: ["add", "remove", "change"] },
          keyword: { type: Type.STRING },
          // Required only when verdict='change'. Vertex doesn't support
          // conditional required, so list it as optional and validate later.
          replacement: { type: Type.STRING },
          reason: { type: Type.STRING },
        },
      },
    },
  },
};

type RawSuggestion = {
  verdict: string;
  keyword: string;
  replacement?: string;
  reason: string;
};

export class Suggester {
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
      this.template = readFileSync(this.cfg.suggester.prompt_path, "utf-8");
    }
    return this.template;
  }

  private formatTweet(t: TweetRow): string {
    const ageMin = Math.max(
      0,
      Math.floor((Date.now() - new Date(t.created_at).getTime()) / 60_000),
    );
    const text = t.text.replace(/\s+/g, " ").trim().slice(0, 280);
    return `[${t.source}] @${t.author} (${ageMin}m, ${t.likes ?? 0}♥/${t.replies ?? 0}↩) ${text}`;
  }

  private render(
    chunkId: number,
    tweets: TweetRow[],
    keywords: string[],
  ): string {
    const vars: Record<string, string> = {
      chunk_id: String(chunkId),
      tweet_count: String(tweets.length),
      current_keywords:
        keywords.length === 0 ? "(none)" : keywords.join("\n"),
      tweets: tweets.map((t) => this.formatTweet(t)).join("\n"),
    };
    return this.getTemplate().replace(
      /\$(\w+)/g,
      (m, k) => vars[k] ?? m,
    );
  }

  async suggest(
    chunkId: number,
    tweets: TweetRow[],
    keywords: string[],
  ): Promise<
    {
      verdict: SuggestionVerdict;
      keyword: string;
      replacement?: string | null;
      reason: string;
    }[]
  > {
    const prompt = this.render(chunkId, tweets, keywords);
    const resp = await this.ai.models.generateContent({
      model: this.cfg.judge.model,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      },
    });
    const txt = resp.text ?? "";
    const data = JSON.parse(txt) as { suggestions?: RawSuggestion[] };
    const raw = data.suggestions ?? [];
    const existing = new Set(keywords);
    const out: {
      verdict: SuggestionVerdict;
      keyword: string;
      replacement?: string | null;
      reason: string;
    }[] = [];
    const seenAdd = new Set<string>();
    const seenRemove = new Set<string>();
    const seenChange = new Set<string>();
    for (const r of raw) {
      const kw = (r.keyword ?? "").trim();
      if (!kw) continue;
      const reason = (r.reason ?? "").trim().slice(0, 200);
      if (r.verdict === "add") {
        if (existing.has(kw) || seenAdd.has(kw)) continue;
        seenAdd.add(kw);
        out.push({ verdict: "add", keyword: kw, reason });
      } else if (r.verdict === "remove") {
        if (!existing.has(kw) || seenRemove.has(kw)) continue;
        seenRemove.add(kw);
        out.push({ verdict: "remove", keyword: kw, reason });
      } else if (r.verdict === "change") {
        const repl = (r.replacement ?? "").trim();
        // Must be an actual swap: old keyword exists, new keyword is real,
        // and the two differ.
        if (!repl || kw === repl) continue;
        if (!existing.has(kw) || existing.has(repl)) continue;
        if (seenChange.has(kw)) continue;
        seenChange.add(kw);
        out.push({ verdict: "change", keyword: kw, replacement: repl, reason });
      }
    }
    return out;
  }
}

export async function suggesterLoop(
  suggester: Suggester,
  db: DB,
  cfg: Config,
  stop: AbortSignal,
): Promise<void> {
  const size = cfg.suggester.chunk_size;
  while (!stop.aborted) {
    const claimed = db.claimNextSuggestionChunk(size);
    if (!claimed) {
      // Not enough tweets yet — wait. Scale wait to ingest rate: at ~10/min,
      // a chunk of 100 takes ~10 min, so check every minute.
      await sleep(60_000);
      continue;
    }
    const { chunkId, tweets } = claimed;
    const keywords = db.listKeywords().map((k) => k.query);
    try {
      const suggestions = await suggester.suggest(chunkId, tweets, keywords);
      db.insertSuggestions(chunkId, suggestions);
      db.markChunkJudged(chunkId);
      console.log(
        `[suggester] chunk ${chunkId} (${tweets.length} tweets) -> ${suggestions.length} suggestions`,
      );
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      console.error(`[suggester] chunk ${chunkId} failed:`, msg);
      db.markChunkFailed(chunkId, msg);
      // Back off before next attempt; the tweets remain bucketed to this
      // chunk so they're not re-analyzed.
      await sleep(30_000);
    }
  }
}
