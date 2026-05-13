import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-extra";
// @ts-ignore - puppeteer-extra-plugin-stealth ships its own types lazily
import stealth from "puppeteer-extra-plugin-stealth";
import type { Config } from "../config.ts";

chromium.use(stealth());

type CookieFile = {
  username: string;
  auth_token: string;
  ct0: string;
};

/**
 * Open a non-headless Chromium with burner cookies injected, navigate to
 * x.com/home, and block until the user closes the window. Uses a profile
 * directory separate from the daemon's scraper profile so it can coexist
 * with a running daemon (Chromium locks its user-data-dir).
 */
export async function openBurnerWindow(cfg: Config): Promise<void> {
  const cookies = loadCookies(cfg.scraper.burner_cookies_path);
  const profileDir = join(homedir(), ".xfarm", "burner-window-profile");
  mkdirSync(profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    userAgent: cfg.scraper.user_agent,
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
  });

  await context.addCookies([
    {
      name: "auth_token",
      value: cookies.auth_token,
      domain: ".x.com",
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
    {
      name: "ct0",
      value: cookies.ct0,
      domain: ".x.com",
      path: "/",
      secure: true,
      sameSite: "Lax",
    },
  ]);

  const page = context.pages()[0] ?? (await context.newPage());
  try {
    await page.goto("https://x.com/home", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
  } catch {
    /* keep the window open even if the initial navigation hiccups */
  }

  await new Promise<void>((resolve) => {
    context.on("close", () => resolve());
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });

  try {
    await context.close();
  } catch {
    /* may already be closed by the user */
  }
}

function loadCookies(path: string): CookieFile {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    throw new Error(
      `Burner cookies not found at ${path}. Run setup.sh to create them.`,
    );
  }
  const parsed = JSON.parse(raw) as Partial<CookieFile>;
  const username = (parsed.username ?? "").trim().replace(/^@/, "");
  if (!username) throw new Error(`${path}: missing 'username' field`);
  if (!parsed.auth_token || !parsed.ct0) {
    throw new Error(
      `${path}: must contain 'auth_token' and 'ct0' from burner's browser`,
    );
  }
  return { username, auth_token: parsed.auth_token, ct0: parsed.ct0 };
}
