import { getConfigItems, isSelectable, type ConfigItem } from "./config-items.ts";
import { isActivate, isDown, isUp, type ParsedKey } from "./keys.ts";
import type { TuiHost } from "./types.ts";

export function handleConfigKey(host: TuiHost, key: ParsedKey): void {
  const items = getConfigItems(host);
  if (isDown(key)) {
    host.configCursor = step(items, host.configCursor, 1);
    host.draw();
    return;
  }
  if (isUp(key)) {
    host.configCursor = step(items, host.configCursor, -1);
    host.draw();
    return;
  }
  if (isActivate(key)) {
    const item = items[host.configCursor];
    if (!item) return;
    void runItem(host, item);
    return;
  }
}

function step(items: ConfigItem[], from: number, dir: 1 | -1): number {
  let i = from + dir;
  while (i >= 0 && i < items.length) {
    if (isSelectable(items[i]!)) return i;
    i += dir;
  }
  return from;
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
