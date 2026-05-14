import { isActivate, isChar, isDown, isUp, type ParsedKey } from "./keys.ts";
import type { TuiHost } from "./types.ts";

export function handleCandidatesKey(host: TuiHost, key: ParsedKey): void {
  const combined = [...host.candidates, ...host.nonCandidates];
  if (combined.length === 0) return;

  if (isDown(key)) {
    host.selected = Math.min(host.selected + 1, combined.length - 1);
  } else if (isUp(key)) {
    host.selected = Math.max(host.selected - 1, 0);
  } else if (isActivate(key)) {
    const r = combined[host.selected];
    if (r) {
      host.detailRow = r;
      host.tweetDetailCursor = 0;
      host.draw();
      return;
    }
  } else if (isChar("x")(key)) {
    const r = combined[host.selected];
    if (r) {
      host.db.markHidden(r.id);
      host.refresh();
      const total = host.candidates.length + host.nonCandidates.length;
      host.selected = Math.min(host.selected, Math.max(0, total - 1));
      host.flash(`hid @${r.author}`);
    }
  } else if (isChar("C")(key)) {
    const n = host.db.clearLowEngagementOldTweets(3600);
    host.refresh();
    host.flash(`cleared ${n} tweets (0 likes, >1h old)`, 4000);
  }
  host.draw();
}
