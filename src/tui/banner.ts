import { runGitPull } from "../version-check.ts";
import { BOLD, FG_YELLOW, RESET, REVERSE, stripAnsi } from "./ansi.ts";
import { renderBox } from "./box.ts";
import { isActivate, isDown, isUp, type ParsedKey } from "./keys.ts";
import type { TuiHost } from "./types.ts";

// HSL → RGB. h in [0, 1) cycles full hue; s, l in [0, 1]. Standard formula.
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const f = (n: number): number => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(
      255 *
        (l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)))),
    );
  };
  return [f(0), f(8), f(4)];
}

/**
 * Per-char rainbow with a moving phase. The phase is time-driven so caller
 * just needs to redraw frequently; the function is pure. Hue spans ~0.35 of
 * the wheel across the string so adjacent chars are clearly distinct without
 * looping back to the start mid-word.
 */
function gradientText(text: string, phaseMs: number): string {
  const len = text.length;
  if (len === 0) return "";
  // 4000ms per full hue revolution.
  const base = (phaseMs / 4000) % 1;
  let out = "";
  for (let i = 0; i < len; i++) {
    const h = (base + (i / len) * 0.35) % 1;
    const [r, g, b] = hslToRgb(h, 0.85, 0.62);
    out += `\x1b[38;2;${r};${g};${b}m${text[i]}`;
  }
  return out + RESET;
}

/**
 * "new version available" banner row above the header.
 *
 * The banner is page-agnostic: it lives above every tab and is focused by
 * pressing Up while the page's cursor is already at its top. Down returns
 * focus to the page. Enter runs `git pull --ff-only`.
 *
 * Lives in its own module so the main TUI orchestrator doesn't grow another
 * page-specific responsibility, and so the page handlers don't need to know
 * about it.
 */

export function renderBanner(host: TuiHost, cols: number): string[] | null {
  if (!host.updateAvailable) return null;
  const n = host.updateAvailable.behind;
  const commits = n === 1 ? "commit" : "commits";
  const label = `[ git pull ]`;
  const cta = host.bannerSelected
    ? `${REVERSE}${BOLD}${label}${RESET}`
    : `${BOLD}${label}${RESET}`;
  const headline = `✦ ${gradientText("NEW UPDATE AVAILABLE", Date.now())}`;
  const left = `${headline}  ${n} ${commits} behind`;
  // Inner width of the box matches renderBox's accounting ("│ " + " │" = 4).
  // Pad between the two halves so the CTA hugs the right edge.
  const inner = Math.max(2, cols - 4);
  const used = stripAnsi(left).length + stripAnsi(cta).length;
  const gap = Math.max(1, inner - used);
  const line = `${left}${" ".repeat(gap)}${cta}`;
  // Yellow border when selected so the focus state reads from a glance even
  // without color on the CTA; default gray border otherwise.
  const color = host.bannerSelected ? FG_YELLOW : undefined;
  return renderBox([line], cols, color);
}

export function isPageCursorAtTop(host: TuiHost): boolean {
  if (host.page === "candidates" || host.page === "keywords") {
    return host.selected === 0;
  }
  if (host.page === "config") return host.configCursor === 0;
  if (host.page === "debug") return host.debugCursor === 0;
  return true;
}

/**
 * Returns true if the key was consumed by the banner (caller should stop
 * dispatching). Returns false if the page handler should run as normal.
 */
export function handleBannerKey(host: TuiHost, key: ParsedKey): boolean {
  if (!host.updateAvailable) return false;
  if (host.bannerSelected) {
    if (isDown(key)) {
      host.bannerSelected = false;
      host.draw();
      return true;
    }
    if (isUp(key)) return true;
    if (isActivate(key)) {
      void runUpdateAction(host);
      return true;
    }
    // Any other key (e.g. 'x', 'a', 'q', tab): deselect and fall through, so
    // page-level keys still work without first pressing Down.
    host.bannerSelected = false;
    return false;
  }
  if (isUp(key) && isPageCursorAtTop(host)) {
    host.bannerSelected = true;
    host.draw();
    return true;
  }
  return false;
}

async function runUpdateAction(host: TuiHost): Promise<void> {
  host.flash("git pull --ff-only…", 30_000);
  host.draw();
  const r = await runGitPull();
  host.flash(r.message, 6000);
  if (r.ok) {
    host.updateAvailable = null;
    host.bannerSelected = false;
  }
  host.draw();
}
