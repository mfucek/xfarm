# Project conventions

## File size: refactor at >500 LoC

Source files in this repo must stay under **500 lines**. A `PostToolUse` hook
(`.claude/hooks/check-file-loc.sh`, wired via `.claude/settings.json`) runs
after every `Write`/`Edit` and emits a reminder when a touched source file
crosses the threshold.

**When you get that reminder, do not ignore it.** Split the file before
considering the task complete. The hook only fires on source extensions
(`.ts .tsx .js .jsx .mjs .cjs .py .go .rs .java .kt .swift .rb .php
.c .cc .cpp .h .hpp`); markdown, yaml, json, etc. are exempt.

### How to split

Pick the boundary that matches the file's actual shape — not arbitrary
chunking. Common patterns in this codebase:

- **TUI / rendering code** → separate render functions (pure: state + cols
  → string) from key handlers from state coordination. ANSI helpers and
  text utilities (`stripAnsi`, `wrapText`, etc.) belong in their own
  module.
- **Repository / DB classes** → one module per entity (tweets, authors,
  keywords, …) plus a thin composing class. Keep schema and migrations
  in their own file.
- **Workers with shared infrastructure** (e.g. `judge` + `suggester` both
  use Vertex) → extract the client construction, credentials, and prompt
  template loading into a shared module.

### What "complete" means

A task isn't done while the file is still over threshold. If the refactor
is genuinely out of scope for the current change, surface that explicitly
to the user — don't silently leave the warning unaddressed.
