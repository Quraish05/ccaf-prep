# Project 1 — Concepts reference

> Last updated: 2026-06-01 · Covers Days 4-7 of the CCA-F prep

A skim-before-the-exam reference of every concept Project 1 actually touched. Each entry has the load-bearing facts + a pointer to where the concept lives in the codebase. Drill into the [Project 1 README](../project-1-research/README.md), the [orchestrator walkthrough](../project-1-research/docs/orchestrator-route.md), or [MCP auth + sampling notes](mcp-auth-sampling.md) when you need the long form.

**Exam domain tags** map each concept to the 5 weighted areas the CCA-F tests on:
- `[ARCH]` Agentic Architecture & Orchestration (~27%)
- `[MCP]` Tool Design & MCP Integration (~18%)
- `[CC]` Claude Code Configuration & Workflows (~20%)
- `[PROMPT]` Prompt Engineering & Structured Output (~20%)
- `[REL]` Context Management & Reliability (~15%)

---

## 1. Agentic architecture

### The 5 workflow patterns from *Building effective agents* `[ARCH]`
Memorise the names + one canonical use case each:
1. **Prompt chaining** — sequential calls, each step's output feeds the next (draft → translate → grammar-check).
2. **Routing** — classifier sends each input to one of N agents (support triage: refund / billing / tech).
3. **Parallelisation** — fan-out the same task or vote on the same input, aggregate (review a diff for security / perf / style in parallel).
4. **Orchestrator-workers** — central LLM decomposes and dispatches to workers whose number is decided at runtime (← this project).
5. **Evaluator-optimiser** — one LLM produces, another scores + critiques in a loop until quality bar is met.

*Augmented LLM* (single model + tools/memory/retrieval) and *agents* (autonomous loops) are framing primitives, NOT in the list of five.

### Orchestrator-workers (this project's shape) `[ARCH]`
Planner → N parallel searchers → synthesiser, all sharing a single in-process MCP notes store. Lives in [`app/api/research/_lib.ts`](../project-1-research/app/api/research/_lib.ts) as `runResearch()`. Used when sub-tasks are **independent and parallelisable** — research is the canonical fit. Trade-offs vs single-agent-with-tools are in the Project 1 README.

### Sub-agents (Agent SDK) `[ARCH]`
An `AgentDefinition` with its own system prompt, tool allowlist, and model. Three patterns to know:
- **Agent-as-main-thread** — `agents: { _main: agent }` + `agent: "_main"` makes the AgentDefinition the run's main loop. That's how every `runAgent` call works here.
- **Task-tool sub-agents** — a parent invokes via the Task tool; not used in this project.
- **On-disk sub-agents** — `.claude/agents/<name>.md` files Claude Code auto-loads. Used here for `security-reviewer`.

Frontmatter for on-disk: `name`, `description`, `tools` (allowlist array), `model`.

### Failure isolation in fan-out `[REL]`
`Promise.allSettled` over the searcher invocations — one searcher rejecting doesn't poison the run. The other searchers' notes still land in the shared array. **Empty-notes guard** short-circuits with a 502 only when *every* searcher failed.

### `permissionMode: "bypassPermissions"` `[ARCH]`
Skips all interactive permission prompts. Required for server-side automation (no human in the loop). Must be paired with `allowDangerouslySkipPermissions: true` as an explicit acknowledgement. The real safety boundary becomes the `AgentDefinition.tools` allowlist plus hooks.

Contrast with `acceptEdits` — that one only auto-approves file-edit tools (`Edit`, `Write`, `MultiEdit`); everything else (`Bash`, `WebFetch`, MCP) still prompts. The exam tests this distinction.

### `setting_sources` / `settingSources` `[CC]`
Controls which on-disk config tiers the Agent SDK loads — a subset of `['user', 'project', 'local']`. **The catch most candidates miss:** the SDK does NOT load filesystem config by default. CLAUDE.md, MCP server registrations, slash commands, hooks, output styles are all ignored unless `settingSources` explicitly opts in. The Claude Code CLI loads everything by default; the SDK inverts that for programmatic safety.

---

## 2. MCP

### In-process MCP servers `[MCP]`
`createSdkMcpServer({ name, version, tools })` from the Agent SDK — tool handlers run inside the host Node process, no subprocess, no JSON-RPC over stdio. Tools appear to the model namespaced as `mcp__<server>__<tool>`. Only tools, not resources.

