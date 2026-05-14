// Shared visual chrome for sectioned, selectable lists.
//
// Two pages use this contract — Config and Debug — and both should read the
// same to the user:
//
//   1. A cyan `│ ` left rail spans every line of the group that contains
//      the cursor. Other groups render with an equivalent-width plain
//      indent so the label column stays put when focus moves.
//   2. Within the focused group, the selected row gets a cyan `›` arrow.
//      Non-selected rows render with a placeholder space so columns align.
//   3. Section titles are non-selectable. The cursor skips them; navigation
//      stops only on rows that have an action.
//
// Callers compose lines as:
//   railPrefix(inGroup) + "  " + rowArrow(isSel) + " " + label …
//
// Each page still computes its own group membership (the two pages disagree
// on what counts as a "group boundary"), but the visual fragments live here
// so a future tweak to the rail glyph or arrow color happens in one place.

import { FG_CYAN, RESET } from "./ansi.ts";

const RAIL = `${FG_CYAN}│${RESET} `;
const NO_RAIL = "  ";
const ARROW = `${FG_CYAN}›${RESET}`;
const NO_ARROW = " ";

export const railPrefix = (inSelectedGroup: boolean): string =>
  inSelectedGroup ? RAIL : NO_RAIL;

export const rowArrow = (isSelected: boolean): string =>
  isSelected ? ARROW : NO_ARROW;

/** Compute the group ID for each item index, given a predicate that
 * identifies group-starters. Walks the items in order, incrementing a
 * counter each time `startsGroup(it)` returns true; intermediate items
 * inherit the most recent group ID. Items before the first group-starter
 * land in group -1.
 *
 * Both Config and Debug call this; their predicates differ only in which
 * kinds qualify as starters. The returned array is parallel to `items`,
 * so renderers can look up `groupOf[idx] === groupOf[cursor]` to decide
 * whether a line gets the cyan rail. */
export function assignGroups<T>(
  items: readonly T[],
  startsGroup: (it: T) => boolean,
): number[] {
  const groupOf: number[] = [];
  let g = -1;
  items.forEach((it, idx) => {
    if (startsGroup(it)) g++;
    groupOf[idx] = g;
  });
  return groupOf;
}

/** Compute "the cursor can stop here" for each item index, given the
 * group assignment and the page's selectable/group-starter predicates.
 *
 * Rule, applied identically to Config and Debug:
 *   - Selectable items are always cursor stops.
 *   - A group-starter is a cursor stop only if its group has no other
 *     selectable items. Read-only groups (debug `daemon`, config `Setup
 *     status`) anchor the cursor on their title so the user can scroll
 *     through them; interactive groups (config `Burner X account`, debug
 *     `actions`) skip the title and let the cursor land directly on the
 *     first selectable item.
 *   - Anything else (non-selectable, non-starter — e.g. config `status`
 *     and `codex_usage` content blocks) is also skipped; the group's
 *     title is the cursor anchor for those.
 *
 * Returns a boolean array parallel to `items`. Key handlers use it via
 * `nextStopIdx` / `clampToStop` (see `items.ts`) to navigate. */
export function computeCursorStops<T>(
  items: readonly T[],
  groupOf: readonly number[],
  startsGroup: (it: T) => boolean,
  selectable: (it: T) => boolean,
): boolean[] {
  const groupHasSelectable = new Map<number, boolean>();
  items.forEach((it, idx) => {
    if (selectable(it)) groupHasSelectable.set(groupOf[idx]!, true);
  });
  return items.map(
    (it, idx) =>
      selectable(it) ||
      (startsGroup(it) && !groupHasSelectable.get(groupOf[idx]!)),
  );
}
