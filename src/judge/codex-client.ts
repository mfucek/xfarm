import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.ts";
import type { JsonSchema, LlmClient } from "./llm.ts";

const JSON_INSTRUCTION =
  "Respond with strict JSON only. No prose, no markdown fences, no commentary.\n" +
  "The response MUST conform to this JSON schema (advisory):\n";

/**
 * Run a prompt through the `codex exec` CLI. This is how we tap the user's
 * ChatGPT/Codex subscription instead of paying per-token via the OpenAI API.
 *
 * We invoke `codex exec` with --output-last-message to get just the final
 * assistant message in a file (avoiding the noisy event stream on stdout).
 * The prompt instructs strict-JSON output; we then JSON.parse the file.
 */
export class CodexClient implements LlmClient {
  constructor(private cfg: Config) {}

  async generateJson<T = unknown>(prompt: string, schema: JsonSchema): Promise<T> {
    const tmp = mkdtempSync(join(tmpdir(), "xfarm-codex-"));
    const outFile = join(tmp, "out.txt");
    const fullPrompt =
      `${JSON_INSTRUCTION}${JSON.stringify(schema, null, 2)}\n\n---\n\n${prompt}`;

    try {
      const text = await this.runCodex(fullPrompt, outFile);
      const stripped = stripFences(text).trim();
      return JSON.parse(stripped) as T;
    } finally {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* tmp cleanup best-effort */
      }
    }
  }

  private runCodex(prompt: string, outFile: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        "exec",
        "--skip-git-repo-check",
        "--model",
        this.cfg.judge.codex_model,
        "--output-last-message",
        outFile,
        "-",
      ];
      const child = spawn(this.cfg.judge.codex_bin, args, {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stderr: Buffer[] = [];
      child.stderr.on("data", (d: Buffer) => stderr.push(d));
      // Drain stdout so the pipe doesn't fill up; we don't use it because
      // --output-last-message gives us a clean transcript.
      child.stdout.on("data", () => {});
      child.on("error", (err) => {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(
            new Error(
              `codex binary not found (configured as '${this.cfg.judge.codex_bin}'). ` +
                "Install Codex CLI: https://github.com/openai/codex, then run `codex login`.",
            ),
          );
        } else {
          reject(err);
        }
      });
      child.on("close", (code) => {
        if (code !== 0) {
          const tail = Buffer.concat(stderr).toString("utf-8").slice(-800);
          reject(
            new Error(
              `codex exit ${code}${tail ? `:\n${tail}` : ""}`,
            ),
          );
          return;
        }
        try {
          const body = readFileSync(outFile, "utf-8");
          resolve(body);
        } catch (e) {
          reject(
            new Error(
              `codex finished but produced no output file at ${outFile}: ${(e as Error).message}`,
            ),
          );
        }
      });
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}

// Codex sometimes wraps JSON in ```json fences even when told not to.
function stripFences(s: string): string {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return m && m[1] ? m[1] : s;
}
