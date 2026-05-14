---
name: push
description: Push the current branch to origin with a version bump and a release-notes entry. Use when the user says "push", "ship it", "/push", etc.
user_invocable: true
---

# Push

Ship the current work to `origin/main`. Bumps `package.json#version`, appends an
entry to `src/data/release-notes.json`, commits, and pushes.

This is the single-branch counterpart to the multi-branch `/deploy` flow —
xfarm has no `develop` branch and no e2e suite, so we go straight to `main`.

## When to Use

- User types `/push`
- User says "push", "ship it", "publish"

## Execution Steps

Follow these steps **exactly in order**. Use the Bash tool for git commands.
Stop and report to the user if any step fails.

### 1. Record Starting State

```bash
ORIGINAL_BRANCH=$(git branch --show-current)
```

Refuse to proceed if `ORIGINAL_BRANCH` is empty (detached HEAD) — that is
almost never what the user wants.

### 2. Fetch Latest

```bash
git fetch origin
```

### 3. Typecheck

Run the project's TypeScript check before doing anything else. xfarm has no
separate build step — `tsc --noEmit` is the fast pre-push gate.

```bash
bun run typecheck
```

If it fails, **stop immediately**, report the errors, and do not continue.

### 4. Determine the Version Bump

Read the current version from `package.json`. The user may have already
hand-bumped the version in the working tree; respect that.

1. Read the working-tree `package.json` version → `WORKING_VERSION`.
2. Read the version at `origin/main` → `REMOTE_VERSION`.
   - `git show origin/main:package.json` then parse `.version`.
3. If `WORKING_VERSION !== REMOTE_VERSION`, the user already bumped — use
   `WORKING_VERSION` as the new version. Skip step 5's `package.json` edit.
4. Otherwise, pick a bump level from the commits being shipped
   (`git log origin/main..HEAD --oneline` plus any staged/unstaged work the
   user wants included):
   - `fix:`, polish, prompt tweak, copy → **patch** (`0.7.0` → `0.7.1`)
   - `feat:`, new flag, new page, new behavior → **minor** (`0.7.0` → `0.8.0`)
   - Breaking change to config schema, on-disk layout, or CLI surface →
     **major** (`0.7.0` → `1.0.0`)
   - When mixed, the highest wins. When unsure, prefer **patch**.

This matches the rule in `.claude/CLAUDE.md` (Version bumps section).

### 5. Edit `package.json` (if needed)

Skip if step 4 found the user already bumped. Otherwise, edit `package.json`
and set `version` to the new value.

### 6. Generate the Release Notes Entry

Release notes live in `src/data/release-notes.json` and render on the **About**
tab of the TUI. The file shape is:

```json
{
  "releases": [
    {
      "version": "0.8.0",
      "date": "2026-05-14",
      "title": "Long Break Visibility",
      "description": "Sentence that frames what changed — the before/after, not a feature list.",
      "changes": [
        { "text": "Short title, one-sentence description." }
      ],
      "otherChanges": [
        { "text": "Secondary improvement worth noting but not headline." }
      ]
    }
  ]
}
```

Generate a new entry for the version being pushed:

- `version` — the new version from step 4/5.
- `date` — today's date in `YYYY-MM-DD`. Use the value from the
  `currentDate` context block.
- `title` — 3-6 word summary of the release theme.
- `description` — 1 sentence (2 for big releases) framing the change as
  before/after. Don't restate the changes list in prose.
- `changes` — 1-5 headline items: `{ "text": "Short title, one-sentence description." }`.
  Sort by user impact, not commit recency. **No icon field** (xfarm renders
  in a TUI, not Lucide).
- `otherChanges` — optional, secondary improvements. Skip purely-internal
  commits (CI tweaks, hook edits, dep bumps, refactors with no user-visible
  effect) entirely.

**Tone:**

- Calm, clear, product-update voice — not changelog, not marketing.
- Describe what the **user gets**, not what was implemented.
- Frame internal improvements as user benefits.

**Title & description selection (MANDATORY):**

Before writing the entry, use `AskUserQuestion` to let the user pick from 3
candidate title/description pairs. Each candidate should emphasize a different
angle of the release (biggest new feature, broadest theme, most impactful
fix). Same tone — vary the **content focus**.

Use a single question with 3 options. Each option's `label` is the title and
`preview` shows the full title + description together.

```
AskUserQuestion({
  questions: [{
    question: "Which angle best represents this release?",
    header: "Release notes",
    multiSelect: false,
    options: [
      {
        label: "<Title A>",
        description: "<one-line angle>",
        preview: "<Title A>\n\n<Description A>"
      },
      {
        label: "<Title B>",
        description: "<one-line angle>",
        preview: "<Title B>\n\n<Description B>"
      },
      {
        label: "<Title C>",
        description: "<one-line angle>",
        preview: "<Title C>\n\n<Description C>"
      }
    ]
  }]
})
```

**Review final entry (MANDATORY):**

After the user picks, generate the full `changes` array (and `otherChanges`
if applicable), then print the complete entry in this human-readable form:

```
**<Title>** (vX.Y.Z)
<Description>

- <Change text>
- <Change text>

Other changes:
- <Change text>
```

Omit the "Other changes" section if there are none. Then ask the user to
confirm:

```
AskUserQuestion({
  questions: [{
    question: "Are these release notes right?",
    header: "Review",
    multiSelect: false,
    options: [
      { label: "Yes, looks good", description: "Write the entry and push" },
      { label: "No, suggest changes", description: "I'll tell you what to adjust" }
    ]
  }]
})
```

- **Yes** → write the entry.
- **No** → apply feedback, reprint, re-ask until approved.

### 7. Prepend the Entry

Read `src/data/release-notes.json`, prepend the new entry to the
`releases` array (newest first), and write it back. Preserve the existing
2-space indent.

### 8. Commit and Push

Stage `package.json` and `src/data/release-notes.json` along with whatever
other changes are part of this push, then commit with a message describing
the release.

Format the commit message like the recent ones in this repo (`git log
--oneline -10`): leading version tag for headline releases (e.g. `v0.8.0:
<headline>`), or a plain conventional message for smaller bumps.

```bash
git add package.json src/data/release-notes.json <other files…>
git commit -m "<message>"
git push origin HEAD
```

Use a HEREDOC for the commit message to preserve formatting.

### 9. Report

One short summary:

- New version (e.g. `v0.8.0`)
- One-line description of what shipped
- That `origin/main` is now up to date

## Error Handling

- If typecheck fails, **stop immediately**, report errors, do not continue.
- If the push fails (non-fast-forward, auth, etc.), report and stop. Never
  force-push.
- Never use `--no-verify` or bypass signing.
- Resolve merge state honestly — don't `git reset --hard` to make a
  conflict go away.

## Important Rules

- Always ask for confirmation on the release-notes entry before writing it.
- The version bump is **mandatory** per `.claude/CLAUDE.md` — never skip it.
- Skip purely-internal commits (hooks, CI, dep bumps, internal refactors)
  from the `changes` and `otherChanges` lists — but they still ship in the
  commit.