The whole trick in this project's `buildNotesServer()`: tool handlers **close over** the `notes: Note[]` array passed in. Mutations from any handler are visible to every handler that closes over the same array — the entire coordination layer between parallel searchers and the synthesiser.

### MCP-per-query re-entrancy `[MCP][REL]`
**The bug we hit:** the underlying `McpServer` instance isn't re-entrant across concurrent connections. Sharing one server across 5 parallel `query()` calls left only the first searcher with `mcp__notes__save_note`; the rest ran toolless. **Fix:** build a fresh `notesServer` inside `runAgent`, all servers closing over the *same* `notes` array. Restores tool access everywhere while preserving the shared writeboard.

This is the kind of architectural detail the exam likes — "what's wrong with the following config" questions.

### Tool gating as governance `[MCP][PROMPT]`
The `AgentDefinition.tools` allowlist is the safety boundary when `permissionMode` is `bypassPermissions`. Encode role asymmetries in tools:
- Searchers: `["WebSearch", "mcp__notes__save_note"]` — can search + write, cannot read.
- Synthesiser: `["mcp__notes__recent_notes"]` — read-only, no web, no mutation.

That asymmetry is governance baked into config, not code.

### Transports — when to pick each `[MCP]`
| Transport | Where it runs | When to pick |
| --- | --- | --- |
| **stdio** | Subprocess on user's machine | Local tools, full filesystem access, no network. Auth via env vars. |
| **HTTP / SSE** | Remote server, network-reachable | Multi-user / SaaS integrations. Auth via OAuth (see authz section). |
| **In-process (SDK)** | Same process as the Agent SDK | Tightly-coupled tools, low-latency, shared in-memory state. Tools only (no resources). |

### MCP authorization spec (composition of 5 RFCs) `[MCP]`
Memorize the role of each. Full synthesis in [`docs/mcp-auth-sampling.md`](mcp-auth-sampling.md).

| RFC | Role |
| --- | --- |
| OAuth 2.1 (draft) | Base framework — authorisation code + PKCE only. No implicit, no password grant. |
| **RFC 9728** Protected Resource Metadata | Server MUST advertise its AS at `/.well-known/oauth-protected-resource`. |
| **RFC 8414** AS Metadata | AS MUST publish endpoints at `/.well-known/oauth-authorization-server`. Client MUST consume. |
| **RFC 7591** Dynamic Client Registration | Client + AS SHOULD support so clients can register without prior coordination. |
| **RFC 8707** Resource Indicators | Client MUST send `resource=<canonical-server-uri>` on both authorize and token requests. Audience-binds the token. |

Discovery order: **401 → resource metadata (9728) → AS metadata (8414) → optional DCR (7591) → authorize+token with PKCE *and* `resource=` (8707) → bearer token**.

### MCP sampling primitive `[MCP]`
Inverts the direction: **server requests an LLM completion from the client**. Method `sampling/createMessage`. Client MUST declare `capabilities.sampling: {}` at init. Server suggests model via `hints` + `costPriority`/`speedPriority`/`intelligencePriority` (advisory — client picks the actual model). Human-in-the-loop is the security model: user SHOULD approve the prompt and the response before either crosses the wire.

Use sampling when the server wants to "think" without shipping its own API key. Use tool calls when you want a deterministic named capability.

---

## 3. Hooks

### The 9 canonical hook events `[CC]`
PascalCase, no separators. **The exam tests exact spellings.**

| # | Event | When it fires |
| --- | --- | --- |
| 1 | `PreToolUse` | Before a tool call — the only event that can block (`permissionDecision: deny`) |
| 2 | `PostToolUse` | After a successful tool call — observability only, can't undo |
| 3 | `UserPromptSubmit` | User just submitted a prompt, before Claude sees it |
| 4 | `Notification` | Claude Code is about to show a desktop notification |
| 5 | `Stop` | Main-thread turn ended |
| 6 | `SubagentStop` | A delegated subagent finished |
| 7 | `PreCompact` | Before context compaction |
| 8 | `SessionStart` | Session begins or resumes |
| 9 | `SessionEnd` | Session terminates |

**Traps:** `PreToolUse` / `PostToolUse` is singular "Use" (no "s"). `Stop` ≠ `SubagentStop`. `Notification` is Claude Code's notifications, not push notifications. `UserPromptSubmit` runs *before* Claude sees the prompt — that's the right place to screen for prompt injection on user input.

