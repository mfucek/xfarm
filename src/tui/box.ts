import { DIM, FG_GRAY, RESET, stripAnsi } from "./ansi.ts";

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

/**
 * Render a horizontally-divided stat card: a single bordered row with
 * vertical separators between cells. Each cell gets a dim label above its
 * value. Cell widths are distributed evenly across the available inner
 * width; any leftover characters are padded onto the last cell so the
 * border lines up flush with `width`.
 */
export function renderDividedCard(
  cells: { label: string; value: string }[],
  width: number,
  color: string = FG_GRAY,
): string[] {
  if (cells.length === 0) return [];
  const n = cells.length;
  // Inner area = width - 2 (left + right border). Subtract n-1 internal
  // separators; the rest is divided evenly among cells.
  const innerTotal = Math.max(n, width - 2 - (n - 1));
  const baseCellW = Math.max(3, Math.floor(innerTotal / n));
  const widths = new Array(n).fill(baseCellW);
  const leftover = innerTotal - baseCellW * n;
  if (leftover > 0) widths[n - 1] += leftover;

  const top = `${color}┌${widths.map((w) => "─".repeat(w)).join("┬")}┐${RESET}`;
  const bot = `${color}└${widths.map((w) => "─".repeat(w)).join("┴")}┘${RESET}`;
  const sep = `${color}│${RESET}`;

  const renderRow = (texts: string[], style: string): string => {
    const segs = texts.map((t, i) => {
      const w = widths[i] ?? baseCellW;
      const inner = Math.max(0, w - 2);
      const visible = stripAnsi(t).length;
      const content =
        visible > inner
          ? t.slice(0, inner)
          : t + " ".repeat(inner - visible);
      return ` ${style}${content}${RESET} `;
    });
    return sep + segs.join(sep) + sep;
  };

  return [
    top,
    renderRow(cells.map((c) => c.label), DIM),
    renderRow(cells.map((c) => c.value), ""),
    bot,
  ];
}
