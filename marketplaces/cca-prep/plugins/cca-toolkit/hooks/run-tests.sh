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
# Wired in hooks/hooks.json under PostToolUse with matcher "Edit|Write|MultiEdit".

set -euo pipefail

input=$(cat)

tool_name=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null || true)
file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)

case "$tool_name" in
  Edit|Write|MultiEdit) ;;
  *) exit 0 ;;
esac

case "$file_path" in
  *.ts|*.tsx) ;;
  *) exit 0 ;;
esac

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

if tsc_output=$(cd "$project_path" && npx tsc --noEmit 2>&1); then
  exit 0
fi

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
