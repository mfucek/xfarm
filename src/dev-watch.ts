// Dev-mode entry. Statically imports the TUI (and everything it pulls in)
// so `bun --watch` knows the full import graph from t=0 and reliably
// detects edits to any of those files.
//
// Don't use this for prod / `start.sh` — it skips the commander CLI and
// always runs `watch`. For prod, go through src/cli.ts.

import { runTui } from "./tui.ts";

await runTui();
