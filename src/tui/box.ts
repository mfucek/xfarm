import { FG_GRAY, RESET, stripAnsi } from "./ansi.ts";

/**
 * Render a bordered text box around `lines`. `width` is the total outer
 * width including the border characters. Each content line is padded or
 * sliced to fit the inner area; ANSI escapes in content are stripped for
 * width measurement so colored text still aligns.
 *
 * Shared by the tweet-detail "bordered text" item and the keyword-detail
 * "evidence tweet" frames. Picking the color via the optional `color` arg
 * matches the previous per-call styles (DIM in tweet-detail, FG_GRAY in
 * keyword-detail) without diverging implementations.
 */
export function renderBox(
  lines: string[],
  width: number,
  color: string = FG_GRAY,
): string[] {
  const inner = Math.max(2, width - 4); // accounts for "│ " + " │"
  const horiz = "─".repeat(Math.max(0, width - 2));
  const top = `${color}┌${horiz}┐${RESET}`;
  const bot = `${color}└${horiz}┘${RESET}`;
  const out: string[] = [top];
  for (const l of lines) {
    const visible = stripAnsi(l).length;
    const content =
      visible > inner ? l.slice(0, inner) : l + " ".repeat(inner - visible);
    out.push(`${color}│${RESET} ${content} ${color}│${RESET}`);
  }
  out.push(bot);
  return out;
}
