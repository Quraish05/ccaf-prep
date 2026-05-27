# Research Orchestrator (`/api/research`)

> Branch: `feat/project-1-research` · Last updated: 2026-05-27

## Overview

A `POST` endpoint that turns a research question into a written report via a three-stage orchestrator-worker pipeline: a **planner** (with extended thinking) generates 3–5 sub-queries, one **searcher** sub-agent per sub-query runs in parallel using `WebSearch` and an in-process `notes` MCP server, and a final **synthesizer** sub-agent writes the report from the gathered notes. The report is saved to disk as a `.md` file and returned in the response. A **PreToolUse hook** blocks any tool call whose arguments contain PII (email / SSN), and the agent recovers by redacting and retrying.

The pattern matches the *orchestrator-workers* workflow from Anthropic's [Building effective agents](https://www.anthropic.com/research/building-effective-agents) post — one of the canonical multi-agent patterns the CCA-F exam tests.

## What changed

- `app/api/research/route.ts` — the orchestrator: `makePlan` (extended thinking), agent definitions, `saveReport`, and the `POST` flow.
- `app/api/research/_lib.ts` — shared, non-routable helpers: the `Note` type, `buildNotesServer`, the PII detector + hook (`findPii`, `buildPiiHook`), and the `runAgent` sub-agent harness.
- `app/api/research/test-pii/route.ts` — verification route that drives a single sub-agent into a PII block and checks it recovers.
- `app/page.tsx` — minimal client UI: query form, collapsed extended-thinking `<details>`, searcher status pills, report view.
- `.gitignore` — ignores generated `reports/`.
- `tsconfig.json` — excludes `_legacy/` from typecheck so the prior standalone scripts don't bleed into Next.js compilation.

## Code flow

A `POST /api/research` with `{ "query": "..." }`:

1. **Parse + validate** (`app/api/research/route.ts:115`). Body must be JSON with a non-empty `query` string. Anything else returns `400`.

2. **Build the notes store** (`app/api/research/route.ts:130`). A per-request `notes: Note[]` array is created. Note: only the *array* is created here — the in-process MCP server is built per `query()` call inside `runAgent` (see the MCP-per-query note below). The array is the shared writeboard; every sub-agent reads/writes the *same* JS array reference in the Node process. No DB, no filesystem, no Redis.

3. **Plan with extended thinking** (`makePlan`, `app/api/research/route.ts:13`). Calls `@anthropic-ai/sdk` directly (not the Agent SDK) with Sonnet 4.6, `thinking: { type: "enabled", budget_tokens: 4000 }`, and a JSON-only system prompt. `max_tokens` is set above the thinking budget (API constraint). Returns `{ subQueries, thinking }` — the `thinking` blocks are surfaced to the UI as a collapsed `<details>`. Extracts the first `{…}` from the text output, validates `sub_queries` is a 3–5 element array, throws if malformed.

   *Why raw SDK here, not the Agent SDK?* This is a single short LLM call with no tools and no loop. Spawning a Claude Code CLI subprocess (which the Agent SDK does on every `query()`) is unnecessary overhead.

4. **Fan-out searchers** (`app/api/research/route.ts:135`). `Promise.allSettled` over the sub-queries, each calling `runAgent(prompt, SEARCHER_AGENT, notes)`. Each searcher:
   - Has only `WebSearch` and `mcp__notes__save_note` in its tool allowlist.
   - Cannot read notes other searchers have written — isolated per sub-query.
   - Runs as its own Claude Code CLI subprocess (one per searcher).
   - On rate-limit or `WebSearch` failure, the individual promise rejects; `allSettled` keeps the others alive so the synthesizer still has something to work from.
   - Every tool call passes through the **PII guard** first (see below).

5. **Empty-notes guard** (`app/api/research/route.ts:166`). If every searcher failed and `notes` is empty, short-circuit with `502` instead of asking the synthesizer to write from nothing.

6. **Synthesize** (`app/api/research/route.ts:186`). One final `runAgent` call with `SYNTHESIZER_AGENT`. The synthesizer can only call `mcp__notes__recent_notes` — read-only on the shared store. It builds the ~1-page report from whatever notes survived the searcher round.

7. **Save report** (`app/api/research/route.ts:189`). `saveReport` writes a metadata header + the report to `reports/<timestamp>-<slug>.md` and returns the path.

8. **Return** (`app/api/research/route.ts:191`). JSON with the query, sub-queries, `plan_thinking`, per-searcher summaries (each with its `blocks`), the raw notes, the report, the `report_path`, and aggregated `pii_blocks`.

### The agent harness — `runAgent` (`app/api/research/_lib.ts:132`)

Lives in `_lib.ts` so both the orchestrator and the `test-pii` route share it. Signature is `runAgent(prompt, agent, notes): Promise<{ text, blocks }>`.

