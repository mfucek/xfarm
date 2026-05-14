import {
  BOLD,
  DIM,
  FG_CYAN,
  RESET,
  stripAnsi,
  wrapText,
} from "./ansi.ts";
import { renderBox } from "./box.ts";
import { renderGradientBox } from "./gradient.ts";
import { clampToStop } from "./items.ts";
import { assignGroups, computeCursorStops, railPrefix } from "./list-rail.ts";
import { loadReleaseNotes, type ReleaseEntry } from "./release-notes.ts";
import { scrollAnchored } from "./scroll-view.ts";
import type { RenderCtx } from "./types.ts";

// One item per release block — flat list so the section/rail machinery
// from list-rail.ts treats each release as a group. We use it strictly
// for cursor-stop computation; nothing inside a release is selectable.
type AboutItem = { kind: "release"; entry: ReleaseEntry; isLatest: boolean };

export function renderAbout(
  cols: number,
  bodyRows: number,
  ctx: RenderCtx,
): string {
  const width = Math.max(20, Math.min(100, cols - 4));
  const releases = loadReleaseNotes();

  if (releases.length === 0) {
    return DIM + "(no release notes yet)" + RESET;
  }

  const items: AboutItem[] = releases.map((entry, i) => ({
    kind: "release",
    entry,
    isLatest: i === 0,
  }));

  // Every release starts its own group; no inner row is selectable, so
  // with the default `anchorEmptyGroups: true` rule, each release's
  // starter (the release item itself) becomes a cursor stop. That is
  // exactly the "snap between releases" semantic the user asked for —
  // reusing the same machinery Config/Debug use, no special case.
  const groupOf = assignGroups<AboutItem>(items, () => true);
  const stops = computeCursorStops<AboutItem>(
    items,
    groupOf,
    () => true,
    () => false,
  );
  const cur = clampToStop(stops, ctx.aboutCursor);
  ctx.aboutCursor = cur;

  const lines: string[] = [];
  lines.push(
    DIM +
      `${releases.length} release${releases.length === 1 ? "" : "s"} · newest first` +
      RESET,
  );
  lines.push("");

  let curStart = 0;
  let curEnd = 0;
  const phaseMs = Date.now();

  items.forEach((it, idx) => {
    if (idx > 0) lines.push("");
    const isSel = idx === cur;
    if (isSel) curStart = lines.length;

    // Box width drops by 2 to make room for the rail prefix, so the
    // outer footprint stays equal across focused and unfocused
    // releases — no horizontal shift when the cursor moves.
    const inner = renderReleaseInner(it.entry, width - 6);
    const box = it.isLatest
      ? renderGradientBox(inner, width - 2, phaseMs)
      : renderBox(inner, width - 2, DIM);
    const prefix = railPrefix(isSel);
    for (const l of box) lines.push(prefix + l);

    if (isSel) curEnd = lines.length - 1;
  });

  // Use scrollAnchored so the focused release always stays visible —
  // same anchoring scroll Config/Debug use. PgUp/PgDn is handled by the
  // key handler bumping aboutCursor by ±1 release instead of relying on
  // a free-scroll offset.
  const windowed = scrollAnchored(lines, bodyRows, curStart, curEnd);
  return (windowed ?? lines).join("\n");
}

/** Render the inner content of a release box: header line, optional
 * description, primary changes, optional "other changes" subsection.
 * `innerWidth` is the available text width inside the box's "│ " / " │"
 * padding — same budget renderBox / renderGradientBox use. */
function renderReleaseInner(r: ReleaseEntry, innerWidth: number): string[] {
  const lines: string[] = [];
  const header =
    `${FG_CYAN}${BOLD}v${r.version}${RESET}` +
    `  ${BOLD}${r.title}${RESET}` +
    `  ${DIM}${r.date}${RESET}`;
  lines.push(fitVisible(header, innerWidth));

  if (r.description) {
    lines.push("");
    for (const l of wrapText(r.description, innerWidth)) lines.push(l);
  }

  if (r.changes.length > 0) {
    lines.push("");
    for (const c of r.changes) {
      for (const l of renderBullet("•", c.text, innerWidth)) lines.push(l);
    }
  }

  if (r.otherChanges && r.otherChanges.length > 0) {
    lines.push("");
    lines.push(DIM + fitVisible("other changes", innerWidth) + RESET);
    for (const c of r.otherChanges) {
      for (const l of renderBullet("·", c.text, innerWidth, true)) lines.push(l);
    }
  }

  return lines;
}

function renderBullet(
  marker: string,
  text: string,
  width: number,
  dim = false,
): string[] {
  const indent = "  ";
  const inner = Math.max(10, width - indent.length);
  const wrapped = wrapText(text, inner);
  const out: string[] = [];
  wrapped.forEach((line, i) => {
    const prefix = i === 0 ? `${marker} ` : indent;
    const body = dim ? DIM + line + RESET : line;
    out.push(prefix + body);
  });
  return out;
}

function fitVisible(s: string, width: number): string {
  if (stripAnsi(s).length <= width) return s;
  // The header is composed of short fields, so the truncation case is
  // rare; we don't bother reconstructing color spans on the slice.
  const plain = stripAnsi(s);
  return plain.slice(0, Math.max(0, width - 1)) + "…";
}
