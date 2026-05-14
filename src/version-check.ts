import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type UpdateInfo = { behind: number };

const repoRoot = resolve(import.meta.dir, "..");

/** Read the app version from package.json. Falls back to "0.0.0" if missing
 *  or unreadable — same fallback the header uses. */
export function getAppVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const run = (
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string }> =>
  new Promise((resolveP) => {
    const child = spawn(cmd, args, { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    const t = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* gone */ }
      resolveP({ code: -1, stdout: "" });
    }, timeoutMs);
    child.stdout.on("data", (b) => { out += b.toString(); });
    child.on("error", () => { clearTimeout(t); resolveP({ code: -1, stdout: "" }); });
    child.on("close", (code) => { clearTimeout(t); resolveP({ code: code ?? -1, stdout: out }); });
  });

/**
 * Fetch upstream and report whether the working tree is behind. Designed for
 * the TUI's "new version available" banner: silent on every failure mode
 * (no git, no remote, no network, no upstream), so a user with a tarball
 * checkout never sees a spurious banner or error.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!existsSync(join(repoRoot, ".git"))) return null;

  const fetch = await run("git", ["fetch", "--quiet"], 10_000);
  if (fetch.code !== 0) return null;

  const counts = await run(
    "git",
    ["rev-list", "--left-right", "--count", "HEAD...@{u}"],
    5_000,
  );
  if (counts.code !== 0) return null;

  // Output is "<ahead>\t<behind>" — behind = commits on upstream we don't have.
  const parts = counts.stdout.trim().split(/\s+/);
  const behind = Number(parts[1]);
  if (!Number.isFinite(behind) || behind <= 0) return null;
  return { behind };
}

export type PullResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

/**
 * Fast-forward-only pull. Refuses to merge or rebase, so a user with local
 * changes or divergent history gets a clear error instead of a half-finished
 * merge inside the TUI.
 */
export async function runGitPull(): Promise<PullResult> {
  if (!existsSync(join(repoRoot, ".git"))) {
    return { ok: false, message: "not a git checkout" };
  }
  const r = await run("git", ["pull", "--ff-only", "--quiet"], 30_000);
  if (r.code === 0) return { ok: true, message: "pulled — restart xfarm to use new code" };
  if (r.code === -1) return { ok: false, message: "git pull timed out" };
  return { ok: false, message: "git pull failed (local changes or non-ff)" };
}
