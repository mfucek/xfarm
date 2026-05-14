// ANSI escape codes + small text helpers shared by all TUI render modules.

export const ESC = "\x1b[";
export const ALT_ON = `${ESC}?1049h`;
export const ALT_OFF = `${ESC}?1049l`;
// Bracketed paste: terminal wraps clipboard pastes in \x1b[200~ ... \x1b[201~
// so we can distinguish "user typed this" from "user pasted this" and treat
// pastes as a single edit instead of one-key-at-a-time.
export const BRACKETED_PASTE_ON = `${ESC}?2004h`;
export const BRACKETED_PASTE_OFF = `${ESC}?2004l`;
export const CLEAR = `${ESC}2J${ESC}H`;
export const HOME = `${ESC}H`;
export const HIDE_CURSOR = `${ESC}?25l`;
export const SHOW_CURSOR = `${ESC}?25h`;
export const RESET = `${ESC}0m`;
export const BOLD = `${ESC}1m`;
export const DIM = `${ESC}2m`;
export const REVERSE = `${ESC}7m`;
export const FG_CYAN = `${ESC}36m`;
export const FG_GREEN = `${ESC}32m`;
export const FG_YELLOW = `${ESC}33m`;
export const FG_RED = `${ESC}31m`;
export const FG_BLUE = `${ESC}38;5;75m`;
export const FG_GRAY = `${ESC}90m`;
export const FG_WHITE = `${ESC}97m`;

export const stripAnsi = (s: string): string =>
  s.replace(/\x1b\[[0-9;]*m/g, "");

export const padRight = (s: string, n: number): string => {
  const visible = stripAnsi(s).length;
  if (visible >= n) return s;
  return s + " ".repeat(n - visible);
};

export const truncVisible = (s: string, n: number): string => {
  const oneLine = s.replace(/\s+/g, " ").trim();
  if (oneLine.length <= n) return oneLine;
  return oneLine.slice(0, Math.max(0, n - 1)) + "…";
};

/** Parse a TEXT column that stores a JSON-encoded array of strings (used for
 * `llm_pitch` and `llm_links`). Filters out non-strings and empty entries so
 * callers can iterate without re-validating. */
export const parseStringArrayColumn = (raw: string | null): string[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (b): b is string => typeof b === "string" && b.trim().length > 0,
    );
  } catch {
    return [];
  }
};

/** @deprecated Prefer parseStringArrayColumn — kept for existing call sites. */
export const parsePitchBullets = parseStringArrayColumn;

export const wrapText = (s: string, width: number): string[] => {
  if (width <= 0) return [s];
  const lines: string[] = [];
  for (const para of s.split(/\r?\n/)) {
    if (para.length === 0) {
      lines.push("");
      continue;
    }
    const words = para.split(/\s+/).filter((w) => w.length > 0);
    let cur = "";
    for (const w of words) {
      if (cur.length === 0) {
        cur = w.length > width ? w.slice(0, width) : w;
        if (w.length > width) {
          lines.push(cur);
          cur = w.slice(width);
          while (cur.length > width) {
            lines.push(cur.slice(0, width));
            cur = cur.slice(width);
          }
        }
      } else if (cur.length + 1 + w.length <= width) {
        cur += " " + w;
      } else {
        lines.push(cur);
        cur = w.length > width ? w.slice(0, width) : w;
        if (w.length > width) {
          lines.push(cur);
          cur = w.slice(width);
          while (cur.length > width) {
            lines.push(cur.slice(0, width));
            cur = cur.slice(width);
          }
        }
      }
    }
    if (cur.length > 0) lines.push(cur);
  }
  return lines;
};

/** Render a section header as two lines: the styled header body and a thin
 * DIM `─` rule beneath it. Callers compose `body` with their own BOLD/DIM
 * spans and prepend any per-page indent prefix to both returned lines.
 *
 * Shared across pages so section breaks read the same everywhere — bold
 * label on top, dim rule underneath. */
export const renderSectionHeader = (
  body: string,
  ruleWidth: number,
): string[] => [body, DIM + "─".repeat(Math.max(4, ruleWidth)) + RESET];

export const ageStr = (iso: string): string => {
  const secs = Math.max(
    0,
    Math.floor((Date.now() - new Date(iso).getTime()) / 1000),
  );
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
};

export const likesPerHour = (
  likes: number | null | undefined,
  createdAtIso: string,
): number => {
  const ageHr = Math.max(
    (Date.now() - new Date(createdAtIso).getTime()) / 3600000,
    1 / 60,
  );
  return (likes ?? 0) / ageHr;
};
