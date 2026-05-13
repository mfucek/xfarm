import { existsSync, readFileSync } from "node:fs";
import {
  DEFAULT_COOKIES_PATH,
  patchConfigFile,
  writeBurnerCookies,
} from "../config.ts";
import type { TuiHost } from "./types.ts";

export type ConfigItem =
  | { kind: "header"; id: string; label: string }
  | { kind: "status" }
  | {
      kind: "field";
      id: string;
      label: string;
      value: string;
      hint?: string;
      // Called when the user presses Enter on this row. Returns a flash message.
      edit: (host: TuiHost) => Promise<string | null>;
    }
  | {
      kind: "toggle";
      id: string;
      label: string;
      value: string;
      hint?: string;
      run: (host: TuiHost) => Promise<string | null>;
    };

function readCookies(): {
  username: string;
  auth_token: string;
  ct0: string;
} | null {
  if (!existsSync(DEFAULT_COOKIES_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(DEFAULT_COOKIES_PATH, "utf-8"));
    return {
      username: String(parsed.username ?? ""),
      auth_token: String(parsed.auth_token ?? ""),
      ct0: String(parsed.ct0 ?? ""),
    };
  } catch {
    return null;
  }
}

function mask(s: string): string {
  if (!s) return "(unset)";
  if (s.length <= 8) return "•".repeat(s.length);
  return `${s.slice(0, 4)}…${s.slice(-4)} (${s.length} chars)`;
}

async function editBurnerField(
  host: TuiHost,
  field: "username" | "auth_token" | "ct0",
  prompt: string,
): Promise<string | null> {
  const v = await host.promptInput(prompt);
  if (v == null) return null;
  const current = readCookies() ?? { username: "", auth_token: "", ct0: "" };
  const next = { ...current, [field]: v };
  writeBurnerCookies(next.username, next.auth_token, next.ct0);
  return `saved ${field}`;
}

async function editConfigField(
  host: TuiHost,
  prompt: string,
  apply: (value: string) => Record<string, unknown>,
): Promise<string | null> {
  const v = await host.promptInput(prompt);
  if (v == null) return null;
  patchConfigFile(apply(v));
  host.reloadConfig();
  return "saved · restart daemon to apply";
}

/** Build the ordered list of items shown on the Config page. */
export function getConfigItems(host: TuiHost): ConfigItem[] {
  const cfg = host.cfg;
  const cookies = readCookies();
  const items: ConfigItem[] = [];

  items.push({ kind: "header", id: "h-setup", label: "Setup status" });
  items.push({ kind: "status" });

  items.push({ kind: "header", id: "h-burner", label: "Burner X account" });
  items.push({
    kind: "field",
    id: "burner_handle",
    label: "handle",
    value: cookies?.username ? `@${cookies.username}` : "(unset)",
    hint: "X username (no @). Used for self-detection only; scrape goes through cookies.",
    edit: (h) => editBurnerField(h, "username", "Burner X handle (no @): "),
  });
  items.push({
    kind: "field",
    id: "burner_auth",
    label: "auth_token",
    value: mask(cookies?.auth_token ?? ""),
    hint: "Cookie from x.com → DevTools → Application → Cookies → auth_token",
    edit: (h) => editBurnerField(h, "auth_token", "auth_token cookie value: "),
  });
  items.push({
    kind: "field",
    id: "burner_ct0",
    label: "ct0",
    value: mask(cookies?.ct0 ?? ""),
    hint: "Cookie from x.com → Application → Cookies → ct0 (CSRF token)",
    edit: (h) => editBurnerField(h, "ct0", "ct0 cookie value: "),
  });

  items.push({ kind: "header", id: "h-llm", label: "LLM provider" });
  items.push({
    kind: "toggle",
    id: "provider",
    label: "provider",
    value: cfg.judge.provider,
    hint:
      "gemini = Vertex AI (paid per token). codex = OpenAI Codex CLI (uses your ChatGPT subscription).",
    run: async (h) => {
      const next = cfg.judge.provider === "codex" ? "gemini" : "codex";
      patchConfigFile({ judge: { provider: next } });
      h.reloadConfig();
      return `provider → ${next} · restart daemon to apply`;
    },
  });

  if (cfg.judge.provider === "codex") {
    items.push({
      kind: "field",
      id: "codex_model",
      label: "model",
      value: cfg.judge.codex_model,
      hint: "Codex model name (e.g. gpt-5-codex, gpt-5.1-codex)",
      edit: (h) =>
        editConfigField(h, "Codex model: ", (v) => ({
          judge: { codex_model: v },
        })),
    });
    items.push({
      kind: "field",
      id: "codex_bin",
      label: "codex binary",
      value: cfg.judge.codex_bin,
      hint: "Path to the codex CLI (default: codex on PATH). Run `codex login` once.",
      edit: (h) =>
        editConfigField(h, "Codex binary path: ", (v) => ({
          judge: { codex_bin: v },
        })),
    });
  } else {
    items.push({
      kind: "field",
      id: "vertex_project",
      label: "GCP project",
      value: cfg.judge.vertex_project || "(unset)",
      hint: "Google Cloud project ID with Vertex AI enabled",
      edit: (h) =>
        editConfigField(h, "GCP project ID: ", (v) => ({
          judge: { vertex_project: v },
        })),
    });
    items.push({
      kind: "field",
      id: "vertex_location",
      label: "region",
      value: cfg.judge.vertex_location,
      hint: "Vertex region (us-central1, europe-west4, …)",
      edit: (h) =>
        editConfigField(h, "Vertex region: ", (v) => ({
          judge: { vertex_location: v },
        })),
    });
    items.push({
      kind: "field",
      id: "gemini_model",
      label: "model",
      value: cfg.judge.model,
      hint: "Gemini model (gemini-2.5-flash, gemini-2.5-pro, …)",
      edit: (h) =>
        editConfigField(h, "Gemini model: ", (v) => ({
          judge: { model: v },
        })),
    });
    items.push({
      kind: "field",
      id: "vertex_credentials",
      label: "credentials",
      value: cfg.judge.credentials_path?.toString() || "(ADC / b64 env)",
      hint:
        "Path to service-account JSON. Leave blank to use GOOGLE_VERTEX_CREDENTIALS_B64 or `gcloud auth application-default login`.",
      edit: (h) =>
        editConfigField(h, "Service-account JSON path (blank = ADC): ", (v) => ({
          judge: { credentials_path: v },
        })),
    });
  }

  items.push({
    kind: "field",
    id: "notify_threshold",
    label: "notify threshold",
    value: cfg.judge.notify_threshold.toFixed(1),
    hint: "Tweets scoring ≥ this get a desktop notification (0.0–10.0)",
    edit: async (h) => {
      const v = await h.promptInput("Notify threshold (0.0–10.0): ");
      if (v == null) return null;
      const num = Number(v);
      if (!Number.isFinite(num) || num < 0 || num > 10) {
        return `invalid: '${v}' (must be 0–10)`;
      }
      patchConfigFile({ judge: { notify_threshold: num } });
      h.reloadConfig();
      return `threshold → ${num.toFixed(1)}`;
    },
  });

  return items;
}

/** Step the cursor onto the next item; headers and status are skippable in
 * the sense that Enter does nothing — but the cursor still lands on them so
 * the user can read the section. */
export function isSelectable(it: ConfigItem): boolean {
  return it.kind === "field" || it.kind === "toggle";
}