### Beyond the canonical 9
The Agent SDK ships ~30 hook events total (`SubagentStart`, `PostToolUseFailure`, `PostToolBatch`, `Elicitation`, `ElicitationResult`, `InstructionsLoaded`, `ConfigChange`, `CwdChanged`, `FileChanged`, `WorktreeCreate`, `TaskCreated`, `TaskCompleted`, etc.). Don't be surprised when you grep `node_modules/@anthropic-ai/claude-agent-sdk`. The 9 above are the canonical/historical set the exam tests on.

### Hook script protocol `[CC][REL]`
A hook script reads a JSON event blob on stdin. Two ways to signal block:
- **Exit code 2** + stderr-as-reason → coarse block, message goes to user.
- **Exit code 0 + JSON stdout** with `hookSpecificOutput.permissionDecision: "deny"` + `permissionDecisionReason` → readable reason, fed back to the model. *This is what `block-rm-rf.sh` does.*

`PreToolUse` decisions: `allow` | `deny` | `ask` | `defer`. The reason in `permissionDecisionReason` is what enables graceful recovery — the model reads it and retries (e.g. our PII hook → agent redacts to `[REDACTED]` and retries).

### Hooks in this project
- **PII PreToolUse** (`_lib.ts`) — blocks tool calls with email/SSN in args; agent recovers by redacting.
- **Audit PostToolUse** (`_lib.ts`) — appends every `WebSearch` to `audit.jsonl` (observability only).
- **`rm -rf` PreToolUse** (`.claude/hooks/block-rm-rf.sh`) — denies destructive Bash. Tested against 9 input patterns including `sudo`, `/bin/rm`, split flags.

---

## 4. Claude Code configuration

### CLAUDE.md load order `[CC]`
Four tiers, broadest → most specific. **Files concatenate, they don't override.**

| # | Tier | Location |
| --- | --- | --- |
| 1 | **Managed policy** (org-wide) | macOS `/Library/Application Support/ClaudeCode/CLAUDE.md` · Linux/WSL `/etc/claude-code/CLAUDE.md` · Windows `C:\Program Files\ClaudeCode\CLAUDE.md` |
| 2 | **User** | `~/.claude/CLAUDE.md` |
| 3 | **Project** | `./CLAUDE.md` or `./.claude/CLAUDE.md` |
| 4 | **Local** (gitignored) | `./CLAUDE.local.md` |

Within a project, Claude Code walks up the directory tree from CWD and loads every `CLAUDE.md` + `CLAUDE.local.md`. Order: filesystem-root-down to CWD — files closer to where you launched are read LAST (most-specific-by-recency).

**`@import` is a syntax, not a tier.** `@path/to/file.md` inside any CLAUDE.md pulls in another file. Max 4 hops deep. Relative paths resolve relative to the file containing the import.

**Trap:** the plan's note ("enterprise → project → user → import") swaps user and project, and conflates @import with the precedence chain. The canonical order is **managed → user → project → local**, with @import being a mechanism inside any of them.

### `.claude/` folder layout `[CC]`
Project-level Claude Code config — all artifacts are markdown or JSON, all committable.

```
.claude/
├── settings.json           # hooks, env, permissions, ...
├── settings.local.json     # per-machine overrides (gitignore)
├── commands/<name>.md      # /<name> slash commands
├── agents/<name>.md        # on-disk sub-agents
├── hooks/<script>.sh       # hook scripts referenced from settings.json
└── output-styles/<name>.md # /config-selectable response styles
```

### Slash commands `[CC]`
Frontmatter: `description`, `argument-hint`, `allowed-tools`, optional `model`. Body is the prompt template.

- `$ARGUMENTS` placeholder injects the user's text after the command name.
- `` !`<shell>` `` inline (backtick-wrapped, `!` prefix) runs a shell command and injects its output into the prompt. Used heavily in `explain-diff.md` to pull `git status`, `git diff --cached`, `git diff` into context.

### Settings tier precedence `[CC]`
For `settings.json` (separate from CLAUDE.md), the same managed → user → project → local cascade applies. Managed policy CLAUDE.md cannot be excluded by individual settings. `claudeMdExcludes` (in any non-managed tier) skips specific CLAUDE.md files by glob — useful in monorepos.

### Output styles `[CC]`
`.claude/output-styles/<name>.md` with frontmatter `name`, `description`, optional `keep-coding-instructions`. Body becomes appended to the system prompt. Activated via `/config` → Output Style menu (applies after `/clear`).

---

## 5. Plugins & marketplaces

