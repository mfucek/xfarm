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
 * Base rule (always applied):
 *   - Selectable items are always cursor stops.
 *   - Non-selectable, non-starter rows (e.g. config `status` and
 *     `codex_usage` content blocks, tweet-detail `meta`/`text`) are
 *     always skipped.
 *
 * `anchorEmptyGroups` (default `true`) controls what happens to a
 * group-starter whose group has no selectable rows underneath:
 *   - `true` (Config/Debug): the starter itself becomes a cursor stop,
 *     so read-only groups (config `Setup status`, debug `daemon`)
 *     anchor the cursor on their title and the user can scroll through
 *     them. Interactive groups (their starter is non-selectable but the
 *     group has selectables below) still skip the title and land the
 *     cursor on the first selectable row.
 *   - `false` (Tweet detail, About-style use cases): starters never
 *     become cursor stops on their own — j/k lands only on truly
 *     selectable rows. Read-only groups become pure visual chrome
 *     that the cursor passes over without pausing on. About is a
 *     degenerate case: it sets `selectable` to "always false" so the
 *     starter-as-stop fallback is the *only* way the cursor lands
 *     anywhere; that page uses `anchorEmptyGroups: true` (the default).
 *
 * Returns a boolean array parallel to `items`. Key handlers use it via
 * `nextStopIdx` / `clampToStop` (see `items.ts`) to navigate. */
export function computeCursorStops<T>(
  items: readonly T[],
  groupOf: readonly number[],
  startsGroup: (it: T) => boolean,
  selectable: (it: T) => boolean,
  opts: { anchorEmptyGroups?: boolean } = {},
): boolean[] {
  const anchorEmptyGroups = opts.anchorEmptyGroups ?? true;
  const groupHasSelectable = new Map<number, boolean>();
  items.forEach((it, idx) => {
    if (selectable(it)) groupHasSelectable.set(groupOf[idx]!, true);
  });
  return items.map(
    (it, idx) =>
      selectable(it) ||
      (anchorEmptyGroups &&
        startsGroup(it) &&
        !groupHasSelectable.get(groupOf[idx]!)),
  );
}
