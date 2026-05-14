import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Config } from "../config.ts";

/**
 * MCP client for the naumu graph. The `@naumu/mcp` package is a stdio
 * subprocess (no HTTP/SSE), so we spawn it under our process and hand it
 * NAUMU_API_KEY / NAUMU_API_URL via the environment.
 *
 * `ask()` uses the user-key-friendly `naumu_ask` path: it creates a thread,
 * posts the question async, gets back a threadId, then polls
 * `naumu_get_ai_thread` until the assistant message is `status: "complete"`.
 * The other ask-style tool, `naumu_ask_naumu`, requires NAUMU_IDENTITY_ID
 * and a bot key — we explicitly avoid it so user keys work out of the box.
 *
 * The connection is fire-and-forget: `connect()` runs an exponential-backoff
 * retry loop in the background; until it succeeds, `ask()` returns a short
 * sentinel string so the Judge's agentic loop can keep going and the model
 * sees a real tool response shaped like an error instead of a thrown
 * exception.
 */
const ASK_POLL_TIMEOUT_MS = 90_000;
const ASK_POLL_INITIAL_MS = 1_000;
const ASK_POLL_MAX_MS = 5_000;
export class NaumuMcpClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelayMs = 5000;
  private closed = false;
  private connecting = false;

  constructor(private cfg: Config) {}

  get ready(): boolean {
    return this.client != null;
  }

  /**
   * Begin connecting. Does not throw on failure — schedules a retry instead.
   * Caller can fire-and-forget.
   */
  async connect(): Promise<void> {
    if (this.closed || this.connecting || this.client) return;
    this.connecting = true;
    const n = this.cfg.judge.naumu;
    const apiKey = n.api_key.trim();
    const graphId = n.graph_id.trim();
    if (!apiKey || !graphId) {
      console.warn(
        "[judge] naumu MCP enabled but api_key or graph_id is empty; staying offline.",
      );
      this.connecting = false;
      return;
    }

    try {
      const env: Record<string, string> = {
        ...getDefaultEnvironment(),
        NAUMU_API_KEY: apiKey,
      };
      if (n.api_url.trim()) env.NAUMU_API_URL = n.api_url.trim();
      // NAUMU_IDENTITY_ID is only used by `naumu_ask_naumu`, which we don't
      // call. Still pass it through if the user set one, in case future
      // tools depend on it — harmless when empty.
      if (n.identity_id.trim()) env.NAUMU_IDENTITY_ID = n.identity_id.trim();

      const transport = new StdioClientTransport({
        command: n.command,
        args: n.args,
        env,
        // Surface the subprocess's startup logs to our stderr so connection
        // failures (bad key, no network, npx still resolving) are visible.
        stderr: "inherit",
      });
      const client = new Client({ name: "xfarm-judge", version: "0.2.0" });
      await client.connect(transport);
      this.client = client;
      this.transport = transport;
      this.retryDelayMs = 5000;
      console.log(
        `[judge] naumu MCP connected (pid=${transport.pid ?? "?"}, graph=${graphId.slice(0, 8)}…)`,
      );
    } catch (e) {
      const delaySec = Math.round(this.retryDelayMs / 1000);
      console.warn(
        `[judge] naumu MCP unavailable: ${(e as Error).message}; retrying in ${delaySec}s`,
      );
      this.scheduleRetry();
    } finally {
      this.connecting = false;
    }
  }

  private scheduleRetry(): void {
    if (this.closed || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryDelayMs = Math.min(this.retryDelayMs * 2, 60000);
      void this.connect();
    }, this.retryDelayMs);
  }

  async ask(question: string): Promise<string> {
    const client = this.client;
    if (!client) return "<naumu unavailable>";
    const graphId = this.cfg.judge.naumu.graph_id.trim();
    try {
      // 1) Open a thread and post the message async. Returns immediately
      //    with { threadId, status: 'processing' }.
      const startResp = await client.callTool({
        name: "naumu_ask",
        arguments: { graphId, question },
      });
      if ((startResp as { isError?: boolean }).isError) {
        const text = extractText(startResp) || "ask failed";
        return `<naumu-error: ${text.slice(0, 200)}>`;
      }
      const startJson = safeParseJson(extractText(startResp)) as
        | { threadId?: unknown }
        | null;
      const threadId =
        typeof startJson?.threadId === "string" ? startJson.threadId : "";
      if (!threadId) {
        return "<naumu-error: ask returned no threadId>";
      }

      // 2) Poll naumu_get_ai_thread until the last assistant message lands
      //    with status: "complete" (or "error"), or we hit the timeout.
      const startMs = Date.now();
      let intervalMs = ASK_POLL_INITIAL_MS;
      while (Date.now() - startMs < ASK_POLL_TIMEOUT_MS) {
        await sleep(intervalMs);
        intervalMs = Math.min(Math.floor(intervalMs * 1.5), ASK_POLL_MAX_MS);

        const pollResp = await client.callTool({
          name: "naumu_get_ai_thread",
          arguments: { threadId },
        });
        if ((pollResp as { isError?: boolean }).isError) continue;
        const messages = extractAiMessages(extractText(pollResp));
        if (!messages.length) continue;
        const lastAi = messages[messages.length - 1];
        if (!lastAi) continue;
        if (lastAi.status === "complete") {
          const content = lastAi.content.trim();
          return content || "<naumu returned empty answer>";
        }
        if (lastAi.status === "error") {
          return "<naumu-error: agent reported error status>";
        }
        // status: "processing" (or unset) — keep polling.
      }
      return "<naumu-error: timed out waiting for agent response>";
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      console.warn(`[judge] naumu ask error: ${msg}`);
      // Transport-level failures (subprocess died, pipe closed) — drop the
      // client so the next connect() rebuilds it.
      if (/closed|EPIPE|ECONN|exited|aborted/i.test(msg)) {
        this.client = null;
        this.transport = null;
        this.scheduleRetry();
      }
      return `<naumu-error: ${msg.slice(0, 200)}>`;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const client = this.client;
    this.client = null;
    this.transport = null;
    if (client) {
      try {
        await client.close();
      } catch {
        /* best effort */
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

type AiMessage = { content: string; status: string | null };

/**
 * Pull AI-authored messages out of a `naumu_get_ai_thread` response, oldest
 * first. The response is a paginated `{ messages: Message[] }` blob (see
 * packages/backend/src/modules/threads/types.ts:77 for the Message shape);
 * AI rows are flagged with `isAI: true` and carry `status` of
 * "processing" | "complete" | "error".
 */
function extractAiMessages(text: string): AiMessage[] {
  const parsed = safeParseJson(text) as
    | { messages?: unknown }
    | null;
  const raw = parsed?.messages;
  if (!Array.isArray(raw)) return [];
  const out: AiMessage[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const row = m as { isAI?: unknown; content?: unknown; status?: unknown };
    if (row.isAI !== true) continue;
    if (typeof row.content !== "string") continue;
    out.push({
      content: row.content,
      status: typeof row.status === "string" ? row.status : null,
    });
  }
  return out;
}

function extractText(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (c): c is { type: "text"; text: string } =>
        c != null &&
        typeof c === "object" &&
        (c as { type?: unknown }).type === "text" &&
        typeof (c as { text?: unknown }).text === "string",
    )
    .map((c) => c.text)
    .join("\n")
    .trim();
}

export function isNaumuEnabled(cfg: Config): boolean {
  const n = cfg.judge.naumu;
  return n.enabled && n.api_key.trim().length > 0 && n.graph_id.trim().length > 0;
}
