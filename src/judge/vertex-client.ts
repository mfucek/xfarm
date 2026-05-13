import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type Content,
  type FunctionCall,
  type FunctionDeclaration,
  GoogleGenAI,
  type Part,
  type Tool as GenAiTool,
  Type,
} from "@google/genai";
import type { Config } from "../config.ts";
import type { JsonSchema, LlmClient, Tool } from "./llm.ts";

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

  async generateJsonAgentic<T = unknown>(
    prompt: string,
    schema: JsonSchema,
    tools: Tool[],
    maxIterations = 5,
  ): Promise<T> {
    const declarations: FunctionDeclaration[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: toGenAiSchema(t.parameters) as never,
    }));
    const handlers = new Map(tools.map((t) => [t.name, t.handler]));
    const toolConfig: GenAiTool[] = [{ functionDeclarations: declarations }];

    const contents: Content[] = [
      { role: "user", parts: [{ text: prompt }] },
    ];

    // Phase 1: agentic turns. Gemini disallows structured output when tools
    // are bound, so we let the model freely call tools and emit prose; the
    // final structured response comes from a separate call below.
    for (let iter = 0; iter < maxIterations; iter++) {
      const resp = await this.ai.models.generateContent({
        model: this.cfg.judge.model,
        contents,
        config: { tools: toolConfig },
      });
      const calls: FunctionCall[] = resp.functionCalls ?? [];
      if (calls.length === 0) break;

      // Echo the model's tool-call parts back into history so it sees what
      // it asked for, then attach matching functionResponse parts.
      const modelParts = resp.candidates?.[0]?.content?.parts ?? [];
      contents.push({ role: "model", parts: modelParts });

      const responseParts: Part[] = [];
      for (const call of calls) {
        const name = call.name ?? "";
        const args = (call.args ?? {}) as Record<string, unknown>;
        const handler = handlers.get(name);
        let result: string;
        if (!handler) {
          result = `<no handler registered for tool ${name}>`;
        } else {
          try {
            console.log(
              `[judge] tool ${name}(${JSON.stringify(args).slice(0, 120)})`,
            );
            result = await handler(args);
            console.log(`[judge] tool ${name} -> ${result.slice(0, 120)}`);
          } catch (e) {
            result = `<tool-error: ${(e as Error).message}>`;
          }
        }
        responseParts.push({
          functionResponse: {
            id: call.id,
            name,
            response: { output: result },
          },
        });
      }
      contents.push({ role: "user", parts: responseParts });
    }

    // Phase 2: final structured-output turn. Drop tools, append a marker so
    // the model knows we want the JSON now, and enforce the response schema.
    contents.push({
      role: "user",
      parts: [
        {
          text:
            "Now produce the final response as strict JSON matching the required schema. " +
            "Do not call any more tools.",
        },
      ],
    });
    const finalResp = await this.ai.models.generateContent({
      model: this.cfg.judge.model,
      contents,
      config: {
        responseMimeType: "application/json",
        responseSchema: toGenAiSchema(schema) as never,
      },
    });
    const txt = finalResp.text ?? "";
    return JSON.parse(txt) as T;
  }
}
