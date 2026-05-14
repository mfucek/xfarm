// Cursor walkers for heterogeneous item lists where only some rows are
// selectable (e.g. a config page mixing headers, status widgets, and
// actionable fields). The "is this row selectable?" predicate stays
// page-specific; this module only handles the navigation arithmetic.

/** Step the cursor in `dir` (1=down, -1=up) until landing on a selectable
 * row, or stay put if none exists in that direction. */
export function stepSelectable<T>(
  items: readonly T[],
  from: number,
  dir: 1 | -1,
  isSelectable: (it: T) => boolean,
): number {
  let i = from + dir;
  while (i >= 0 && i < items.length) {
    if (isSelectable(items[i] as T)) return i;
    i += dir;
  }
  return from;
}

/** Snap an arbitrary cursor (or a default like 0) onto the nearest
 * selectable row. Prefers the position itself, then forward, then backward.
 * Used to validate `host.someCursor` after the items list rebuilds, since
 * insertions/deletions can leave the cursor pointed at a non-selectable
 * row. */
export function clampToSelectable<T>(
  items: readonly T[],
  from: number,
  isSelectable: (it: T) => boolean,
): number {
  if (items.length === 0) return 0;
  const inRange = Math.max(0, Math.min(from, items.length - 1));
  if (isSelectable(items[inRange] as T)) return inRange;
  for (let i = inRange + 1; i < items.length; i++) {
    if (isSelectable(items[i] as T)) return i;
  }
  for (let i = inRange - 1; i >= 0; i--) {
    if (isSelectable(items[i] as T)) return i;
  }
  return 0;
}

/** Same shape as `stepSelectable`, but takes a precomputed boolean array
 * of cursor stops instead of an item predicate. Used by Config and Debug
 * after `computeCursorStops` has folded in the "group-starter is a stop
 * only when its group is read-only" rule. */
export function nextStopIdx(
  stops: readonly boolean[],
  from: number,
  dir: 1 | -1,
): number {
  let i = from + dir;
  while (i >= 0 && i < stops.length) {
    if (stops[i]) return i;
    i += dir;
  }
  return from;
}

/** Snap an arbitrary cursor onto the nearest stop in the precomputed
 * boolean array. Mirror of `clampToSelectable`, but stop-aware (handles
 * the "skip group-starters that lead selectables" rule). */
export function clampToStop(
  stops: readonly boolean[],
  from: number,
): number {
  if (stops.length === 0) return 0;
  const inRange = Math.max(0, Math.min(from, stops.length - 1));
  if (stops[inRange]) return inRange;
  for (let i = inRange + 1; i < stops.length; i++) {
    if (stops[i]) return i;
  }
  for (let i = inRange - 1; i >= 0; i--) {
    if (stops[i]) return i;
  }
  return 0;
}
