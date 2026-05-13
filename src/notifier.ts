import { spawn } from "node:child_process";
import type { Config } from "./config.ts";
import type { DB } from "./db.ts";
import { sleep } from "./scraper/rate-limit.ts";

async function which(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const p = spawn("which", [cmd]);
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", (code) =>
      resolve(code === 0 && out.trim() ? out.trim() : null),
    );
  });
}

async function notify(
  title: string,
  message: string,
  url: string,
  sound: string,
): Promise<void> {
  const tn = await which("terminal-notifier");
  if (tn) {
    await new Promise<void>((resolve) => {
      const p = spawn(tn, [
        "-title",
        title,
        "-message",
        message,
        "-open",
        url,
        "-sound",
        sound,
        "-sender",
        "com.apple.Terminal",
      ]);
      p.on("close", () => resolve());
    });
    return;
  }
  // osascript fallback (no click action)
  const esc = (s: string) => s.replace(/"/g, '\\"');
  const script = `display notification "${esc(message)}" with title "${esc(
    title,
  )}" sound name "${esc(sound)}"`;
  await new Promise<void>((resolve) => {
    const p = spawn("osascript", ["-e", script]);
    p.on("close", () => resolve());
  });
}

export async function notifyLoop(
  db: DB,
  cfg: Config,
  stop: AbortSignal,
): Promise<void> {
  if (!cfg.notifier.enabled) return;
  if (!(await which("terminal-notifier"))) {
    console.warn(
      "[notifier] terminal-notifier not found — using osascript (no click-to-open). brew install terminal-notifier for clickable.",
    );
  }
  while (!stop.aborted) {
    const pending = db.fetchDueForNotify(cfg.judge.notify_threshold);
    for (const t of pending) {
      const title = `xfarm: @${t.author} (${(t.llm_score ?? 0).toFixed(1)})`;
      const message = (t.llm_reason ?? "").slice(0, 200);
      try {
        await notify(title, message, t.url, cfg.notifier.sound);
        db.markNotified(t.id);
        console.log(
          `[notifier] @${t.author} id=${t.id.slice(0, 12)} score=${(
            t.llm_score ?? 0
          ).toFixed(1)}`,
        );
      } catch (e) {
        console.error(`[notifier] failed on id=${t.id}:`, e);
      }
    }
    await sleep(3000);
  }
}
