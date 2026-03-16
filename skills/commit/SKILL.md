---
name: commit
description: "Read this skill before making git commits"
---

Create a git commit for the current changes using jc's commit message style.

## Format

`<Area>: <Summary>`

- `Area` OPTIONAL. Short product/system name (e.g., `MySQL`, `Google Ads`, `Ingest`, `Console Log`). Use title case unless the area is intentionally lowercase (e.g., `local`).
- `Summary` REQUIRED. Imperative verb phrasing, sentence-style capitalization, no trailing period. Prefer clarity and detail over brevity; avoid overly terse summaries and include relevant context/conditions. Aim for <= 50 characters but may exceed when needed.
- If no clear area applies, use just `<Summary>` (no colon).
- Do NOT add PR suffixes like `(#12345)` in the subject; those are artifacts of GitHub merge commits.

Examples from James's commits:
- `MySQL: Add spans to replication`
- `Google Ads: Rename video metric fields`
- `Ingest: Trigger sync on segment commit`
- `Marshal +Inf, -Inf, NaN to nil`

## Notes

- Body is OPTIONAL. If needed, add a blank line after the subject and write short paragraphs or bullet lists to capture details. Hard-wrap body lines at 72 characters.
- Never place `\n` escape sequences inside `-m` strings. Git will keep them as literal backslash+n text.
- For multi-paragraph bodies, use multiple `-m` flags (one paragraph per `-m`). Git inserts blank lines between them automatically.
- If the current branch name starts with digits (e.g., `2342-new-feature`), the body MUST end with `See #2342`. If there is no other body content, include just that line after the blank line.
- Do NOT add sign-offs (no `Signed-off-by`) or `Co-authored-by` lines unless explicitly asked.
- Only commit; do NOT push.
- If it is unclear whether a file should be included, ask the user which files to commit.
- Treat any caller-provided arguments as additional commit guidance. Common patterns:
  - Freeform instructions should influence area, summary, and body.
  - File paths or globs should limit which files to commit. If files are specified, only stage/commit those unless the user explicitly asks otherwise.
  - If arguments combine files and instructions, honor both.

## Steps

1. Infer from the prompt if the user provided specific file paths/globs and/or additional instructions.
2. Review `git status` and `git diff` to understand the current changes (limit to argument-specified files if provided).
3. Check the current branch name with `git rev-parse --abbrev-ref HEAD`. If it starts with digits, plan to add `See #<digits>` as the final body line; otherwise skip the issue line.
4. If there are ambiguous extra files, ask the user for clarification before committing.
5. Stage only the intended files (all changes if no files specified).
6. Run `git commit -m "<subject>"`.
   - If a body is needed, add one `-m` per paragraph in order (final paragraph must be `See #<digits>` when required).
   - Use real line breaks for wrapped lines; never use `\n` escapes in message text.