### Plugin layout `[CC]`
```
plugins/<plugin-name>/
├── .claude-plugin/
│   └── plugin.json           # name, description, version, author
├── commands/                 # at plugin ROOT, NOT inside .claude-plugin/
├── agents/
└── hooks/
    ├── hooks.json            # same shape as settings.json's "hooks" block
    └── <script>.sh           # referenced via ${PLUGIN_DIR}/hooks/<script>.sh
```

**Trap that bit me:** `commands/`, `agents/`, `hooks/` go at the **plugin root**, not inside `.claude-plugin/`. The `.claude-plugin/` folder only holds `plugin.json`.

**Other trap:** hook config in a plugin uses `hooks/hooks.json` (separate file), not a `settings.json`. Paths use `${PLUGIN_DIR}` instead of `${CLAUDE_PROJECT_DIR}`.

### Marketplace layout `[CC]`
```
marketplaces/<name>/
├── .claude-plugin/
│   └── marketplace.json      # lists plugins by source (local path / GitHub / git URL)
├── plugins/<plugin>/...
```

`marketplace.json` shape:
```json
{
  "name": "...", "description": "...", "version": "0.1.0",
  "plugins": [
    { "name": "...", "description": "...", "source": "./plugins/<plugin>" }
  ]
}
```

### Install flow `[CC]`
```
/plugin marketplace add ./marketplaces/<name>     # register
/plugin install <plugin>@<marketplace>            # install (note the @ scope)
/plugin                                           # open manager, verify installed
```

Plugin-namespaced artifacts (e.g. `/cca-toolkit:explain-diff`) take precedence over project `.claude/` artifacts with the same name.

---

## 6. Prompt engineering & structured output

### Extended thinking `[PROMPT]`
Available on Sonnet 4.5+ and Opus. Enabled via `thinking: { type: "enabled", budget_tokens: N }` on `messages.create`. **`max_tokens` MUST exceed `budget_tokens`** — API hard requirement. Response has two content-block types:
- `thinking` — the model's reasoning, surfaced to the UI as a `ReasoningUIPart` / `<details>`.
- `text` — the actual answer.

Used in `makePlan` to surface the planner's decomposition reasoning.

### Structured JSON output `[PROMPT]`
Two patterns in this project:
1. **Lightweight** (`makePlan`) — JSON-only system prompt + regex extract first `{…}` + `JSON.parse` + validate shape. Cheap, works for short answers.
2. **Canonical** — force JSON through a tool with `tool_choice: { type: "tool", name: "<name>" }`. The model can only emit a tool call matching that schema. Stricter, exam-recommended.

### `tool_choice` values `[PROMPT]`
| Value | Behavior |
| --- | --- |
| `auto` (default) | Model decides whether to use any tool |
| `any` | Model MUST use one of the tools (its choice which) |
| `tool` | Model MUST call the named tool (used for forced structured output) |
| `none` | Model cannot use tools this turn |

Plus `disable_parallel_tool_use: true` to force one tool call per turn (default is parallel allowed).

### Prompt-injection mitigations — Anthropic's 5 named techniques `[PROMPT]`
From the [strengthen-guardrails docs](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks):
1. **Harmlessness screens** — Haiku-class classifier pre-screens user input, structured boolean output.
2. **Input validation** — filter prompts (or here, tool args) for jailbreak / sensitive patterns. **Our PII hook is this technique applied egress-side.**
3. **Prompt engineering** — bake ethical/legal boundaries into the system prompt.
4. **Continuous monitoring** — analyse outputs over time, iterate prompts + validation. **Our audit hook captures the signal for this.**
5. **Chain safeguards** — combine the above. Defense in depth.

### Acceptable Use Policy (AUP) — PII clause `[PROMPT]`
Operators must not let systems "Misuse, collect, solicit, or gain access without permission to private information" including "non-public contact details, health data, biometric or neural data". Our PII hook supports this requirement.

**AUP gotcha:** the AUP does NOT require operators to keep audit logs. That's an Anthropic Safeguards Team obligation, not an operator obligation. The audit recommendation lives in the prompt-injection guidance under "Continuous monitoring".

---

## 7. Streaming UI (Vercel AI SDK v6)

### Package surface `[ARCH]`
- **`ai`** — server primitives: `streamText`, `createUIMessageStream`, `createUIMessageStreamResponse`, `UIMessage`, `UIMessageStreamWriter`, type helpers (`isTextUIPart`, `isStaticToolUIPart`, `isReasoningUIPart`, `getToolName`).
- **`@ai-sdk/react`** — React hooks: `useChat` (lives here in v5+, NOT in `ai/react` like older versions).
- **`@ai-sdk/anthropic`** — provider adapter.

