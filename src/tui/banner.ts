import { patchConfigFile } from "../config.ts";
import { runGitPull } from "../version-check.ts";
import { BOLD, FG_YELLOW, RESET, REVERSE, stripAnsi } from "./ansi.ts";
import { renderBox } from "./box.ts";
import {
  isActivate,
  isDown,
  isLeft,
  isRight,
  isUp,
  type ParsedKey,
} from "./keys.ts";
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
  const inner = Math.max(2, cols - 4);

  // Non-interactive "Auto-updating…" state shown while an auto-triggered
  // pull is in flight. Same gradient styling, no buttons.
  if (host.autoUpdating) {
    const headline = `✦ ${gradientText("AUTO-UPDATING…", Date.now())}`;
    const left = `${headline}  ${n} ${commits} behind`;
    const pad = Math.max(0, inner - stripAnsi(left).length);
    return renderBox([`${left}${" ".repeat(pad)}`], cols, undefined);
  }

  const labels = ["[ Update ]", "[ Enable Auto-Update ]"];
  const ctas = labels.map((label, i) => {
    const isFocused = host.bannerSelected && host.bannerButton === i;
    return isFocused
      ? `${REVERSE}${BOLD}${label}${RESET}`
      : `${BOLD}${label}${RESET}`;
  });
  const cta = ctas.join(" ");
  const headline = `✦ ${gradientText("NEW UPDATE AVAILABLE", Date.now())}`;
  const left = `${headline}  ${n} ${commits} behind`;
  // Inner width of the box matches renderBox's accounting ("│ " + " │" = 4).
  // Pad between the two halves so the CTAs hug the right edge.
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
  // Auto-update pull in flight — banner is non-interactive. Consume Up so
  // the user can't accidentally land on it; everything else falls through.
  if (host.autoUpdating) {
    if (isUp(key) && isPageCursorAtTop(host)) return true;
    return false;
  }
  if (host.bannerSelected) {
    if (isDown(key)) {
      host.bannerSelected = false;
      host.draw();
      return true;
    }
    if (isUp(key)) return true;
    if (isLeft(key)) {
      if (host.bannerButton > 0) {
        host.bannerButton -= 1;
        host.draw();
      }
      return true;
    }
    if (isRight(key)) {
      if (host.bannerButton < 1) {
        host.bannerButton += 1;
        host.draw();
      }
      return true;
    }
    if (isActivate(key)) {
      if (host.bannerButton === 1) {
        void enableAutoUpdateAndRun(host);
      } else {
        void runUpdateAction(host);
      }
      return true;
    }
    // Any other key (e.g. 'x', 'a', 'q', tab): deselect and fall through, so
    // page-level keys still work without first pressing Down.
    host.bannerSelected = false;
    return false;
  }
  if (isUp(key) && isPageCursorAtTop(host)) {
    host.bannerSelected = true;
    host.bannerButton = 0;
    host.draw();
    return true;
  }
  return false;
}

async function runUpdateAction(host: TuiHost): Promise<void> {
  host.flash("git pull --ff-only…", 30_000);
  host.draw();
  const r = await runGitPull();
  if (!r.ok) {
    host.flash(r.message, 6000);
    host.draw();
    return;
  }
  // Pull succeeded — relaunch the TUI in the same terminal session so the
  // user picks up the new code without typing anything. runTui stops the
  // daemon and execs a fresh bun once the TUI loop ends.
  host.updateAvailable = null;
  host.bannerSelected = false;
  host.flash("pulled — restarting xfarm…", 3000);
  host.draw();
  host.requestRestart();
}

/**
 * Persist `updater.auto_update = true` then immediately run the same
 * pull + restart flow as the manual button. After this fires once, the
 * 30s poll in run.ts handles subsequent updates without any UI.
 */
async function enableAutoUpdateAndRun(host: TuiHost): Promise<void> {
  patchConfigFile({ updater: { auto_update: true } });
  host.reloadConfig();
  host.bannerSelected = false;
  host.autoUpdating = true;
  host.flash("auto-update enabled — pulling…", 30_000);
  host.draw();
  const r = await runGitPull();
  if (!r.ok) {
    host.autoUpdating = false;
    host.flash(r.message, 6000);
    host.draw();
    return;
  }
  host.updateAvailable = null;
  host.flash("pulled — restarting xfarm…", 3000);
  host.draw();
  host.requestRestart();
}
