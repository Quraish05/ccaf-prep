# Research Orchestrator (`/api/research`)

> Branch: `feat/project-1-research` · Last updated: 2026-05-26

## Overview

A `POST` endpoint that turns a research question into a written report via a three-stage orchestrator-worker pipeline: a **planner** generates 3–5 sub-queries, one **searcher** sub-agent per sub-query runs in parallel using `WebSearch` and an in-process `notes` MCP server, and a final **synthesizer** sub-agent writes the report from the gathered notes.

The pattern matches the *orchestrator-workers* workflow from Anthropic's [Building effective agents](https://www.anthropic.com/research/building-effective-agents) post — one of the canonical multi-agent patterns the CCA-F exam tests.

## What changed

- `app/api/research/route.ts` — the orchestrator route handler: planner, sub-agent harness, and `POST` flow.
- `tsconfig.json` — excludes `_legacy/` from typecheck so the prior standalone scripts don't bleed into Next.js compilation.

## Code flow

A `POST /api/research` with `{ "query": "..." }`:

1. **Parse + validate** (`app/api/research/route.ts:151`). Body must be JSON with a non-empty `query` string. Anything else returns `400`.

2. **Build the notes store** (`app/api/research/route.ts:159`). A per-request `notes: Note[]` array is created and closed over by `buildNotesServer`. Two MCP tools are exposed: `save_note` (write) and `recent_notes` (read). The closure is the trick — every sub-agent that receives this server instance reads and writes the *same* JS array reference in the Node process. No DB, no filesystem, no Redis.

3. **Plan** (`makePlan`, `app/api/research/route.ts:68`). Calls `@anthropic-ai/sdk` directly (not the Agent SDK) with Sonnet 4.6 and a JSON-only system prompt. Extracts the first `{…}` from the response, parses it, validates that `sub_queries` is a 3–5 element array. Throws if malformed.

   *Why raw SDK here, not the Agent SDK?* This is a single short LLM call with no tools and no loop. Spawning a Claude Code CLI subprocess (which the Agent SDK does on every `query()`) is unnecessary overhead.

4. **Fan-out searchers** (`app/api/research/route.ts:162`). `Promise.allSettled` over the sub-queries, each calling `runAgent(prompt, SEARCHER_AGENT, notesServer)`. Each searcher:
   - Has only `WebSearch` and `mcp__notes__save_note` in its tool allowlist.
   - Cannot read notes other searchers have written — isolated per sub-query.
   - Runs as its own Claude Code CLI subprocess (one per searcher).
   - On rate-limit or `WebSearch` failure, the individual promise rejects; `allSettled` keeps the others alive so the synthesizer still has something to work from.

5. **Synthesize** (`app/api/research/route.ts:181`). One final `runAgent` call with `SYNTHESIZER_AGENT`. The synthesizer can only call `mcp__notes__recent_notes` — read-only on the shared store. It builds the report from whatever notes survived the searcher round.

6. **Return** (`app/api/research/route.ts:189`). JSON containing the original query, the sub-queries used, per-searcher status + summary, the raw notes, and the final synthesized report.

### The agent harness — `runAgent` (`app/api/research/route.ts:126`)

Every sub-agent run uses the same harness:

```ts
const stream = query({
  prompt,
  options: {
    mcpServers: { notes: notesServer },
    agents: { _main: agent },
    agent: "_main",
    tools: ["WebSearch"],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
  },
});
```

Three things to notice:

- `agents` + `agent: "_main"` — uses the *agent-as-main-thread* pattern. The agent definition's system prompt replaces Claude Code's default main-thread prompt; without these the call would still run but you'd lose per-role prompting and tool gating.
- `permissionMode: "bypassPermissions"` — there's no human at the loop to approve tool calls server-side. The real safety boundary is the `AgentDefinition.tools` allowlist (e.g. the synthesizer literally cannot call `WebSearch` because it isn't in the agent's allowed set).
- Result extraction iterates the message stream and returns the `type: "result", subtype: "success"` message's `result` field. Throws on the `error` subtype.

## Flowchart

```mermaid
flowchart TD
  client[Client POST /api/research]
  plan[Planner<br/>raw Anthropic SDK<br/>Sonnet · JSON only]
  s1[Searcher 1<br/>Sonnet · WebSearch + save_note]
  s2[Searcher 2<br/>Sonnet · WebSearch + save_note]
  sN[Searcher N<br/>Sonnet · WebSearch + save_note]
  notes[(notes: Note[]<br/>in-process MCP store)]
  synth[Synthesizer<br/>Opus · recent_notes only]
  resp[JSON response<br/>query, sub_queries, notes, report]

  client --> plan
  plan -->|3-5 sub-queries| s1
  plan --> s2
  plan --> sN
  s1 -->|save_note| notes
  s2 -->|save_note| notes
  sN -->|save_note| notes
  notes -->|recent_notes| synth
  synth --> resp
```

## Glossary

- **Orchestrator-worker** — Multi-agent workflow pattern from *Building effective agents* where a central agent decomposes a task and dispatches subtasks to specialized workers in parallel. Contrasts with single-agent-with-tools (one loop, one model) and with simple *routing* (one input chooses one of N agents, not all of them).
- **Sub-agent** — In the Claude Agent SDK, an `AgentDefinition` that runs as its own conversation with its own system prompt, tool allowlist, and model. Invokable as the main thread (this code) or via the Task tool from a parent agent.
- **In-process MCP server** — An MCP server created with `createSdkMcpServer` whose tool handlers run inside the host Node.js process — no subprocess, no JSON-RPC over stdio. Tools appear to the model under the `mcp__<server>__<tool>` namespace. Cheap to call, but does not support MCP *resources* (only tools).
- **Tool gating** — Restricting which tools an agent can call via the `AgentDefinition.tools` array. Acts as the safety boundary when `permissionMode` is set to `bypassPermissions`.
- **`permissionMode: "bypassPermissions"`** — Skips all interactive tool-permission prompts. Required for server-side automation. Must be paired with `allowDangerouslySkipPermissions: true` as an explicit acknowledgement.
- **`Promise.allSettled`** — JavaScript primitive that waits for every promise to either fulfill or reject and reports all outcomes (unlike `Promise.all`, which short-circuits on the first rejection). Used here so one searcher's failure does not kill the whole research run.

## API reference

| Symbol | File | Purpose |
| --- | --- | --- |
| `POST` | `app/api/research/route.ts:151` | Orchestrator entry point. Validates input, runs plan → fan-out → synthesize, returns JSON. |
| `makePlan(userQuery)` | `app/api/research/route.ts:68` | Calls Sonnet via the raw Anthropic SDK and returns a validated 3–5 element `string[]` of sub-queries. |
| `buildNotesServer(notes)` | `app/api/research/route.ts:22` | Builds a fresh in-process MCP server with two tools (`save_note`, `recent_notes`) closed over the given `notes` array. |
| `runAgent(prompt, agent, notesServer)` | `app/api/research/route.ts:126` | Runs one `query()` with the given `AgentDefinition` as the main thread, returns the final result string. |
| `SEARCHER_AGENT` | `app/api/research/route.ts:95` | `AgentDefinition` for the per-sub-query searcher. Tools: `WebSearch`, `mcp__notes__save_note`. Model: `sonnet`. |
| `SYNTHESIZER_AGENT` | `app/api/research/route.ts:111` | `AgentDefinition` for the final report writer. Tools: `mcp__notes__recent_notes`. Model: `opus`. |

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