### `useChat` + `DefaultChatTransport`
```tsx
const { messages, sendMessage, status, error, stop } = useChat({
  transport: new DefaultChatTransport({ api: "/api/research/chat" }),
});
```
Transport-driven design: the React hook is decoupled from the endpoint's protocol via the `transport` object.

### UIMessage parts
Three part types this project emits — each rendered by filtering `message.parts`:
| Part type | Helper | Purpose here |
| --- | --- | --- |
| `text` | `isTextUIPart` | Final assistant answer (the report) |
| `tool-<name>` (static) | `isStaticToolUIPart` | Per-stage trace pills (plan / search / synthesize) |
| `reasoning` | `isReasoningUIPart` | Planner's extended thinking in a `<details>` |

Tool parts carry a `state`: `input-streaming` → `input-available` → `output-available` | `output-error`. The UI maps state to a pill colour — no client-side state machine needed.

### Synthetic tool-call lifecycle for sub-agent traces
The chat endpoint emits a fake tool-call per pipeline stage:
- `tool-input-start` + `tool-input-available` when stage begins → pill says "running"
- `tool-output-available` when stage completes → pill says "done"
- `tool-output-error` on failure → pill says "failed"

That's the entire "show live progress" pattern — no custom protocol, just standard UIMessage chunks the SDK already understands.

---

## 8. Reliability

### Bounded retry + backoff `[REL]`
`runAgent` wraps a single attempt in a retry loop (default 2 retries, 1s/2s backoff). Sub-agent failures under load (parallel WebSearch + concurrent API) are common; retry recovers most of them.

**Known flaw in this implementation:** the retry retries any thrown error, including permanent 4xx (e.g. credit-balance 400). A correct retry classifies — retry transient 429 / 529 / 5xx, fail fast on 400 / 401 / 403. Listed in the README's production-additions section.

### Failure shape diagnosis `[REL]`
When debugging eval results, distinguish:
- `passed:false` with non-empty `fails: [...]` → **criteria miss**. Fix = tune the prompt.
- `passed:false` with non-null `error: "..."` → **infra failure**. Fix = env / credits / retry policy.

Same score in the eval, opposite fixes. This is the most-missed-in-practice judgement the iterate loop teaches.

### Empty-notes guard `[REL]`
After fan-out, if `notes.length === 0` (every searcher rejected), short-circuit with 502 before invoking the synthesiser. Don't ask the synth to write from nothing.

### Promise.allSettled vs Promise.all `[REL]`
`Promise.all` short-circuits on first rejection — bad for parallel sub-agents (one searcher dying kills the whole research). `Promise.allSettled` waits for every promise and reports all outcomes. **Always reach for `allSettled` in fan-out patterns.**

---

## 9. Evaluation

### LLM-as-judge pattern `[REL][PROMPT]`
A cheap Haiku call grades a generated output against a list of criteria, returning per-criterion pass/fail. Used in `/api/research/eval`. Cheaper + more flexible than rule-based eval; covers semantic criteria ("covers BOTH X and Y") that regex can't.

### Eval set design `[REL]`
`evals/research-evals.json` — 5 diverse items, each with:
- `query` — the input
- `criteria` — content-specific assertions (e.g. "covers BOTH Pinecone and Weaviate")
- Plus `shared_criteria` at the top applied to every item (structure: exec summary, ≥3 headings, ≥3 inline citations, Sources section, ~400-1200 words)

Item passes iff every criterion (shared + item) passes. Threshold: ≥4/5 items pass.

### The iterate loop
1. Run full set → score.
2. For each `passed:false`, read the **shape** (criteria miss vs infra fail).
3. Tune the appropriate knob (prompt for criteria; profile / retry / env for infra).
4. Re-run **failed ids only** (`{"ids":[...]}`) — cost discipline.
5. Stop at threshold. Don't chase 5/5 when 4/5 is the goal.

---

## 10. Models + profiles

### Model aliases the Agent SDK accepts `[ARCH][REL]`
- `sonnet` — current Sonnet
- `opus` — current Opus
- `haiku` — current Haiku
- Plus full model IDs like `claude-haiku-4-5-20251001` (required by the raw Messages API for the planner and the citation-bearing synth)

The `resolveModelAlias` helper in `_lib.ts` maps each alias to its full ID so the raw SDK calls work regardless of which one the profile picks.

