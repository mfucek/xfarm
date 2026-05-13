import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { GoogleGenAI, Type } from "@google/genai";
import type { Config } from "../config.ts";
import type { JsonSchema, LlmClient } from "./llm.ts";

/**
 * Resolve Vertex credentials. Priority:
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

// Translate our minimal JsonSchema into Google's Type enum-based schema.
function toGenAiSchema(s: JsonSchema): Record<string, unknown> {
  if (s.type === "string") {
    return s.enum ? { type: Type.STRING, enum: s.enum } : { type: Type.STRING };
  }
  if (s.type === "number") return { type: Type.NUMBER };
  if (s.type === "boolean") return { type: Type.BOOLEAN };
  if (s.type === "array") {
    return { type: Type.ARRAY, items: toGenAiSchema(s.items) };
  }
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s.properties)) {
    props[k] = toGenAiSchema(v);
  }
  return {
    type: Type.OBJECT,
    required: s.required ?? [],
    properties: props,
  };
}

export class VertexClient implements LlmClient {
  private ai: GoogleGenAI;

  constructor(private cfg: Config) {
    const credPath = resolveCredentialsPath(cfg);
    if (credPath) process.env.GOOGLE_APPLICATION_CREDENTIALS = credPath;
    this.ai = new GoogleGenAI({
      vertexai: true,
      project: cfg.judge.vertex_project,
      location: cfg.judge.vertex_location,
    });
  }

  async generateJson<T = unknown>(prompt: string, schema: JsonSchema): Promise<T> {
    const resp = await this.ai.models.generateContent({
      model: this.cfg.judge.model,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: toGenAiSchema(schema) as never,
      },
    });
    const txt = resp.text ?? "";
    return JSON.parse(txt) as T;
  }
}
