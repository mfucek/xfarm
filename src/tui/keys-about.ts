import { clampToStop, nextStopIdx } from "./items.ts";
import { isDown, isUp, type ParsedKey } from "./keys.ts";
import { assignGroups, computeCursorStops } from "./list-rail.ts";
import { loadReleaseNotes } from "./release-notes.ts";
import type { TuiHost } from "./types.ts";

// j/k snaps cursor release-to-release; the renderer (render-about.ts)
// anchors the viewport on the focused release via scrollAnchored, so
// scrolling falls out of the cursor move — no separate offset needed.
// PgUp/PgDn jump multiple releases at a time for fast travel through
// a long history.
const PAGE_JUMP = 5;

function buildStops(releaseCount: number): boolean[] {
  // Same shape render-about.ts uses: one synthetic item per release,
  // every item starts its own group, nothing is "selectable" — relying
  // on the default `anchorEmptyGroups: true` rule so every release
  // becomes a cursor stop.
  const items = new Array(releaseCount).fill(null);
  const groupOf = assignGroups(items, () => true);
  return computeCursorStops(items, groupOf, () => true, () => false);
}

export function handleAboutKey(host: TuiHost, key: ParsedKey): void {
  const releases = loadReleaseNotes();
  if (releases.length === 0) return;
  const stops = buildStops(releases.length);
  host.aboutCursor = clampToStop(stops, host.aboutCursor);

  if (isDown(key)) {
    host.aboutCursor = nextStopIdx(stops, host.aboutCursor, 1);
    host.draw();
    return;
  }
  if (isUp(key)) {
    host.aboutCursor = nextStopIdx(stops, host.aboutCursor, -1);
    host.draw();
    return;
  }
  if (key.kind === "pgdn") {
    let next = host.aboutCursor;
    for (let i = 0; i < PAGE_JUMP; i++) next = nextStopIdx(stops, next, 1);
    host.aboutCursor = next;
    host.draw();
    return;
  }
  if (key.kind === "pgup") {
    let prev = host.aboutCursor;
    for (let i = 0; i < PAGE_JUMP; i++) prev = nextStopIdx(stops, prev, -1);
    host.aboutCursor = prev;
    host.draw();
    return;
  }
}
