// Shared animated rainbow gradient helpers. Used by the update banner
// (per-char text gradient) and the About page (per-char box-border
// gradient on the latest release). Hue cycles every 4s; callers redraw
// every ~100ms so the colors visibly move.

import { RESET, stripAnsi } from "./ansi.ts";

// HSL → RGB. h in [0, 1) cycles full hue; s, l in [0, 1]. Standard formula.
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const f = (n: number): number => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(
      255 * (l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)))),
    );
  };
  return [f(0), f(8), f(4)];
}

/** Return the SGR opener (`\x1b[38;2;R;G;Bm`) for hue position
 * `i / total` offset by `phaseMs / 4000` revolutions. Hue spans ~0.35
 * of the wheel across `total` chars so adjacent chars are clearly
 * distinct without looping back to the start mid-string. */
export function gradientColor(
  i: number,
  total: number,
  phaseMs: number,
): string {
  const base = (phaseMs / 4000) % 1;
  const denom = Math.max(1, total);
  const h = (base + (i / denom) * 0.35) % 1;
  const [r, g, b] = hslToRgb(h, 0.85, 0.62);
  return `\x1b[38;2;${r};${g};${b}m`;
}

/**
 * Per-char rainbow with a moving phase. The phase is time-driven so
 * callers just need to redraw frequently; the function is pure. Hue
 * spans ~0.35 of the wheel across the string so adjacent chars are
 * clearly distinct without looping back mid-word.
 */
export function gradientText(text: string, phaseMs: number): string {
  const len = text.length;
  if (len === 0) return "";
  let out = "";
  for (let i = 0; i < len; i++) {
    out += gradientColor(i, len, phaseMs) + text[i];
  }
  return out + RESET;
}

/**
 * Bordered text box whose border characters animate through the same
 * rainbow gradient as `gradientText`. Layout mirrors `renderBox` in
 * `box.ts` (1-char border, 1-space inner padding, total outer width =
 * `width`) — content lines stay uncolored, only the `┌─┐ │ │ └─┘`
 * border chars get hue-shifted per-position.
 *
 * Position-along-perimeter is approximated as "char index in the
 * concatenated border ring" so the gradient appears to flow around the
 * box rather than restart at each line.
 */
export function renderGradientBox(
  lines: string[],
  width: number,
  phaseMs: number,
): string[] {
  const w = Math.max(4, width);
  const inner = Math.max(2, w - 4); // accounts for "│ " + " │"
  const horizLen = Math.max(0, w - 2);
  // Perimeter for hue positioning: top row + N body rows × 2 sides + bottom row.
  const perimeter = Math.max(1, horizLen * 2 + lines.length * 2);
  let cursor = 0;

  const colorChar = (ch: string): string =>
    gradientColor(cursor++, perimeter, phaseMs) + ch + RESET;

  const top = "┌" + "─".repeat(horizLen) + "┐";
  const bot = "└" + "─".repeat(horizLen) + "┘";

  const topColored = [...top].map(colorChar).join("");
  const out: string[] = [topColored];
  for (const l of lines) {
    const visible = stripAnsi(l).length;
    const content =
      visible > inner ? l.slice(0, inner) : l + " ".repeat(inner - visible);
    const left = colorChar("│");
    const right = colorChar("│");
    out.push(`${left} ${content} ${right}`);
  }
  out.push([...bot].map(colorChar).join(""));
  return out;
}
