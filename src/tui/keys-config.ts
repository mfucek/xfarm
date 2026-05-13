import { getConfigItems, isSelectable, type ConfigItem } from "./config-items.ts";
import { isActivate, isDown, isUp, type ParsedKey } from "./keys.ts";
import type { TuiHost } from "./types.ts";

export function handleConfigKey(host: TuiHost, key: ParsedKey): void {
  const items = getConfigItems(host);
  // Cursor walks every row — sections/status/usage included — so the user
  // can scroll the page by hovering. Enter is a no-op on non-selectable
  // rows (handled below). Matches Debug's behavior.
  if (isDown(key)) {
    host.configCursor = Math.min(host.configCursor + 1, items.length - 1);
    host.draw();
    return;
  }
  if (isUp(key)) {
    host.configCursor = Math.max(0, host.configCursor - 1);
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
