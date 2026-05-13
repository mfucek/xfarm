import { DIM, RESET } from "./ansi.ts";

/**
 * Clamp a free-scroll offset and return the visible slice plus an overflow
 * indicator footer. "Free" = the user controls the offset directly (j/k,
 * PgUp/PgDn) and there's no cursor to keep in view. Callers should write the
 * returned `offset` back to their state so out-of-range scrolls auto-correct.
 *
 * Returns null when `lines` already fits in `viewRows` — callers can join
 * `lines` directly and pin offset to 0.
 */
export function scrollFree(
  lines: string[],
  viewRows: number,
  offset: number,
): { lines: string[]; offset: number } | null {
  if (lines.length <= viewRows) return null;
  const innerRows = Math.max(1, viewRows - 1); // reserve a row for the indicator
  const maxOffset = Math.max(0, lines.length - innerRows);
  const clamped = Math.max(0, Math.min(offset, maxOffset));
  const visible = lines.slice(clamped, clamped + innerRows);
  visible.push(indicator(clamped, visible.length, lines.length));
  return { lines: visible, offset: clamped };
}

/**
 * Anchor the view so the range [curStart, curEnd] stays visible. Used when
 * the cursor is somewhere inside `lines` (so cursor position is given as
 * line indices, not item indices) and we want to scroll just enough to keep
 * the active item on screen.
 *
 * Returns null when `lines` already fits.
 */
export function scrollAnchored(
  lines: string[],
  viewRows: number,
  curStart: number,
  curEnd: number,
): string[] | null {
  if (lines.length <= viewRows) return null;
  const innerRows = Math.max(1, viewRows - 1);
  let offset = 0;
  if (curEnd >= innerRows) offset = curEnd - innerRows + 1;
  if (curStart < offset) offset = curStart;
  offset = Math.max(0, Math.min(offset, lines.length - innerRows));
  const visible = lines.slice(offset, offset + innerRows);
  visible.push(indicator(offset, visible.length, lines.length));
  return visible;
}

function indicator(offset: number, visibleLen: number, total: number): string {
  const above = offset;
  const below = total - offset - visibleLen;
  return (
    DIM +
    `  ${offset + 1}-${offset + visibleLen} of ${total}` +
    (above > 0 ? `  ↑${above}` : "") +
    (below > 0 ? `  ↓${below}` : "") +
    RESET
  );
}
