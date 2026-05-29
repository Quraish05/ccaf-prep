# Project 1 — Multi-agent research orchestrator

A Next.js + TypeScript demo of the **orchestrator-workers** workflow from Anthropic's *Building effective agents*: a planner decomposes a research question into sub-queries, parallel searcher sub-agents gather facts via `WebSearch` into an in-process MCP notes store, and a synthesizer sub-agent writes a one-page markdown report. Streamed end-to-end into a `useChat` UI with live sub-agent trace pills, the planner's extended-thinking block, and a Download-report button. Built as Project 1 of the CCA-F exam prep, exercising agentic architecture, MCP, hooks, evals, and streaming UI in one repo.

## Screenshot

<!-- Capture localhost:3000 mid-research: trace panel open with mixed running/done pills,
     the amber "Planner's extended thinking" details visible, and the report streaming in.
     Save the PNG at docs/screenshot.png and this placeholder will resolve. -->

![Research Orchestrator UI](docs/screenshot.png)

## Architecture

```mermaid
flowchart LR
  subgraph client["Browser (app/page.tsx)"]
    UI[useChat from @ai-sdk/react<br/>card list, trace pills,<br/>thinking details, download]
  end

  subgraph routes["Next.js API routes"]
    CHAT["/api/research/chat<br/>streaming UIMessage"]
    JSON["/api/research<br/>JSON one-shot"]
    EVAL["/api/research/eval<br/>Haiku judge"]
    DL["/api/research/download"]
    TEST["/api/research/test-pii"]
  end

  subgraph core["Shared core in _lib.ts"]
    PLAN[Planner<br/>raw Anthropic SDK<br/>extended thinking]
    SEARCH[N searchers in parallel<br/>WebSearch + save_note]
    SYNTH[Synthesizer<br/>recent_notes only]
    NOTES[(shared notes array)]
  end

  subgraph hooks["Hooks per runAgent"]
    PII[PreToolUse PII guard]
    AH[PostToolUse audit log]
  end

  REPORTS[(reports dir)]
  AUDIT[(audit.jsonl)]

  UI -->|send| CHAT
  UI -->|GET| DL
  CHAT --> PLAN
  JSON --> PLAN
  EVAL --> PLAN
  TEST --> SEARCH
  PLAN -->|3-5 sub-queries| SEARCH
  SEARCH --> PII
  SEARCH --> AH
  SEARCH --> NOTES
  NOTES --> SYNTH
  SYNTH --> REPORTS
  AH --> AUDIT
  DL --> REPORTS
```

