import {
  BOLD,
  DIM,
  FG_CYAN,
  RESET,
  renderSectionHeader,
  wrapText,
} from "./ansi.ts";
import { loadReleaseNotes, type ReleaseEntry } from "./release-notes.ts";
import { scrollFree } from "./scroll-view.ts";
import type { RenderCtx } from "./types.ts";

export function renderAbout(
  cols: number,
  bodyRows: number,
  ctx: RenderCtx,
): string {
  const width = Math.max(20, Math.min(100, cols - 4));
  const releases = loadReleaseNotes();
  const lines: string[] = [];

  if (releases.length === 0) {
    lines.push(DIM + "(no release notes yet)" + RESET);
    return lines.join("\n");
  }

  lines.push(
    DIM +
      `${releases.length} release${releases.length === 1 ? "" : "s"} · newest first` +
      RESET,
  );
  lines.push("");

  releases.forEach((r, idx) => {
    if (idx > 0) lines.push("");
    for (const l of renderRelease(r, width)) lines.push(l);
  });

  const windowed = scrollFree(lines, bodyRows, ctx.aboutScroll);
  if (!windowed) {
    ctx.aboutScroll = 0;
    return lines.join("\n");
  }
  ctx.aboutScroll = windowed.offset;
  return windowed.lines.join("\n");
}

function renderRelease(r: ReleaseEntry, width: number): string[] {
  const lines: string[] = [];
  const header =
    `${FG_CYAN}${BOLD}v${r.version}${RESET}` +
    `  ${BOLD}${r.title}${RESET}` +
    `  ${DIM}${r.date}${RESET}`;
  for (const l of renderSectionHeader(header, width)) lines.push(l);
  if (r.description) {
    for (const l of wrapText(r.description, width)) lines.push(l);
  }
  if (r.changes.length > 0) {
    lines.push("");
    for (const c of r.changes) {
      for (const l of renderBullet("•", c.text, width)) lines.push(l);
    }
  }
  if (r.otherChanges && r.otherChanges.length > 0) {
    lines.push("");
    lines.push(DIM + "other changes" + RESET);
    for (const c of r.otherChanges) {
      for (const l of renderBullet("·", c.text, width, true)) lines.push(l);
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
  const indent = "    ";
  const inner = Math.max(10, width - indent.length);
  const wrapped = wrapText(text, inner);
  const out: string[] = [];
  wrapped.forEach((line, i) => {
    const prefix = i === 0 ? `  ${marker} ` : indent;
    const body = dim ? DIM + line + RESET : line;
    out.push(prefix + body);
  });
  return out;
}
