import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type ReleaseChange = { text: string };

export type ReleaseEntry = {
  version: string;
  date: string;
  title: string;
  description: string;
  changes: ReleaseChange[];
  otherChanges?: ReleaseChange[];
};

type ReleaseNotesFile = { releases: ReleaseEntry[] };

// Resolved from this module's location so it works both when running from the
// source checkout (bun run) and when the repo is installed via the dockable
// app wrapper, which still launches `bun run src/cli.ts`.
const RELEASE_NOTES_PATH = resolve(
  import.meta.dir,
  "..",
  "data",
  "release-notes.json",
);

let cached: ReleaseEntry[] | null = null;

export function loadReleaseNotes(): ReleaseEntry[] {
  if (cached) return cached;
  try {
    const raw = readFileSync(RELEASE_NOTES_PATH, "utf8");
    const parsed = JSON.parse(raw) as ReleaseNotesFile;
    cached = Array.isArray(parsed.releases) ? parsed.releases : [];
  } catch {
    cached = [];
  }
  return cached;
}
