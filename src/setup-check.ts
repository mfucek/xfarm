import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { DEFAULT_COOKIES_PATH, DEFAULT_CONFIG_PATH } from "./config.ts";

export type CheckId = "config" | "cookies" | "llm" | "prompt";

export interface CheckResult {
  id: CheckId;
  ok: boolean;
  detail: string;
}

export interface SetupStatus {
  ok: boolean;
  checks: CheckResult[];
}

/**
 * Inspect the runtime config + filesystem and return per-piece readiness.
 * Used by the TUI to decide whether to auto-open the Config tab and by the
 * Config page itself to render the checklist.
 */
export function checkSetup(cfg: Config): SetupStatus {
  const checks: CheckResult[] = [];

  checks.push(
    existsSync(DEFAULT_CONFIG_PATH)
      ? { id: "config", ok: true, detail: DEFAULT_CONFIG_PATH }
      : {
          id: "config",
          ok: false,
          detail: `missing ${DEFAULT_CONFIG_PATH}`,
        },
  );

  checks.push(checkCookies());
  checks.push(checkLlm(cfg));
  checks.push(checkPrompt(cfg));

  return { ok: checks.every((c) => c.ok), checks };
}

function checkCookies(): CheckResult {
  const path = DEFAULT_COOKIES_PATH;
  if (!existsSync(path)) {
    return { id: "cookies", ok: false, detail: `missing ${path}` };
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<{
      username: string;
      auth_token: string;
      ct0: string;
    }>;
    const u = (parsed.username ?? "").trim().replace(/^@/, "");
    if (!u) return { id: "cookies", ok: false, detail: "missing username" };
    if (!parsed.auth_token) return { id: "cookies", ok: false, detail: "missing auth_token" };
    if (!parsed.ct0) return { id: "cookies", ok: false, detail: "missing ct0" };
    return { id: "cookies", ok: true, detail: `@${u}` };
  } catch (e) {
    return { id: "cookies", ok: false, detail: `parse error: ${(e as Error).message}` };
  }
}

function checkLlm(cfg: Config): CheckResult {
  if (cfg.judge.provider === "codex") return checkCodex(cfg);
  return checkVertex(cfg);
}

function checkVertex(cfg: Config): CheckResult {
  if (!cfg.judge.vertex_project) {
    return { id: "llm", ok: false, detail: "Vertex: project ID not set" };
  }
  if (process.env.GOOGLE_VERTEX_CREDENTIALS_B64) {
    return { id: "llm", ok: true, detail: `Vertex: ${cfg.judge.vertex_project} (b64 creds)` };
  }
  if (cfg.judge.credentials_path && existsSync(cfg.judge.credentials_path.toString())) {
    return {
      id: "llm",
      ok: true,
      detail: `Vertex: ${cfg.judge.vertex_project} (SA key)`,
    };
  }
  // ADC fallback — best effort: just check the standard ADC file exists.
  const adc = join(homedir(), ".config", "gcloud", "application_default_credentials.json");
  if (existsSync(adc)) {
    return { id: "llm", ok: true, detail: `Vertex: ${cfg.judge.vertex_project} (ADC)` };
  }
  return {
    id: "llm",
    ok: false,
    detail: "Vertex: no credentials (SA key / b64 / ADC all missing)",
  };
}

function checkCodex(cfg: Config): CheckResult {
  const bin = cfg.judge.codex_bin;
  // `codex --version` is cheap and confirms the binary is on PATH.
  const r = spawnSync(bin, ["--version"], { encoding: "utf-8" });
  if (r.error) {
    return {
      id: "llm",
      ok: false,
      detail: `Codex: '${bin}' not found on PATH. Install: https://github.com/openai/codex`,
    };
  }
  if (r.status !== 0) {
    return { id: "llm", ok: false, detail: `Codex: ${bin} returned exit ${r.status}` };
  }
  const ver = (r.stdout || r.stderr || "").trim().split("\n")[0] ?? "";
  // We can't easily verify the user has run `codex login` without spending a
  // request, so just confirm the binary is present and let runtime errors
  // surface auth issues.
  return { id: "llm", ok: true, detail: `Codex: ${ver || bin} (run \`${bin} login\` if not yet)` };
}

function checkPrompt(cfg: Config): CheckResult {
  const path = cfg.judge.prompt_path.toString();
  return existsSync(path)
    ? { id: "prompt", ok: true, detail: path }
    : { id: "prompt", ok: false, detail: `missing prompt: ${path}` };
}
