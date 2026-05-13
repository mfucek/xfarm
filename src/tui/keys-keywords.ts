import { applySuggestion, itemSuggestion } from "./keyword-items.ts";
import type { KeywordItem, TuiHost } from "./types.ts";

export function handleKeywordsKey(host: TuiHost, key: string): void {
  if (key === "j" || key === "\x1b[B") {
    host.selected = Math.min(
      host.selected + 1,
      Math.max(0, host.keywordItems.length - 1),
    );
    host.draw();
    return;
  }
  if (key === "k" || key === "\x1b[A") {
    host.selected = Math.max(host.selected - 1, 0);
    host.draw();
    return;
  }
  if (key === "\r" || key === "\n" || key === " ") {
    const it = host.keywordItems[host.selected];
    if (it) openKeywordDetail(host, it);
    return;
  }
  if (key === "+") {
    void handleAddKeyword(host);
    return;
  }
  if (key === "a" || key === "y") {
    // Accept the suggestion on the highlighted row. If the row is a plain
    // keyword with no pending suggestion, fall back to "add new" so 'a'
    // stays useful row-by-row.
    const it = host.keywordItems[host.selected];
    if (!it) return;
    if (itemSuggestion(it)) resolveSelected(host, "accepted");
    else void handleAddKeyword(host);
    return;
  }
  if (key === "r" || key === "n") {
    resolveSelected(host, "rejected");
    return;
  }
  if (key === "A" || key === "Y") {
    resolveAll(host, "accepted");
    return;
  }
  if (key === "R" || key === "N") {
    resolveAll(host, "rejected");
    return;
  }
  if (key === "d") {
    const it = host.keywordItems[host.selected];
    if (!it || it.kind !== "keyword") return;
    const removed = host.db.removeKeyword(it.query);
    if (removed) host.flash(`deleted: ${it.query}`);
    host.refresh();
    host.selected = Math.min(
      host.selected,
      Math.max(0, host.keywordItems.length - 1),
    );
    host.draw();
  }
}

export function handleKeywordDetailKey(host: TuiHost, key: string): void {
  if (key === "\x03") {
    host.requestStop();
    return;
  }
  if (key === "\x1b[D" || key === "h") {
    navigateDetail(host, -1);
    return;
  }
  if (key === "\x1b[C" || key === "l") {
    navigateDetail(host, 1);
    return;
  }
  if (key === "\x1b[A" || key === "k") {
    host.detailScroll = Math.max(0, host.detailScroll - 1);
    host.draw();
    return;
  }
  if (key === "\x1b[B" || key === "j") {
    host.detailScroll = host.detailScroll + 1;
    host.draw();
    return;
  }
  if (key === "\x1b[5~") {
    host.detailScroll = Math.max(0, host.detailScroll - 10);
    host.draw();
    return;
  }
  if (key === "\x1b[6~") {
    host.detailScroll = host.detailScroll + 10;
    host.draw();
    return;
  }
  if (key === "a" || key === "y") {
    resolveDetail(host, "accepted");
    return;
  }
  if (key === "r" || key === "n") {
    resolveDetail(host, "rejected");
    return;
  }
  if (key === "d") {
    const it = host.detailKeyword;
    if (!it || it.kind !== "keyword") return;
    const removed = host.db.removeKeyword(it.query);
    if (removed) host.flash(`deleted: ${it.query}`);
    host.detailKeyword = null;
    host.detailTweets = [];
    host.detailScroll = 0;
    host.refresh();
    host.selected = Math.min(
      host.selected,
      Math.max(0, host.keywordItems.length - 1),
    );
    host.draw();
    return;
  }
  if (key === "q" || key === "\x1b") {
    host.detailKeyword = null;
    host.detailTweets = [];
    host.detailScroll = 0;
    host.draw();
  }
}

export function openKeywordDetail(host: TuiHost, it: KeywordItem): void {
  host.detailKeyword = it;
  host.detailScroll = 0;
  const s = itemSuggestion(it);
  if (s) {
    try {
      host.detailTweets = host.db.fetchSuggestionEvidence(
        s.chunk_id,
        s.keyword,
        5,
      );
    } catch {
      host.detailTweets = [];
    }
  } else {
    host.detailTweets = [];
  }
  host.draw();
}

