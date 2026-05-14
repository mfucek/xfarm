import { isDown, isUp, type ParsedKey } from "./keys.ts";
import type { TuiHost } from "./types.ts";

const PAGE_SCROLL = 10;

export function handleAboutKey(host: TuiHost, key: ParsedKey): void {
  if (isDown(key)) {
    host.aboutScroll += 1;
    host.draw();
    return;
  }
  if (isUp(key)) {
    host.aboutScroll = Math.max(0, host.aboutScroll - 1);
    host.draw();
    return;
  }
  if (key.kind === "pgdn") {
    host.aboutScroll += PAGE_SCROLL;
    host.draw();
    return;
  }
  if (key.kind === "pgup") {
    host.aboutScroll = Math.max(0, host.aboutScroll - PAGE_SCROLL);
    host.draw();
    return;
  }
}
