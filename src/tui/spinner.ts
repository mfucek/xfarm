import { DIM, RESET } from "./ansi.ts";

// Standard braille spinner. 80ms per frame ≈ 12.5fps — readable, not seizure-y.
export const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];

export function spinnerFrame(): string {
  return (
    SPINNER_FRAMES[Math.floor(Date.now() / 80) % SPINNER_FRAMES.length] ?? "⠋"
  );
}

/** Format an inline "label… <status> <frame>" line for the busy state on a
 * tweet-detail row. `color` is the foreground ANSI code applied to label and
 * spinner; `status` (e.g. "Browsing the web…") renders dim between them. */
export function renderSpinnerLabel(opts: {
  label: string;
  status: string | null | undefined;
  color: string;
}): string {
  const step = opts.status?.trim();
  const stepText = step ? ` ${DIM}${step}${RESET}` : "";
  return `${opts.color}${opts.label}…${stepText} ${opts.color}${spinnerFrame()}${RESET}`;
}
