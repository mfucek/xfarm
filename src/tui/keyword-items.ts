import type { DB } from "../db.ts";
import type { SuggestionRow } from "../types.ts";
import type { KeywordItem } from "./types.ts";

// Merge keywords + pending suggestions into a single list. Pending "add"
// suggestions surface as their own rows at the top; "remove"/"change" pin to
// the matching existing keyword. If a keyword somehow has both a remove and
// a change pending, the more destructive verdict ("remove") wins so the user
// sees the bigger ask first.
export function buildKeywordItems(db: DB): {
  items: KeywordItem[];
  pendingCount: number;
} {
  const pending = db.listPendingSuggestions();
  const keywords = db.listKeywords();
  const adds: SuggestionRow[] = [];
  const byKeyword = new Map<string, SuggestionRow>();
  for (const s of pending) {
    if (s.verdict === "add") {
      adds.push(s);
      continue;
    }
    const cur = byKeyword.get(s.keyword);
    if (!cur || (s.verdict === "remove" && cur.verdict === "change")) {
      byKeyword.set(s.keyword, s);
    }
  }
  const items: KeywordItem[] = [];
  for (const s of adds) items.push({ kind: "add", suggestion: s });
  for (const kw of keywords) {
    items.push({
      kind: "keyword",
      query: kw.query,
      last_scanned_at: kw.last_scanned_at,
      suggestion: byKeyword.get(kw.query) ?? null,
    });
  }
  return { items, pendingCount: pending.length };
}

export function itemSuggestion(it: KeywordItem): SuggestionRow | null {
  return it.kind === "add" ? it.suggestion : it.suggestion;
}

export function addsCount(items: KeywordItem[]): number {
  let n = 0;
  for (const it of items) {
    if (it.kind === "add") n++;
    else break;
  }
  return n;
}

export function applySuggestion(db: DB, s: SuggestionRow): string {
  if (s.verdict === "add") {
    const added = db.addKeyword(s.keyword);
    return added ? `added: ${s.keyword}` : `already present: ${s.keyword}`;
  }
  if (s.verdict === "remove") {
    const removed = db.removeKeyword(s.keyword);
    return removed ? `removed: ${s.keyword}` : `not in list: ${s.keyword}`;
  }
  // change: swap old → new. Apply the add first so a transient empty state
  // doesn't cause the scheduler to skip a beat if it ticks mid-swap.
  const repl = s.replacement ?? "";
  const added = db.addKeyword(repl);
  const removed = db.removeKeyword(s.keyword);
  if (added && removed) return `changed: ${s.keyword} → ${repl}`;
  if (added && !removed) return `added ${repl} (${s.keyword} was not in list)`;
  if (!added && removed) return `removed ${s.keyword} (${repl} already present)`;
  return `no change: ${s.keyword} → ${repl}`;
}
