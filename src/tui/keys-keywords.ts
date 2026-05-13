import {
  isActivate,
  isChar,
  isClose,
  isDown,
  isLeft,
  isRight,
  isUp,
  type ParsedKey,
} from "./keys.ts";
import { applySuggestion, itemSuggestion } from "./keyword-items.ts";
import type { KeywordItem, TuiHost } from "./types.ts";

const isAccept = isChar("a", "y");
const isReject = isChar("r", "n");
const isAcceptAll = isChar("A", "Y");
const isRejectAll = isChar("R", "N");
const isDelete = isChar("d");
const isAdd = isChar("+");

export function handleKeywordsKey(host: TuiHost, key: ParsedKey): void {
  if (isDown(key)) {
    host.selected = Math.min(
      host.selected + 1,
      Math.max(0, host.keywordItems.length - 1),
    );
    host.draw();
    return;
  }
  if (isUp(key)) {
    host.selected = Math.max(host.selected - 1, 0);
    host.draw();
    return;
  }
  if (isActivate(key)) {
    const it = host.keywordItems[host.selected];
    if (it) openKeywordDetail(host, it);
    return;
  }
  if (isAdd(key)) {
    void handleAddKeyword(host);
    return;
  }
  if (isAccept(key)) {
    // Accept the suggestion on the highlighted row. If the row is a plain
    // keyword with no pending suggestion, fall back to "add new" so 'a' stays
    // useful row-by-row.
    const it = host.keywordItems[host.selected];
    if (!it) return;
    if (itemSuggestion(it)) resolveSelected(host, "accepted");
    else void handleAddKeyword(host);
    return;
  }
  if (isReject(key)) {
    resolveSelected(host, "rejected");
    return;
  }
  if (isAcceptAll(key)) {
    resolveAll(host, "accepted");
    return;
  }
  if (isRejectAll(key)) {
    resolveAll(host, "rejected");
    return;
  }
  if (isDelete(key)) {
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

export function handleKeywordDetailKey(host: TuiHost, key: ParsedKey): void {
  if (key.kind === "ctrl-c") {
    host.requestStop();
    return;
  }
  if (isLeft(key)) {
    navigateDetail(host, -1);
    return;
  }
  if (isRight(key)) {
    navigateDetail(host, 1);
    return;
  }
  if (isUp(key)) {
    host.detailScroll = Math.max(0, host.detailScroll - 1);
    host.draw();
    return;
  }
  if (isDown(key)) {
    host.detailScroll = host.detailScroll + 1;
    host.draw();
    return;
  }
  if (key.kind === "pgup") {
    host.detailScroll = Math.max(0, host.detailScroll - 10);
    host.draw();
    return;
  }
  if (key.kind === "pgdn") {
    host.detailScroll = host.detailScroll + 10;
    host.draw();
    return;
  }
  if (isAccept(key)) {
    resolveDetail(host, "accepted");
    return;
  }
  if (isReject(key)) {
    resolveDetail(host, "rejected");
    return;
  }
  if (isDelete(key)) {
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
  if (isClose(key)) {
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
    // Stay anchored at idx. After an "add" accept that row vanishes from the
    // top, so the item at idx is now a different row (likely the next add or
    // the first existing keyword). For remove/change verdicts the row stays
    // but loses its suggestion.
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
