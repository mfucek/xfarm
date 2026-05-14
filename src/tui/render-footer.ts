import { BOLD, DIM, FG_GRAY, RESET } from "./ansi.ts";
import { itemSuggestion } from "./keyword-items.ts";
import type { RenderCtx } from "./types.ts";

export function renderFooter(ctx: RenderCtx): string {
  if (ctx.inputMode) {
    return DIM + "enter: confirm · esc: cancel" + RESET;
  }
  if (ctx.detailRow) {
    return (
      DIM +
      "↑/↓ select · ←/→ prev/next · Enter run · x hide · esc/q back" +
      RESET
    );
  }
  if (ctx.detailKeyword) {
    const hasSugg = itemSuggestion(ctx.detailKeyword) != null;
    const actions = hasSugg ? "a/y accept · r/n reject · " : "";
    const del = ctx.detailKeyword.kind === "keyword" ? "d delete · " : "";
    return (
      DIM +
      `←/→ prev/next · ↑/↓ scroll · ${actions}${del}esc back` +
      RESET
    );
  }
  if (ctx.page === "candidates") {
    return (
      DIM +
      "j/k move · enter/space view · x hide · C clear stale · Tab/←→ switch · q quit" +
      RESET
    );
  }
  if (ctx.page === "keywords") {
    return (
      DIM +
      "j/k move · ⏎ view · a/y accept · r/n reject · A/R all · d delete · + new · Tab switch · q quit" +
      RESET
    );
  }
  if (ctx.page === "config") {
    return (
      DIM +
      "↑/↓ select · Enter edit · Tab/←→ switch · q quit" +
      RESET
    );
  }
  return (
    DIM +
    "↑/↓ select · Enter run · R reload · S stop · B boot · Tab/←→ switch · q quit" +
    RESET
  );
}

export function renderInputBar(ctx: RenderCtx): string {
  return BOLD + ctx.inputPrompt + RESET + ctx.inputBuffer + FG_GRAY + "▏" + RESET;
}
