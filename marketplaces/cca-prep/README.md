# cca-prep marketplace

A tiny **local** Claude Code marketplace built for CCA-F exam prep. Ships one plugin (`cca-toolkit`) that bundles the same three artifacts already wired into this repo's project-level `.claude/`:

| Artifact | Path inside the plugin | What it does |
| --- | --- | --- |
| Slash command | `plugins/cca-toolkit/commands/explain-diff.md` | `/explain-diff [staged|working]` — walks the current diff and flags risks |
| Sub-agent | `plugins/cca-toolkit/agents/security-reviewer.md` | Read-only security review (Opus); finds injections, AuthZ gaps, path traversal, etc. |
| PreToolUse hook | `plugins/cca-toolkit/hooks/` | `block-rm-rf.sh` + `hooks.json` — denies any `Bash` tool call containing an `rm -rf`-shaped command |

## Layout

```
marketplaces/cca-prep/
  .claude-plugin/marketplace.json
  plugins/
    cca-toolkit/
      .claude-plugin/plugin.json
      commands/explain-diff.md
      agents/security-reviewer.md
      hooks/
        hooks.json
        block-rm-rf.sh
```

Two manifest locations to remember:
- **`.claude-plugin/marketplace.json`** — the marketplace itself, lists available plugins.
- **`.claude-plugin/plugin.json`** — per-plugin metadata (one of these per plugin).

Artifact directories (`commands/`, `agents/`, `hooks/`) live at the **plugin root**, not inside `.claude-plugin/`.

## Install (from the repo root)

```bash
# 1. Register this local marketplace by filesystem path
/plugin marketplace add ./marketplaces/cca-prep

# 2. Install the plugin (the @cca-prep suffix scopes it to this marketplace)
/plugin install cca-toolkit@cca-prep

# 3. Verify
/plugin    # opens the plugin manager — cca-toolkit should appear under Installed
```

## Verify it's wired

After install:

- `/explain-diff` should appear in the slash-command list (try `/<Tab>` to see).
- Ask Claude something like *"Use the security-reviewer agent to review the staged diff."* — it should dispatch to the sub-agent.
- Ask Claude to run `rm -rf /tmp/test-folder` from Bash — the plugin's PreToolUse hook should return a `deny` with the rm-rf-guard reason. (Don't worry, the project-level `.claude/settings.json` already does this too — the plugin gives you the same protection on machines where this marketplace is installed but the repo is not.)

## Why this exists alongside `.claude/`

The repo's project-level `.claude/` already wires the same three artifacts directly. The marketplace is a separate, **distributable** copy — the point of building it is to exercise the plugin-author workflow (manifests, `${PLUGIN_DIR}` hook paths, install commands) for the CCA-F exam. If you share this repo with someone else, they can either consume the artifacts via project `.claude/` (active automatically) **or** install the plugin (active only when explicitly installed in their CLI). Both paths land at the same outcome.

## Sharp pitfalls (from building this)

1. **Artifact directories go at the plugin root**, not inside `.claude-plugin/`. The `.claude-plugin/` dir is just for `plugin.json`.
2. **Hooks live in `hooks/hooks.json`** at the plugin root (same `hooks` JSON shape as a `settings.json`, but a separate file). Reference scripts via `${PLUGIN_DIR}/...`, not `${CLAUDE_PROJECT_DIR}/...`.
3. **Executable bit on hook scripts** — `chmod +x` before committing; git preserves the bit if it was set when added.
4. **Naming conflicts** — a plugin's same-named artifact takes precedence over a project-level `.claude/` artifact. Not a problem here (the plugin is an *equivalent* copy), but worth knowing.