function navigateDetail(host: TuiHost, delta: 1 | -1): void {
  if (!host.detailKeyword || host.keywordItems.length === 0) return;
  const next = host.selected + delta;
  if (next < 0 || next >= host.keywordItems.length) return;
  host.selected = next;
  const target = host.keywordItems[next];
  if (target) openKeywordDetail(host, target);
}

function resolveSelected(
  host: TuiHost,
  state: "accepted" | "rejected",
): void {
  const it = host.keywordItems[host.selected];
  if (!it) return;
  const s = itemSuggestion(it);
  if (!s) {
    host.flash("no pending suggestion on this row");
    return;
  }
  const updated = host.db.resolveSuggestion(s.id, state);
  if (!updated) {
    host.flash("already resolved");
    host.refresh();
    host.draw();
    return;
  }
  if (state === "accepted") {
    host.flash(applySuggestion(host.db, updated));
  } else {
    host.flash(`rejected: ${updated.verdict} ${updated.keyword}`);
  }
  host.refresh();
  host.selected = Math.min(
    host.selected,
    Math.max(0, host.keywordItems.length - 1),
  );
  host.draw();
}

function resolveDetail(host: TuiHost, state: "accepted" | "rejected"): void {
  const it = host.detailKeyword;
  if (!it) return;
  const s = itemSuggestion(it);
  if (!s) {
    host.flash("no pending suggestion on this row");
    return;
  }
  const idx = host.selected;
  const updated = host.db.resolveSuggestion(s.id, state);
  if (!updated) {
    host.detailKeyword = null;
    host.detailTweets = [];
    host.detailScroll = 0;
    host.flash("already resolved");
  } else if (state === "accepted") {
    host.flash(applySuggestion(host.db, updated));
  } else {
    host.flash(`rejected: ${updated.verdict} ${updated.keyword}`);
  }
  host.refresh();
  if (host.keywordItems.length === 0) {
    host.detailKeyword = null;
    host.detailTweets = [];
    host.detailScroll = 0;
    host.selected = 0;
  } else if (updated) {
    // Stay anchored at idx. After an "add" accept that row vanishes from
    // the top, so the item at idx is now a different row (likely the next
    // add or the first existing keyword). For remove/change verdicts the
    // row stays but loses its suggestion.
    const nextIdx = Math.min(idx, host.keywordItems.length - 1);
    host.selected = nextIdx;
    const target = host.keywordItems[nextIdx];
    if (target) openKeywordDetail(host, target);
    else {
      host.detailKeyword = null;
      host.detailTweets = [];
      host.detailScroll = 0;
    }
  }
  host.draw();
}

function resolveAll(host: TuiHost, state: "accepted" | "rejected"): void {
  if (host.pendingSuggestionCount === 0) return;
  const updated = host.db.resolveAllPendingSuggestions(state);
  if (state === "accepted") {
    let added = 0;
    let removed = 0;
    let changed = 0;
    let skipped = 0;
    for (const s of updated) {
      if (s.verdict === "add") {
        if (host.db.addKeyword(s.keyword)) added++;
        else skipped++;
      } else if (s.verdict === "remove") {
        if (host.db.removeKeyword(s.keyword)) removed++;
        else skipped++;
      } else {
        const repl = s.replacement ?? "";
        const a = repl ? host.db.addKeyword(repl) : false;
        const r = host.db.removeKeyword(s.keyword);
        if (a && r) changed++;
        else if (a) added++;
        else if (r) removed++;
        else skipped++;
      }
    }
    host.flash(
      `accepted ${updated.length} · +${added}, -${removed}, ~${changed}${
        skipped ? `, ${skipped} no-op` : ""
      }`,
      4000,
    );
  } else {
    host.flash(`rejected ${updated.length} suggestion(s)`);
  }
  host.refresh();
  host.selected = 0;
  host.draw();
}

async function handleAddKeyword(host: TuiHost): Promise<void> {
  const v = await host.promptInput("Add keyword: ");
  if (!v) return;
  const added = host.db.addKeyword(v);
  if (added) host.flash(`added: ${v}`);
  else host.flash(`already exists: ${v}`);
  host.refresh();
  host.draw();
}
