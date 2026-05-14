import { getConfigItems, isSelectable, type ConfigItem } from "./config-items.ts";
import { clampToStop, nextStopIdx } from "./items.ts";
import { isActivate, isDown, isUp, type ParsedKey } from "./keys.ts";
import { assignGroups, computeCursorStops } from "./list-rail.ts";
import type { TuiHost } from "./types.ts";

// Cursor stops on selectable rows (field/toggle) OR on a section title
// when that section has no selectables (so users can still hover read-only
// groups like Setup status). Headers that lead selectable rows are
// transparent to navigation — pressing Down from the previous group lands
// directly on the first selectable row underneath. Same rule applies in
// Debug; see `computeCursorStops` in `list-rail.ts`.

function buildStops(items: ConfigItem[]): boolean[] {
  const groupOf = assignGroups(items, (it) => it.kind === "header");
  return computeCursorStops(
    items,
    groupOf,
    (it) => it.kind === "header",
    isSelectable,
  );
}

export function handleConfigKey(host: TuiHost, key: ParsedKey): void {
  const items = getConfigItems(host);
  const stops = buildStops(items);
  // Defensive: if the items list rebuilt and the previous cursor now points
  // at a skipped row, snap to the nearest stop before processing the key.
  host.configCursor = clampToStop(stops, host.configCursor);

  if (isDown(key)) {
    host.configCursor = nextStopIdx(stops, host.configCursor, 1);
    host.draw();
    return;
  }
  if (isUp(key)) {
    host.configCursor = nextStopIdx(stops, host.configCursor, -1);
    host.draw();
    return;
  }
  if (isActivate(key)) {
    const item = items[host.configCursor];
    if (!item || !isSelectable(item)) return;
    void runItem(host, item);
    return;
  }
}

async function runItem(host: TuiHost, item: ConfigItem): Promise<void> {
  try {
    let msg: string | null = null;
    if (item.kind === "field") msg = await item.edit(host);
    else if (item.kind === "toggle") msg = await item.run(host);
    if (msg) host.flash(msg, 4000);
    host.refresh();
    host.draw();
  } catch (e) {
    host.flash(`failed: ${(e as Error).message}`, 5000);
    host.draw();
  }
}
