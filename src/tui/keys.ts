// Normalize the raw byte stream from stdin into a discriminated key event.
// Handlers should match on `.kind` instead of comparing raw escape sequences
// — keeps key bindings grep-able and stops typos like "\x1b]A" silently
// dropping bindings.

export type ParsedKey =
  | { kind: "up" }
  | { kind: "down" }
  | { kind: "left" }
  | { kind: "right" }
  | { kind: "pgup" }
  | { kind: "pgdn" }
  | { kind: "enter" }
  | { kind: "space" }
  | { kind: "tab" }
  | { kind: "escape" }
  | { kind: "backspace" }
  | { kind: "ctrl-c" }
  // Single printable character (letters, digits, punctuation).
  | { kind: "char"; char: string }
  // Anything we don't recognize. Handlers can ignore or log.
  | { kind: "other"; raw: string };

export function parseKey(raw: string): ParsedKey {
  switch (raw) {
    case "\x03":
      return { kind: "ctrl-c" };
    case "\x1b":
      return { kind: "escape" };
    case "\r":
    case "\n":
      return { kind: "enter" };
    case " ":
      return { kind: "space" };
    case "\t":
      return { kind: "tab" };
    case "\x7f":
    case "\b":
      return { kind: "backspace" };
    case "\x1b[A":
      return { kind: "up" };
    case "\x1b[B":
      return { kind: "down" };
    case "\x1b[C":
      return { kind: "right" };
    case "\x1b[D":
      return { kind: "left" };
    case "\x1b[5~":
      return { kind: "pgup" };
    case "\x1b[6~":
      return { kind: "pgdn" };
  }
  if (raw.length === 1 && raw >= " " && raw !== "\x7f") {
    return { kind: "char", char: raw };
  }
  return { kind: "other", raw };
}

// --- common predicates ---
// These collapse the j/k vs. arrow-keys and enter/space-vs-activate patterns
// that show up in every page handler. Use them when the binding is "the
// usual" — fall back to matching .kind directly when it isn't.

export const isDown = (k: ParsedKey): boolean =>
  k.kind === "down" || (k.kind === "char" && k.char === "j");

export const isUp = (k: ParsedKey): boolean =>
  k.kind === "up" || (k.kind === "char" && k.char === "k");

export const isLeft = (k: ParsedKey): boolean =>
  k.kind === "left" || (k.kind === "char" && k.char === "h");

export const isRight = (k: ParsedKey): boolean =>
  k.kind === "right" || (k.kind === "char" && k.char === "l");

/** Enter or space — both "activate the row" gestures. */
export const isActivate = (k: ParsedKey): boolean =>
  k.kind === "enter" || k.kind === "space";

/** Esc or q — the "close this overlay / back out" gesture. */
export const isClose = (k: ParsedKey): boolean =>
  k.kind === "escape" || (k.kind === "char" && k.char === "q");

/** A specific printable character — `is("a", k)`. */
export const isChar =
  (...chars: string[]) =>
  (k: ParsedKey): boolean =>
    k.kind === "char" && chars.includes(k.char);
