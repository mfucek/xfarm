import { getConfigItems, isSelectable, type ConfigItem } from "./config-items.ts";
import type { TuiHost } from "./types.ts";

export function handleConfigKey(host: TuiHost, key: string): void {
  const items = getConfigItems(host);
  if (key === "j" || key === "\x1b[B") {
    host.configCursor = step(items, host.configCursor, 1);
    host.draw();
    return;
  }
  if (key === "k" || key === "\x1b[A") {
    host.configCursor = step(items, host.configCursor, -1);
    host.draw();
    return;
  }
  if (key === "\r" || key === "\n" || key === " ") {
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
