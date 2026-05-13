import { spawn } from "node:child_process";
import type { Config } from "../config.ts";

// Codex's `app-server` mode speaks newline-delimited JSON-RPC over stdio.
// We open a one-shot session, send `initialize` then `account/rateLimits/read`,
// and shut down. Spawning a fresh process per call costs ~1s of startup —
// fine since we only do this every 60s and only while the Config tab is up.

// Wire shape confirmed from /tmp/codex-schema/v2/GetAccountRateLimitsResponse.json:
//   { rateLimits: { primary, secondary, planType, ... }, rateLimitsByLimitId: {…} }
//   where each bucket = { usedPercent: int, resetsAt: int64-seconds?, windowDurationMins: int? }

export interface CodexRateLimitWindow {
  usedPercent: number;
  resetsAt: number | null;
  windowDurationMins: number | null;
}

export interface CodexRateLimits {
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  planType: string | null;
  observedAt: number; // unix ms
}

/**
 * Spawn `codex app-server`, run the initialize handshake, and call
 * `account/rateLimits/read`. Returns the parsed response, or throws.
 *
 * Each call is one process: simpler than holding a long-lived child and
 * cheap enough given the 60s polling cadence.
 */
export async function queryCodexRateLimits(cfg: Config): Promise<CodexRateLimits> {
  const messages = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "xfarm", version: "0.2.0" } },
    },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "account/rateLimits/read",
      params: null,
    },
  ];
  const stdinPayload = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
  const stdout = await runAppServer(cfg, stdinPayload);
  return parseRateLimits(stdout);
}

function runAppServer(cfg: Config, stdinPayload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cfg.judge.codex_bin, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutBufs: Buffer[] = [];
    const stderrBufs: Buffer[] = [];
    let settled = false;

    // We resolve as soon as we see a complete JSON line with id=2 on stdout.
    // Important: we leave stdin OPEN until we've seen that response, because
    // closing stdin early causes app-server to terminate before processing
    // queued requests.
    child.stdout.on("data", (b: Buffer) => {
      stdoutBufs.push(b);
      const text = Buffer.concat(stdoutBufs).toString("utf-8");
      // Look for a complete line containing `"id":2` — avoid resolving on
      // a partial chunk that happens to contain the substring.
      for (const line of text.split(/\r?\n/)) {
        if (!line.includes('"id":2')) continue;
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          if (obj["id"] === 2) {
            if (settled) return;
            settled = true;
            try {
              child.stdin.end();
            } catch {
              /* stdin already closed */
            }
            try {
              child.kill("SIGTERM");
            } catch {
              /* already gone */
            }
            resolve(text);
            return;
          }
        } catch {
          /* partial line; keep buffering */
        }
      }
    });
    child.stderr.on("data", (b: Buffer) => stderrBufs.push(b));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    child.on("close", () => {
      if (settled) return;
      settled = true;
      const err = Buffer.concat(stderrBufs).toString("utf-8");
      const out = Buffer.concat(stdoutBufs).toString("utf-8");
      reject(
        new Error(
          `codex app-server closed without responding to rateLimits/read.${
            err ? `\nstderr: ${err.slice(-400)}` : ""
          }${out ? `\nstdout: ${out.slice(-400)}` : ""}`,
        ),
      );
    });

    // 8s hard cap — if codex hangs on init we don't want to block the TUI.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* */
      }
      reject(new Error("codex app-server timed out after 8s"));
    }, 8000);
    child.on("close", () => clearTimeout(timer));

    // Keep stdin open after writing — closing it now would race the server's
    // request processing. The stdout handler will close stdin when it has
    // what it needs.
    child.stdin.write(stdinPayload);
  });
}

function parseRateLimits(raw: string): CodexRateLimits {
  // Scan each line; pick the JSON object whose id === 2.
  let payload: Record<string, unknown> | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (obj["id"] === 2 && obj["result"] && typeof obj["result"] === "object") {
        payload = obj["result"] as Record<string, unknown>;
        break;
      }
    } catch {
      /* skip non-JSON lines */
    }
  }
  if (!payload) {
    throw new Error("no rateLimits response found in app-server output");
  }
  const rl = payload["rateLimits"] as Record<string, unknown> | undefined;
  if (!rl) throw new Error("response missing `rateLimits`");
  return {
    primary: readWindow(rl["primary"]),
    secondary: readWindow(rl["secondary"]),
    planType: typeof rl["planType"] === "string" ? (rl["planType"] as string) : null,
    observedAt: Date.now(),
  };
}

function readWindow(v: unknown): CodexRateLimitWindow | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const used = typeof o["usedPercent"] === "number" ? (o["usedPercent"] as number) : null;
  if (used == null) return null;
  return {
    usedPercent: used,
    resetsAt: typeof o["resetsAt"] === "number" ? (o["resetsAt"] as number) : null,
    windowDurationMins:
      typeof o["windowDurationMins"] === "number" ? (o["windowDurationMins"] as number) : null,
  };
}
