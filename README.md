# cca-f-prep

Three end-to-end Next.js + TypeScript projects built while preparing for the **Claude Certified Architect — Foundations** exam. Each project goes deep on a different surface of the Anthropic stack — multi-agent orchestration with MCP, governance + structured outputs, and Claude Code in CI — so the cert's five domains all get exercised in real running code rather than only in flashcards.

## Projects

| # | Project | What it is | Cert domain it stress-tests | Live | Screenshot |
| --- | --- | --- | --- | --- | --- |
| 1 | [project-1-research](project-1-research/README.md) | Orchestrator-workers research agent: planner → parallel searcher sub-agents → synthesizer, all sharing an in-process MCP notes store. First-party Citations API in the synth step. | Agentic Architecture & Orchestration (~27%) · MCP | _not yet deployed_ | <a href="research-ui.png"><img src="research-ui.png" width="220" alt="Research orchestrator UI" /></a> |
| 2 | [project-2-triage](project-2-triage/README.md) | Customer-support triage agent on the raw Messages API with a manual tool-use loop, forced `tool_choice` for structured output, PreToolUse hook for the refund cap, PCI redaction, vision, and a 16-sample Inspect-style eval. | Prompt Engineering & Structured Output · Context Management & Reliability | _not yet deployed_ | <a href="traige-full.png"><img src="traige-full.png" width="220" alt="Triage inbox UI" /></a> |
| 3 | [project-3 (in-repo)](marketplaces/cca-prep/plugins/cca-toolkit) | Claude Code in CI: a `/review-pr` slash command + `claude-review.yml` GH Action that runs `claude -p` headlessly on every labeled PR, a PostToolUse typecheck hook that feeds errors back into the agent loop, and a deliberately-flawed admin route as the demo target. | Claude Code Configuration & Workflows | _CI artefact — see `.github/workflows/`_ | _screenshot pending — first `claude-review` bot PR comment_ |

Concept references live in [`docs/`](docs/): [project-1-concepts](docs/project-1-concepts.md), [project-2-concepts](docs/project-2-concepts.md), [project-3-concepts](docs/project-3-concepts.md), [six scenario patterns](docs/scenario-patterns.md), [MCP auth + sampling notes](docs/mcp-auth-sampling.md).

## How to run locally

Both Next.js projects expect an `ANTHROPIC_API_KEY` in a project-level `.env`.

```bash
# Project 1 — research orchestrator
cd project-1-research && npm install && npm run dev
# open http://localhost:3000

# Project 2 — triage agent
cd project-2-triage && npm install && npm run dev
# open http://localhost:3000
```

Project 3 isn't a runnable web app — it ships as a Claude Code plugin + a GitHub Actions workflow. Try it locally with:

```bash
# Inside Claude Code at the repo root
/plugin install ./marketplaces/cca-prep
# then /review-pr against your current branch
```

The GH Action fires automatically on any PR carrying the `claude-review` label, provided the repo has `ANTHROPIC_API_KEY` as a secret.

## What I learned

Three sharp takeaways per project — the kind the exam tends to probe, and the kind worth being able to articulate cold.

### Project 1 — research orchestrator
- **Orchestrator-workers earns its complexity only when sub-tasks are genuinely independent.** Parallel fan-out is the point — if step N+1 depends on step N's output, prompt-chaining is the right shape and the orchestrator pattern is overkill.
- **Citations API beats prompt-based "ask the model to inline `[text](url)`".** The Citations API enforces `cited_text` offsets server-side, so attribution becomes verifiable rather than trusted. `cited_text` is also free in output tokens — there's no cost reason to skip it.
- **In-process MCP via `InMemoryTransport` is the cheapest way to share state across sub-agents.** No subprocess, no network. The lesson is that MCP isn't only for cross-process boundaries — it's also a clean tool-bus inside one Node process.

### Project 2 — triage agent
- **`tool_choice: { type: "tool", name: "..." }` is the canonical structured-output recipe.** Strict-mode JSON Schema is enforced server-side; if the model tries to `end_turn` without the structured tool, force-recover on a follow-up turn with the same `tool_choice`. The "no JSON, just call this tool" framing is more reliable than asking for JSON in prose.
- **PreToolUse hooks belong outside the system prompt.** Policy enforcement that survives prompt injection (e.g. the refund-cap hook denying any `issue_refund` with `amount_cents > 50000`) is what actually fails closed — system-prompt rules don't, when the user message is hostile.
- **`temperature: 0` is non-negotiable for evals.** One non-deterministic sample per pass masks real regressions. Production runs can tolerate jitter; eval runs cannot.

### Project 3 — Claude Code in CI
- **Headless `claude -p --output-format stream-json --dangerously-skip-permissions` is the CI-ready surface.** `jq -rs '[.[] | select(.type == "result")] | last | .result'` extracts the final reply from the event stream regardless of how chatty the run was; fallback to `[]` on invalid JSON keeps the workflow green when the model misbehaves.
- **Slash-command frontmatter is per-command tool gating.** `allowed-tools: ["Read", "Grep", "Bash(git diff:*)"]` is the slash-command equivalent of agent tool gating — review tasks shouldn't have `Write` or `Edit` in scope; the matcher form (`Bash(git diff:*)`) lets in the diff fetch without opening up arbitrary shell.
- **PostToolUse hooks inject feedback into the next turn via `hookSpecificOutput.additionalContext`.** Typecheck after every TS edit; pipe failures back into the agent loop so it self-corrects without user prompting. The hook script must be LF-only — CRLF endings kill `set -euo pipefail` silently and you get a hook that "runs" but does nothing.

## Design rationale

Why three small projects instead of one unified platform? See [`docs/why-three-projects.md`](docs/why-three-projects.md) for the long form — short version: the exam tests three distinct deployment surfaces (Agent SDK, Claude Code, MCP), and a single unified project would naturally lean toward one and short-change the others.

## Repo layout

```
cca-f-prep/
├── README.md                       # this file
├── project-1-research/             # Next.js — orchestrator agent
├── project-2-triage/               # Next.js — triage agent
├── marketplaces/cca-prep/          # Claude Code plugin (project-3 artefact)
├── .github/workflows/              # claude-review.yml (project-3 artefact)
├── .claude/                        # project-level CC config + hooks
└── docs/                           # concept references + scenario patterns
```