```ts
const notesServer = buildNotesServer(notes); // fresh server per call
const blocks: PiiBlock[] = [];
const piiHook = buildPiiHook(blocks);        // closes over `blocks`

const stream = query({
  prompt,
  options: {
    mcpServers: { notes: notesServer },
    agents: { _main: agent },
    agent: "_main",
    tools: ["WebSearch"],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    hooks: { PreToolUse: [{ hooks: [piiHook] }] },
  },
});
```

Things to notice:

- **MCP-per-query fix.** The server is built *inside* `runAgent`, not once and shared. The underlying `McpServer` instance isn't re-entrant across concurrent connections — when one server was shared across 5 parallel `query()` calls, only the first searcher got the `notes` tools and the rest ran toolless. Building a fresh server per call (all closing over the same `notes` array) fixes it while preserving the shared-writeboard semantics.
- `agents` + `agent: "_main"` — the *agent-as-main-thread* pattern. The agent definition's system prompt replaces Claude Code's default; without these you'd lose per-role prompting and tool gating.
- `permissionMode: "bypassPermissions"` — no human at the loop server-side. The real safety boundary is the `AgentDefinition.tools` allowlist plus the PII hook.
- **PII hook** (`PreToolUse`) — `buildPiiHook(blocks)` returns a `HookCallback` that scans `tool_input` for email/SSN patterns and returns `permissionDecision: "deny"` with a redaction hint. The denied calls are pushed into the closed-over `blocks` array so callers can observe them without parsing SDK message internals.
- Result extraction iterates the message stream and returns `{ text: result, blocks }` on the `success` result message. Throws on the `error` subtype.

## Flowchart

```mermaid
flowchart TD
  client[Client POST /api/research]
  plan[Planner<br/>raw Anthropic SDK<br/>Sonnet · extended thinking 4k]
  s1[Searcher 1<br/>Sonnet · WebSearch + save_note]
  s2[Searcher 2<br/>Sonnet · WebSearch + save_note]
  sN[Searcher N<br/>Sonnet · WebSearch + save_note]
  guard{PII guard<br/>PreToolUse hook}
  notes[(notes: Note[]<br/>shared writeboard)]
  synth[Synthesizer<br/>Opus · recent_notes only]
  save[saveReport → reports/*.md]
  resp[JSON response<br/>+ plan_thinking + pii_blocks]

  client --> plan
  plan -->|3-5 sub-queries| s1
  plan --> s2
  plan --> sN
  s1 --> guard
  s2 --> guard
  sN --> guard
  guard -->|allowed save_note| notes
  guard -.->|deny on PII → agent redacts + retries| s1
  notes -->|recent_notes| synth
  synth --> save
  save --> resp
```

## Glossary

- **Orchestrator-worker** — Multi-agent workflow pattern from *Building effective agents* where a central agent decomposes a task and dispatches subtasks to specialized workers in parallel. Contrasts with single-agent-with-tools (one loop, one model) and with simple *routing* (one input chooses one of N agents, not all of them).
- **Sub-agent** — In the Claude Agent SDK, an `AgentDefinition` that runs as its own conversation with its own system prompt, tool allowlist, and model. Invokable as the main thread (this code) or via the Task tool from a parent agent.
- **In-process MCP server** — An MCP server created with `createSdkMcpServer` whose tool handlers run inside the host Node.js process — no subprocess, no JSON-RPC over stdio. Tools appear to the model under the `mcp__<server>__<tool>` namespace. Cheap to call, but does not support MCP *resources* (only tools). Not re-entrant across concurrent `query()` connections — build one per call.
- **Extended thinking** — A model capability (Sonnet 4.5+/Opus) that produces internal reasoning `thinking` content blocks before the final answer, controlled by `thinking: { type: "enabled", budget_tokens: N }`. `max_tokens` must exceed `budget_tokens`. Used on the planner so the sub-query decomposition reasoning is visible.
- **PreToolUse hook** — A hook that fires *before* a tool executes, receiving `{ tool_name, tool_input, tool_use_id }`. It can allow, deny, or rewrite the call by returning a `permissionDecision`. Here it denies calls carrying PII. (Other Claude Code hook events: PostToolUse, UserPromptSubmit, Notification, Stop, SubagentStop, PreCompact, SessionStart, SessionEnd.)
- **`permissionDecision`** — Field on a PreToolUse hook's `hookSpecificOutput`: `'allow' | 'deny' | 'ask' | 'defer'`. Paired with `permissionDecisionReason`, which is fed back to the model — the reason is what lets the agent recover gracefully (read the deny, redact, retry).
- **Tool gating** — Restricting which tools an agent can call via the `AgentDefinition.tools` array. Acts as a safety boundary alongside the PII hook when `permissionMode` is `bypassPermissions`.
- **`permissionMode: "bypassPermissions"`** — Skips all interactive tool-permission prompts. Required for server-side automation. Must be paired with `allowDangerouslySkipPermissions: true` as an explicit acknowledgement.
- **`Promise.allSettled`** — JavaScript primitive that waits for every promise to either fulfill or reject and reports all outcomes (unlike `Promise.all`, which short-circuits on the first rejection). Used here so one searcher's failure does not kill the whole research run.