All four request-driven entrypoints (`/api/research/chat`, `/api/research`, `/api/research/eval`, `/api/research/test-pii`) share the same `runResearch()` function in `app/api/research/_lib.ts`. The only differences between them are the **profile** (`PROD_PROFILE` = Sonnet/Opus, `FAST_PROFILE` = Haiku-everywhere with capped turns) and what they emit — JSON, streamed UIMessage parts, or judge scores. `runResearch` itself runs the planner via the raw `@anthropic-ai/sdk` (one tool-less call, no point spawning a CLI subprocess), then fans out searcher sub-agents via the Claude Agent SDK with a fresh in-process MCP server per `query()` call (the underlying `McpServer` instance isn't re-entrant across concurrent connections — every server closes over the same `notes` array so the shared writeboard semantics survive), then runs the synthesizer.

## Trade-offs: orchestrator-workers vs single agent with tools

The exam phrases this question as "given this scenario, which choice is most correct?" — the right answer depends on whether the sub-tasks are independent.

| | Single agent with tools | Orchestrator-workers (this project) |
|---|---|---|
| **Shape** | One conversation, all tools, one loop until done | Planner → N parallel workers → synthesizer |
| **Wall-clock latency** | Linear in #tool calls (serial) | Bounded by slowest worker (parallel) |
| **Base cost** | One model spinning up; cheap floor | N+2 model invocations even on trivial queries; higher floor |
| **Prompt design** | Single system prompt has to handle every role | Per-role prompts; tool gating per agent |
| **Context isolation** | All tool results pile into one context — bloat, signal loss | Each worker has its own context; signal stays high |
| **Failure modes** | One mis-step poisons the shared context | Failures isolated per worker (`allSettled` keeps the rest alive) |
| **Debugging** | Single conversation trace | Multiple subprocesses; cross-process correlation needed |
| **New failure modes** | — | Coordination bugs (e.g. our MCP-per-query: shared `McpServer` instance not re-entrant under concurrent connections — only the first worker got tools) |

**Rule of thumb:**
- **Single agent with tools** when sub-tasks are *sequential and dependent* (each step needs the previous output). Cheaper, simpler, easier to debug.
- **Orchestrator-workers** when sub-tasks are *independent and parallelisable*. Research is the canonical fit: 5 sub-queries about Pinecone vs Weaviate don't depend on each other, so running them in parallel cuts wall-clock by ~5× and lets you give each worker a narrower role + tighter tool allowlist.

## How to run locally

**Prereqs:** Node ≥ 20, an Anthropic API key with credit.

**1. Env.** Put the key in the repo-root `.env` (one level above this directory — that path is intentional so the same key is shared with future projects):
```
ANTHROPIC_API_KEY=sk-ant-...
```
Watch the variable name — `AMTHROPIC_API_KEY` will silently fail (the SDK can't find it, you'll see *"Could not resolve authentication method"*).

**2. Install + start the dev server.** From `project-1-research/`:
```bash
npm install
set -a; source ../.env; set +a   # export the key into THIS shell
npm run dev
```
Open <http://localhost:3000>, type a research query, hit **Send**. The first run will spawn 3 Haiku searcher subprocesses (FAST profile) + a Haiku synth + a planner call. Expect ~1-2 minutes for a full response, ~$0.10-$0.30.

**3. Or hit the JSON / eval / test routes directly:**
```bash
# Full Sonnet/Opus orchestration (slower, better quality):
curl -X POST localhost:3000/api/research \
  -H 'Content-Type: application/json' \
  -d '{"query":"compare Pinecone vs Weaviate for hybrid search"}'

# Run the eval harness across the 5-item set:
curl -X POST localhost:3000/api/research/eval -d '{}' | jq .

# Verify the PII PreToolUse hook end-to-end:
curl -X POST localhost:3000/api/research/test-pii | jq '.verdict'
```

## API surface

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/research` | One-shot JSON. Runs `runResearch` on the **PROD** profile (Sonnet searchers, Opus synth, extended thinking on the planner). Returns the full payload (sub-queries, notes, report, report_path, pii_blocks). |
| POST | `/api/research/chat` | Streaming UIMessage endpoint consumed by `useChat`. Runs on the **FAST** profile (Haiku). Emits `tool-*` parts per pipeline stage, `reasoning-*` for the planner's thinking, and the report as `text-*`. |
| POST | `/api/research/eval` | Loops `evals/research-evals.json` items through `runResearch` (FAST profile), runs a Haiku LLM-judge against each report's criteria, returns per-criterion pass/fail + aggregate score. Accepts `{ ids: number[] }` to run a subset. |
| POST | `/api/research/test-pii` | Single-agent reproduction of the PII hook: prompts an agent to save a PII-laden note, asserts the hook denies + the agent recovers with `[REDACTED]`. |
| GET | `/api/research/download/[id]` | Serves a saved markdown report by filename. Validates the id against `^[A-Za-z0-9-]+\.md$` + resolves the path inside `REPORTS_DIR` (path-traversal defense). |

## Eval / quality bar

The eval set is at `evals/research-evals.json` — five diverse research queries (2 comparisons, 1 explanatory, 1 risk analysis, 1 technical), each with 5 shared structural criteria (executive summary, ≥3 headings, inline citations, Sources section, ~1-page length) plus 2 content-specific criteria. An item passes only if a Haiku judge confirms **every** criterion is satisfied. Target: **≥ 4/5 items pass**.

Most recent cheap-profile run: **3/5**. Two of the failures were **not** criteria misses — they were infra failures (the account ran out of credits mid-run, surfaced as "all searchers failed" + a credit-balance error string). The three that ran cleanly all passed every criterion. The lesson the loop is meant to teach: **read the failure shape before changing anything** — `passed:false` with non-empty `fails: [...]` means tune the prompt; `passed:false` with non-null `error: "..."` means fix infra (credits, env, retry policy). Same score, opposite fixes.

How to drive the iterate loop yourself:
```bash
# Full set, then summary view:
curl -s -X POST localhost:3000/api/research/eval -d '{}' \
| jq '{pass_rate, results: [.results[] | {id, passed, error, fails: [.criteria[]? | select(.pass==false) | .criterion]}]}'

# Re-run only the ids that failed:
curl -s -X POST localhost:3000/api/research/eval -d '{"ids":[2,4]}' | jq .
```

Knobs you tune (in `_lib.ts`): `SEARCHER_PROMPT`, `SYNTHESIZER_PROMPT`, `FAST_PROFILE` (models, `searcherMaxTurns`, `maxSubQueries`). Add or revise queries in `evals/research-evals.json`.

## What I'd add for production

In rough order of impact:

1. **Smarter retry** — the current bounded retry in `runAgent` retries any thrown error 3×. It should classify: retry transient codes (429, 529, 5xx, network) with exponential backoff + jitter, **fail fast** on permanent ones (400 `invalid_request`, 401, 403). Today, hitting a credit-balance 400 burns 3 retries for no reason.
2. **Durable storage** — `reports/` and `audit.jsonl` live on the local filesystem. Production wants S3 (reports) + a real append-only log (audit) keyed by request/user. The current setup loses everything when the container restarts.
3. **AuthN/Z + per-user budgets** — the routes are unauthenticated and have no rate limit. A real deployment needs an API key, a request rate limit, and a per-user cost ceiling that halts mid-run when crossed (each run is genuinely measurable LLM spend).
4. **Prompt caching breakpoints** — every searcher rebuilds the same long system prompt from scratch. Adding `cache_control` breakpoints between the static system prompt and the per-call sub-query would slash input-token cost. (Day-12 territory on the prep plan but cheap to apply here.)
5. **Observability with trace IDs** — propagate a `traceId` through the orchestrator → searchers → audit log so a single research request is reconstructible from `audit.jsonl` after the fact. Today, audit lines have a `ts` and a `tool_use_id` but no thread back to the parent run.
6. **Eval as a CI gate** — wire the eval route to a GitHub Actions job that runs on PRs against the orchestrator code; block merges that drop pass-rate below threshold. Prevents prompt drift.
7. **PII detector beyond regex** — the current `findPii` only catches email and US-SSN patterns. Production wants named-entity recognition (or a small LLM classifier) to catch names, addresses, phone numbers, EU national IDs, etc. Regex is a starting point, not a finished safeguard.
8. **Per-sub-query model selection** — `FAST_PROFILE` locks one model for all searchers. For mixed-complexity research, route easy sub-queries (definitions, lookups) to Haiku and complex ones (synthesis-during-search) to Sonnet. The plan step already has the sub-queries; it can emit a per-sub-query difficulty estimate.

## Deeper walkthrough

The code walkthrough — function-by-function in execution order, with the actual code blocks, glossary, and API reference — lives at [`docs/orchestrator-route.md`](docs/orchestrator-route.md). Use that when you want the *why each line does what it does*; this README is the design + portfolio view.
