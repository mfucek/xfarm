import { readFileSync, mkdirSync } from "node:fs";
import type { BrowserContext, Page } from "playwright";
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

export class Browser {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private pageLock = Promise.resolve<void>(undefined);
  burnerUsername = "";

  constructor(private cfg: Config) {}

  async start(): Promise<void> {
    const cookies = this.loadCookies();
    this.burnerUsername = cookies.username;
    mkdirSync(this.cfg.scraper.profile_path, { recursive: true });

    this.context = await chromium.launchPersistentContext(
      this.cfg.scraper.profile_path,
      {
        headless: this.cfg.scraper.headless,
        userAgent: this.cfg.scraper.user_agent,
        viewport: { width: 1280, height: 900 },
        locale: "en-US",
        timezoneId: "America/Los_Angeles",
      },
    );

    await this.context.addCookies([
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

    // single shared page
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    // suppress images/fonts/css to keep load lean
    await this.page.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (t === "image" || t === "media" || t === "font") {
        return route.abort();
      }
      return route.continue();
    });
  }

  async stop(): Promise<void> {
    if (this.context) {
      try {
        await this.context.close();
      } catch {
        // Playwright's own SIGTERM handler may have closed it first — harmless.
      }
      this.context = null;
      this.page = null;
    }
  }

  /** Serialized page access — only one scan at a time uses the page. */
  async withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    if (!this.page) throw new Error("Browser not started");
    const page = this.page;
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const prev = this.pageLock;
    this.pageLock = next;
    await prev;
    try {
      return await fn(page);
    } finally {
      release();
    }
  }

  private loadCookies(): CookieFile {
    const path = this.cfg.scraper.burner_cookies_path;
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
    if (!username) {
      throw new Error(`${path}: missing 'username' field`);
    }
    if (!parsed.auth_token || !parsed.ct0) {
      throw new Error(
        `${path}: must contain 'auth_token' and 'ct0' from burner's browser`,
      );
    }
    return { username, auth_token: parsed.auth_token, ct0: parsed.ct0 };
  }
}
