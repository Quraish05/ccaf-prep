#!/usr/bin/env bash
# PreToolUse hook: deny Bash invocations that recursively force-delete.
#
# Reads the tool-call JSON on stdin (Claude Code sends the full hook event),
# extracts the proposed Bash command, and emits a JSON `deny` decision when
# the command matches `rm -rf` patterns. Otherwise exits silently to allow.
#
# Wired in settings.json under hooks.PreToolUse with matcher "Bash".

set -euo pipefail

input=$(cat)

# Best-effort extract of .tool_input.command — falls back to empty if jq
# isn't installed or the JSON shape changes.
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || true)

if [ -z "$cmd" ]; then
  exit 0
fi

# Match if BOTH conditions hold:
#   1. The command word `rm` appears (possibly via /bin/rm, sudo rm, etc.)
#   2. The flags include both `r` and `f`, either combined (-rf / -fr /
#      -rfv / -fri / etc.) or split (-r -f / -f -r).
if printf '%s' "$cmd" | grep -qE '(^|[[:space:];|&\(])(sudo[[:space:]]+)?(/?[[:alnum:]_/-]+/)?rm([[:space:]]|$)' \
   && printf '%s' "$cmd" | grep -qE '(-[[:alpha:]]*r[[:alpha:]]*f|-[[:alpha:]]*f[[:alpha:]]*r|-r[[:space:]]+-f|-f[[:space:]]+-r)'; then
  cat <<'JSON'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Blocked by .claude rm-rf guard: recursive force-deletion (`rm -rf`) is not allowed from Claude Code in this repo. If you genuinely need it, run the command yourself in a terminal."
  }
}
JSON
  exit 0
fi

exit 0
