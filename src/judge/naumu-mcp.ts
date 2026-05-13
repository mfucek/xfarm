import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Config } from "../config.ts";

/**
 * MCP client for the naumu graph. Connects over Streamable HTTP, exposes a
 * single `ask(question)` method that calls the `naumu_ask` tool with the
 * configured graphId.
 *
 * The connection is fire-and-forget: `connect()` runs an exponential-backoff
 * retry loop in the background; until it succeeds, `ask()` returns a short
 * sentinel string so the Judge's agentic loop can keep going (and the model
 * sees a real tool response shaped like an error, not a thrown exception).
 */
export class NaumuMcpClient {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
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
    const apiKey = this.cfg.judge.naumu.api_key.trim();
    const url = this.cfg.judge.naumu.server_url.trim();
    const graphId = this.cfg.judge.naumu.graph_id.trim();
    if (!url || !graphId) {
      console.warn(
        "[judge] naumu MCP enabled but server_url or graph_id is empty; staying offline.",
      );
      this.connecting = false;
      return;
    }

    try {
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: apiKey
          ? { headers: { Authorization: `Bearer ${apiKey}` } }
          : undefined,
      });
      const client = new Client({ name: "xfarm-judge", version: "0.2.0" });
      await client.connect(transport);
      this.client = client;
      this.transport = transport;
      this.retryDelayMs = 5000;
      console.log(`[judge] naumu MCP connected (graph=${graphId.slice(0, 8)}…)`);
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
    if (!this.client) return "<naumu unavailable>";
    const graphId = this.cfg.judge.naumu.graph_id.trim();
    try {
      const result = await this.client.callTool({
        name: "naumu_ask",
        arguments: { graphId, question },
      });
      const content = (result as { content?: unknown }).content;
      if (Array.isArray(content)) {
        const text = content
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
        if (text) return text;
      }
      return "<naumu returned no text content>";
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      console.warn(`[judge] naumu ask error: ${msg}`);
      // Transport failures kill the session; drop the client so the next
      // connect() attempt rebuilds the transport. Tool-level errors leave
      // the session intact.
      if (/closed|ECONN|fetch|socket|abort/i.test(msg)) {
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

export function isNaumuEnabled(cfg: Config): boolean {
  const n = cfg.judge.naumu;
  return n.enabled && n.server_url.trim().length > 0 && n.graph_id.trim().length > 0;
}