## API reference

| Symbol | File | Purpose |
| --- | --- | --- |
| `POST` | `app/api/research/route.ts:115` | Orchestrator entry point. Validates input, plans → fans out → synthesizes → saves, returns JSON. |
| `makePlan(userQuery)` | `app/api/research/route.ts:13` | Sonnet call with extended thinking (`budget_tokens: 4000`); returns `{ subQueries: string[], thinking: string }`. |
| `saveReport(userQuery, report, subQueries)` | `app/api/research/route.ts:92` | Writes the report + metadata header to `reports/<timestamp>-<slug>.md`; returns the path. |
| `SEARCHER_AGENT` | `app/api/research/route.ts:50` | `AgentDefinition` for the per-sub-query searcher. Tools: `WebSearch`, `mcp__notes__save_note`. Model: `sonnet`. |
| `SYNTHESIZER_AGENT` | `app/api/research/route.ts:67` | `AgentDefinition` for the final report writer. Tools: `mcp__notes__recent_notes`. Model: `opus`. |
| `runAgent(prompt, agent, notes)` | `app/api/research/_lib.ts:132` | Runs one `query()` (fresh MCP server + PII hook) and returns `{ text, blocks }`. |
| `buildNotesServer(notes)` | `app/api/research/_lib.ts:19` | Builds a fresh in-process MCP server with `save_note` + `recent_notes` closed over the given `notes` array. |
| `findPii(value)` | `app/api/research/_lib.ts:76` | Recursively scans a value (string / array / object) for email or SSN patterns; returns the matched pattern name or `null`. |
| `buildPiiHook(blocks)` | `app/api/research/_lib.ts:108` | Returns a `PreToolUse` `HookCallback` that denies PII-bearing tool calls and records them into `blocks`. |
| `POST` | `app/api/research/test-pii/route.ts:29` | Verification route: drives one sub-agent into a PII block, asserts the deny fired and a redacted note was saved. |

## Recall check — Day 4

### The 5 workflow patterns from *Building effective agents*

| # | Pattern | One-line use case |
| --- | --- | --- |
| 1 | **Prompt chaining** | Sequential LLM calls where each step's output feeds the next — e.g. draft marketing copy → translate → grammar-check. |
| 2 | **Routing** | A classifier dispatches each input to one of N specialised prompts/agents — e.g. customer-support triage sending to refund / billing / tech sub-agents. |
| 3 | **Parallelisation** | Same task fanned out (sectioning) or same input voted on (voting), results aggregated — e.g. review one diff for security, performance, and style simultaneously. |
| 4 | **Orchestrator-workers** | A central LLM dynamically decomposes the task and dispatches subtasks to workers whose number/shape is decided at runtime — e.g. this `/api/research` route, or multi-file code search where the sub-queries aren't known up front. |
| 5 | **Evaluator-optimiser** | One LLM produces an output, another scores + critiques it in a loop until a quality bar is hit — e.g. iterative translation refinement, or rewriting a response until it passes a rubric. |

(The post also names *augmented LLM* — a single model with tools/memory/retrieval — and *agents* — autonomous loops with environment feedback. Those are framing primitives, not workflow patterns in this list of five.)

### What does `setting_sources` control?

It controls which on-disk configuration tiers the Claude **Agent SDK** loads when starting a session: a subset of `['user', 'project', 'local']` plus implicit managed/policy settings. The catch most candidates miss: **the Agent SDK does not load filesystem config by default**. `CLAUDE.md` files, MCP server registrations, slash commands, hooks, and output styles configured on disk are all ignored unless `settingSources` (camelCased in the TS SDK) explicitly opts in. The Claude Code CLI loads all of them by default; the SDK inverts that for programmatic safety — you pass config explicitly via `Options` instead.

### Practical difference between `bypassPermissions` and `acceptEdits`

| Mode | What it auto-approves | What still prompts |
| --- | --- | --- |
| `acceptEdits` | File-edit tools only (`Edit`, `Write`, `MultiEdit`). | Everything else — `Bash`, `WebFetch`, MCP tools, etc. — still goes through the normal permission flow. |
| `bypassPermissions` | **Every** tool call. No prompts at all. Requires `allowDangerouslySkipPermissions: true` as an explicit acknowledgement. | Nothing. There is no remaining safety prompt; the only gate left is what the agent's `tools` allowlist lets it call in the first place. |

`acceptEdits` is for "let Claude write files freely but ask before running shell commands or hitting the network" — common in interactive coding sessions. `bypassPermissions` is for server-side automation where no human is at the loop (this route's use case); the safety boundary moves entirely to the `AgentDefinition.tools` allowlist.
