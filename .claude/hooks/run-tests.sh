#!/usr/bin/env bash
# PostToolUse hook: after Claude edits a TS/TSX file inside one of the
# project apps, run that project's typecheck (the closest thing this
# repo has to a "test suite" right now) and feed any failures back to
# the agent via PostToolUse hookSpecificOutput.additionalContext.
#
# Routing: file path → project. Edits outside the project apps (config
# files, docs, .claude/, marketplaces/, etc.) are skipped — typechecking
# the whole repo per edit is too expensive and most edits don't touch
# TS at all.
#
# Wired in settings.json under hooks.PostToolUse with matcher "Edit|Write|MultiEdit".

set -euo pipefail

input=$(cat)

tool_name=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null || true)
file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)

# Only act on file-edit tools. The matcher in settings.json should
# already filter, but defend in depth in case the hook gets attached
# to a broader matcher later.
case "$tool_name" in
  Edit|Write|MultiEdit) ;;
  *) exit 0 ;;
esac

# Only act on TypeScript edits. CSS / md / json / config changes
# don't move the typecheck needle.
case "$file_path" in
  *.ts|*.tsx) ;;
  *) exit 0 ;;
esac

# Route the edit to its owning project. Edits outside the two project
# apps (e.g. .claude/, marketplaces/, scripts/) skip — no project-level
# tsconfig to check against.
case "$file_path" in
  *project-1-research*) project_dir="project-1-research" ;;
  *project-2-triage*)   project_dir="project-2-triage" ;;
  *) exit 0 ;;
esac

repo_root="$(git -C "$(dirname "$file_path")" rev-parse --show-toplevel 2>/dev/null || echo "${CLAUDE_PROJECT_DIR:-$PWD}")"
project_path="$repo_root/$project_dir"

if [ ! -d "$project_path" ] || [ ! -f "$project_path/tsconfig.json" ]; then
  exit 0
fi

# Run the typecheck. Capture combined stdout+stderr; clip to a reasonable
# size so the additionalContext we feed back doesn't balloon the model's
# next-turn context. A handful of errors is what the model needs to act
# on; thousands of cascading errors are usually one root cause anyway.
if tsc_output=$(cd "$project_path" && npx tsc --noEmit 2>&1); then
  # Green — nothing to surface.
  exit 0
fi

# Failure path. Trim and surface.
clipped=$(printf '%s' "$tsc_output" | head -c 4000)

jq -n --arg dir "$project_dir" --arg out "$clipped" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: (
      "[run-tests hook] Typecheck FAILED in `" + $dir + "` after the last edit. " +
      "Fix these errors before continuing:\n\n```\n" + $out + "\n```\n\n" +
      "If you intentionally introduced these errors and plan to fix them in a follow-up edit, acknowledge them and continue. " +
      "Otherwise, edit the source to make the typecheck green before moving on."
    )
  }
}'
