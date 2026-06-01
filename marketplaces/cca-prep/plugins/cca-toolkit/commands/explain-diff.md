---
description: Explain the current git diff (staged or working tree) in plain English
argument-hint: '"" | "staged" | "working"'
allowed-tools: Bash
---

You are explaining the current changes in this repository to a teammate who has not seen them yet.

Mode requested by the user: `$ARGUMENTS` (empty = pick the diff that's non-empty; prefer staged when both have content).

Repo state for context:

!`git status --short`

Staged diff:

!`git diff --cached`

Unstaged diff:

!`git diff`

For each *meaningful* change in the relevant diff:

1. Name the file and the changed function/symbol/section.
2. Summarize what changed in one sentence.
3. Explain **why** it was likely made — the motivation, not the syntax.
4. Flag any risks: regressions, performance hits, security concerns, public-API breaks.

Skip pure formatting/whitespace churn unless that *is* the change. Use file_path:line_number references when pointing at specific lines.