### Cheapest-model-that-meets-the-bar `[ARCH]`
The exam's canonical model-selection rule. Don't default to Opus — pick the cheapest model that still passes your quality bar for that role.

**In this project as currently configured**, both `PROD_PROFILE` and `FAST_PROFILE` default to **Haiku across every role** — affordability won the tradeoff for the prep work. The profile architecture still supports per-stage selection; flipping any role to Sonnet or Opus is a one-line change.

The principled split (worth knowing for the exam scenario questions) would be:
- **Plan step** — Sonnet + extended thinking when the decomposition quality matters (pay for it once per request).
- **Searchers** — Sonnet when WebSearch reasoning + multi-step note-taking is the bottleneck; Haiku when speed/cost dominates.
- **Synthesiser** — Opus when the report is the customer-facing artefact and prose quality matters; Haiku when the report is internal.

The split that's *not* principled: defaulting everything to Opus. The exam tests for noticing when a cheaper model would have done the job.

### One-paragraph cheat sheet — when I'd pick each `[ARCH]`

**Pick Haiku 4.5** ($1/$5 per MTok, 200K context, fastest) for high-volume or latency-sensitive work where intelligence isn't the bottleneck: classification, simple tool dispatch, eval judges, sub-agents you can fan out, anything routine you'd run at scale. **Pick Sonnet 4.6** ($3/$15, 1M context) as the *default* for general-purpose agentic work — best balance of reasoning and speed; coding agents, computer-use traces, anything where Opus would be overkill but Haiku might miss a subtle inference. **Pick Opus 4.7** ($5/$25, 1M context, adaptive thinking only) when intelligence is the bottleneck and pays back its 5× input / 5× output premium: long-horizon agentic loops where compounding context decisions matter, frontier coding that needs the model to think before acting, vision-heavy workloads (Opus 4.7 introduced high-res image input — long-edge up to 2576px), and the final-stage synthesizer in a multi-agent pipeline where prose quality is the customer-visible artefact. **Layer the Batches API** (`POST /v1/messages/batches`) on top of any of the three for **50% off all tokens** when latency doesn't matter — async, results within 24h, all features supported (vision, tools, prompt caching) — so bulk classification, overnight eval runs, retroactive labelling, anything non-interactive should go through it. The exam-canonical rule of thumb is *"cheapest model that meets the bar"*: Opus is the deliberate upgrade for the one stage where the premium pays for itself (project-1's synthesizer in PROD_PROFILE, for example), not the everywhere default — project-2 sits on Haiku for the whole loop because triage doesn't need more, and the Day-12 retry wrapper's Sonnet → Haiku chain is the same idea applied to fault tolerance.

### Cost/quality profiles `[ARCH]`
Encoded as `ResearchProfile` in `_types.ts`:
```ts
type ResearchProfile = {
  planModel: string;
  planThinkingBudget: number;  // 0 disables thinking
  searchModel: string;
  synthModel: string;
  searcherMaxTurns?: number;
  maxSubQueries?: number;
};
```
`PROD_PROFILE` vs `FAST_PROFILE` ride through the same `runResearch` function — one orchestrator, swappable model strategy.

---

## Exam-domain heatmap

How this project's concepts split across the 5 exam domains:

| Section | Primary domain | Notes |
| --- | --- | --- |
| 1. Agentic architecture | `[ARCH]` 27% | The big one. Workflow patterns + orchestrator-workers + sub-agents are heavy here. |
| 2. MCP | `[MCP]` 18% | In-process, transports, the 5-RFC auth spec, sampling. |
| 3. Hooks | `[CC]` 20% | The 9 names get tested on exact spelling. Pre vs Post distinction. |
| 4. Claude Code configuration | `[CC]` 20% | CLAUDE.md hierarchy, `.claude/` layout, slash commands. |
| 5. Plugins & marketplaces | `[CC]` 20% | Newer surface; easy multiple-choice marks. |
| 6. Prompt engineering | `[PROMPT]` 20% | Extended thinking, `tool_choice`, 5 mitigations, AUP. |
| 7. Streaming UI | spans `[ARCH]` + `[PROMPT]` | AI SDK is application-level, less directly tested but framework knowledge matters. |
| 8. Reliability | `[REL]` 15% | Retry + backoff, failure isolation, failure shape diagnosis. |
| 9. Evaluation | `[REL]` + `[PROMPT]` | LLM-as-judge, iterate loop. Reliability + prompt eng intersection. |
| 10. Models + profiles | `[ARCH]` + `[REL]` | "Cheapest model that meets the bar" is a frequent question type. |
