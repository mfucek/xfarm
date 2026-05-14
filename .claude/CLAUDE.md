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

## Version bumps: every push bumps `package.json#version`

Every push to `origin` must include a bump of the `version` field in
`package.json`. **There is no git hook enforcing this** — the agent is
solely responsible. When the user asks to push, bump the version first,
include the bump in the same commit as the change (or as a separate tip
commit), then push.

Pick the bump level by the nature of the change:

- **patch** (e.g. `0.3.0` → `0.3.1`): bug fix, refactor, prompt tweak,
  copy/UI tweak, internal cleanup.
- **minor** (e.g. `0.3.1` → `0.4.0`): new user-facing feature, new flag,
  new behavior, new page/tab.
- **major** (e.g. `0.3.1` → `1.0.0`): breaking change to config schema,
  on-disk data layout, CLI surface, or daemon protocol.

If unsure, prefer **patch**. The header renders `v<version>` next to the
title (see `src/tui/render-header.ts`), so users see the bump on next
launch.
