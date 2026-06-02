# Project 2 — Concepts reference

> Last updated: 2026-06-02 · Covers Day 8 of the CCA-F prep (Day 9 evals + Day 10 vision still to come)

A skim-before-the-exam reference of every concept Project 2 actually touched. Each entry has the load-bearing facts + a pointer to where the concept lives in the codebase. Drill into the [Project 2 README](../project-2-triage/README.md) when you need the long form. Companion doc: [project-1-concepts](project-1-concepts.md).

**Exam domain tags** map each concept to the 5 weighted CCA-F areas:
- `[ARCH]` Agentic Architecture & Orchestration (~27%)
- `[MCP]` Tool Design & MCP Integration (~18%)
- `[CC]` Claude Code Configuration & Workflows (~20%)
- `[PROMPT]` Prompt Engineering & Structured Output (~20%)
- `[REL]` Context Management & Reliability (~15%)

---

## 1. Manual tool-use loop (raw Anthropic SDK)

### The shape `[ARCH]`
Pattern from project-1's `_legacy/tool-use-roundtrip-sdk.ts` extended to a full multi-turn loop. Each iteration:
1. `anthropic.messages.create({ model, system, tools, messages, ... })`
2. Check `response.stop_reason`
3. If `"tool_use"`: append assistant turn + `tool_result` blocks → re-call
4. If `"end_turn"`: forced-recovery branch (see §1.5)
5. Else: 502

Capped at `MAX_TURNS = 10` to prevent runaway. Loop lives in [`route.ts:72-203`](../project-2-triage/app/api/triage/route.ts).

### Manual loop vs. Tool Runner `[ARCH]`
The Anthropic SDK ships `client.beta.messages.toolRunner({...})` which handles the agent loop for you when all custom tools are inline TS functions. Project 2 uses the **manual** loop because `issue_refund` routes through MCP, not a direct TS handler — the dispatch site has to branch (inline vs `mcp.callTool`), which Tool Runner doesn't expose. Trade: more code, but full control over dispatch + per-call audit + hook injection.

### Assistant-turn append — the API contract `[ARCH]`
`messages.push({ role: "assistant", content: res.content })` after every turn that ends in `tool_use`. The **FULL** content array — not just `.text` — gets appended verbatim. The next request's `tool_result` blocks reference the original `tool_use_id`s; rebuilding the assistant turn from `.text` alone silently breaks the loop because the ids no longer match.

This is the single most exam-relevant gotcha in multi-turn tool use.

### Parallel tool dispatch `[ARCH]`
When the model emits multiple `tool_use` blocks in one turn, they run concurrently via `Promise.all(toolUses.map(async (t) => {...}))`. The hook check, dispatch, and audit append all parallelise per call. The array of `tool_result` blocks becomes one `user` turn (NOT one turn per call) and the loop iterates.

### Forced-recovery branch `[ARCH][REL]`
If `stop_reason === "end_turn"` arrives without `submit_triage_report`, two things happen together:
1. Push a user message: *"You ended without calling submit_triage_report. Conclude now…"*
2. Re-call with `tool_choice: { type: "tool", name: REPORT_TOOL, disable_parallel_tool_use: true }`.

Both halves are load-bearing. The user message **re-opens the conversation** — you can't re-call `messages.create` after `end_turn` without giving the model something new to respond to. The forced tool_choice **mandates** the structured emit. Response carries `forced_recovery: true` when this safety net fires.

### Loop-exit conditions `[REL]`
Five exit paths from the for-loop:

| Exit | HTTP | Trigger |
| --- | --- | --- |
| Normal terminal | 200 | `submit_triage_report` emitted (any turn) |
| Forced-recovery success | 200 | `end_turn` → re-call with `tool_choice` succeeds; `forced_recovery: true` |
| Forced-recovery miss | 502 | `tool_choice: tool` returned no tool_use block (should be unreachable) |
| Unexpected stop_reason | 502 | `refusal` / `max_tokens` / `pause_turn` / `stop_sequence` |
| Loop cap exhausted | 504 | `MAX_TURNS = 10` without a terminal |

Plus a typed exception catch outside the loop (see §6).

---

## 2. Structured outputs via forced tool

### The canonical exam pattern `[PROMPT]`
Three things together:
- A tool with `strict: true` on the definition — API enforces JSON schema **server-side**.
- `tool_choice: { type: "tool", name: "<tool>" }` — model MUST call exactly that tool.
- `disable_parallel_tool_use: true` — exactly one call.

Together, the model's only legal output becomes a single `tool_use` block whose `.input` satisfies the schema. That input IS the validated response — no parsing, no `extractJson()`, no schema-mismatch error.

Project 2 uses this on the forced-recovery branch ([`route.ts:106-114`](../project-2-triage/app/api/triage/route.ts)); on the normal loop turns `tool_choice` is left at the default `auto` so the model can also call `classify_ticket` / `fetch_customer` / `issue_refund` as needed.

### `tool_choice` values reprise `[PROMPT]`
| Value | Behavior |
| --- | --- |
| `auto` (default) | Model decides whether to call any tool |
| `any` | Model MUST call one of the tools (its choice which) |
| `tool` | Model MUST call the named tool |
| `none` | Model can't use tools this turn |

Any of the above can include `disable_parallel_tool_use: true` to force one call per turn.

### `strict: true` constraints `[PROMPT]`
What the API enforces vs. what it silently drops:

| Supported | Dropped silently |
| --- | --- |
| Basic types: object / array / string / integer / number / boolean / null | Numerical constraints: `minimum`, `maximum`, `multipleOf` |
| `enum`, `const` | String constraints: `minLength`, `maxLength`, `pattern` |
| `anyOf`, `allOf`, `$ref`/`$def` | Complex array constraints |
| Type unions: `type: ["string", "null"]` | `additionalProperties` set to anything other than `false` |
| `required` (all top-level fields recommended) | |
| `additionalProperties: false` (required on every object) | |

`submit_triage_report`'s schema uses enums (`ticket_category`, `action_taken`), type unions for nullable scalars (`customer_id`, `escalation_reason`), `anyOf` for the nullable `refund` object. The $500 cap can't go in the schema as `maximum: 50000` — strict drops it. The cap lives in the system prompt + the PreToolUse hook instead.

### Soft-then-hard force `[PROMPT][ARCH]`
The system prompt INSTRUCTS the model to call `submit_triage_report` last. Most turns comply → normal terminal. If it doesn't → forced recovery. This is the soft-then-hard pattern: prompt-side guidance is the default; harness-side `tool_choice` is the safety net. Forcing on every turn would prevent the model from calling other tools first (classify, fetch, refund), which is why we don't.

---

## 3. In-process MCP — the InMemoryTransport path

### Two ways to do in-process MCP `[MCP]`
Project 1 used `createSdkMcpServer` from `@anthropic-ai/claude-agent-sdk` wired through `ClaudeAgentOptions.mcpServers` — the Agent SDK handles the transport invisibly inside `query()`. **Project 2 uses `createSdkMcpServer` ALSO** but extracts the underlying `McpServer.instance` and wires it manually to an `InMemoryTransport.createLinkedPair()` from `@modelcontextprotocol/sdk`. Same in-process MCP — different transport surface, because the raw Anthropic SDK doesn't know about MCP.

### InMemoryTransport pair `[MCP]`
```ts
const server = buildRefundsServer();
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.instance.connect(serverTransport);
const client = new Client({ name: "triage-agent", version: "1.0.0" });
await client.connect(clientTransport);
```
Two linked transports communicating in memory. Server on one side, MCP `Client` on the other. The MCP client's `callTool({ name, arguments })` round-trips through JSON-RPC over the in-memory pipe. **Same wire format as stdio MCP**; zero IPC overhead.

The MCP `Client` class lives in `@modelcontextprotocol/sdk/client/index.js`. `InMemoryTransport` in `@modelcontextprotocol/sdk/inMemory.js`.

### Per-request re-entrancy `[MCP][REL]`
Same lesson as project 1: `McpServer` instances aren't re-entrant across concurrent connections. `connectRefundsClient()` builds a FRESH server + transport pair per request — sharing one across concurrent triages would silently break the second request's tool access.

### Why bother with the MCP path here `[MCP]`
`issue_refund` could be a plain TS function — no MCP needed. We force it through MCP to **exercise the path**: a real callable MCP tool inside a raw-SDK loop. Demonstrates that MCP isn't tied to the Agent SDK; you can layer it onto a manual loop with `@modelcontextprotocol/sdk` directly. Cost: more boilerplate (the InMemoryTransport pair + `connectRefundsClient` + `finally close()` cleanup). The model never knows the difference.

### Dispatch divergence at one site `[MCP]`
The `t.name === "issue_refund" ? "mcp" : "inline"` branch in [`route.ts:181-183`](../project-2-triage/app/api/triage/route.ts) is the only place the codebase distinguishes paths. That `path` value flows through `tool_calls[].path` → the UI chip colour + the audit log filter. Same model-facing surface (`tools: [...]`); divergent dispatch.

---

## 4. PreToolUse hook — emulated in raw SDK

### Hook event mapping `[CC]`
Project 1 used the Agent SDK's `hooks: { PreToolUse: [...] }` option on `query()` — the SDK fired the hook at the right moment. **Project 2's raw-SDK loop has no hook system**, so we emulate the contract: a factory function returning `(input) => { decision: "allow" | "deny", reason? }`, called manually BEFORE dispatching each tool. Same semantics; manual plumbing.

If you ever migrate this route to the Agent SDK, the hook moves from "called at the dispatch site" to "registered on `query()` options" — same factory, different transport.

### Factory pattern `[CC]`
`buildRefundCapHook(blocks: HookBlock[])` returns a closure over `blocks`. Each deny pushes a record into `blocks`. The route reads `blocks` after the loop to surface denials in the response. Same shape as project-1's `buildPiiHook` — factory closing over a caller-owned array makes denials observable without parsing message internals.

### Deny shape `[CC][REL]`
A deny returns a `tool_result` block with `is_error: true` and the deny `reason` as content. The model reads the failure + the reason and decides next steps. **The reason itself is the prompt back** — explicit instructions ("DO NOT retry... Conclude by calling submit_triage_report with action_taken='escalated'..."). The wording is what makes the hook a *defence* rather than just a brick wall.

Same pattern as project-1's PII hook (deny reason told the model to redact + retry). Different reason text; same architecture.

### Allow-path early return `[CC]`
The hook early-returns `{ decision: "allow" }` when `tool_name !== "issue_refund"`. The guard only fires on the one tool it watches. Keeps non-guarded tool dispatches at zero overhead.

### Defence-in-depth `[CC][REL]`
The $500 cap exists in **three** places: the system prompt (soft), the `issue_refund` tool description (soft), and the PreToolUse hook (hard). The hook is the only layer that doesn't trust the model.

---

## 5. PCI redaction at observability sites

### The defence surface `[REL]`
PCI requires PANs (primary account numbers) never appear in logs. In this codebase "logs" = the JSON response, the in-memory records (`toolCalls`, `hookBlocks`), and the `audit.jsonl` file on disk. `redactCardNumbers` runs at every observability capture site. **Defence by location, not by trust**.

### Regex + Luhn `[REL]`
Detection is two-stage:
1. **Regex**: `\b(?:\d[ -]?){13,19}\b` — 13–19 digit run with optional space/hyphen separators. Catches `4242 4242 4242 4242`, `4242-4242-4242-4242`, `4242424242424242`.
2. **Luhn validation**: only candidates whose digits Luhn-validate (mod-10 checksum that real PANs satisfy) get replaced with `[REDACTED CARD]`. Long order ids, tracking numbers, ISO timestamps don't satisfy Luhn — false positives stay readable.

This is the same precision/recall tradeoff every PII detector navigates. Regex alone catches order ids; Luhn alone misses zero-prefixed cards; the combination is the sweet spot.

### Recursive walk `[REL]`
`redactCardNumbers(value: unknown)` walks strings, arrays, and plain objects. Tool inputs are arbitrary JSON; you have to find PANs at any depth. Returns a new value (immutable), doesn't mutate the input.

### "Disk is the source of truth" `[REL]`
The audit log on disk is the source of truth — the SSE endpoint tails the file, not in-memory state. Therefore: redact **before** writing to disk. The wire/UI can't accidentally un-redact what's already gone. Same principle as Anthropic Managed Agents' vault-credential injection — the secret never enters the part of the system that could leak it.

---

## 6. Error handling & resource cleanup

### Typed Anthropic errors `[REL]`
The outer `try { ... } catch (err)` checks `err instanceof Anthropic.APIError` and propagates `err.status` as the response status. Rate limits surface as 429s, auth failures as 401s, schema failures as 400s — the SDK's typed exception hierarchy carries the right status through.

```ts
if (err instanceof Anthropic.APIError) {
  return Response.json(
    { error: err.message, type: err.constructor.name, status: err.status },
    { status: err.status ?? 500 },
  );
}
```

Never string-match error messages — the SDK's class hierarchy is the canonical source of truth.

### `finally { await close() }` `[REL]`
The MCP client + server connected via `InMemoryTransport` are closed in a `finally` block — runs on every return path (success, error, throw). Prevents leaked transport handles when the route ends. Resource lifetime is bounded by the route handler.

### `MAX_TURNS` cap → 504 `[REL]`
`MAX_TURNS = 10`. If the loop exits without a terminal, return 504 (gateway timeout) with the partial `tool_calls` so the human can see how far the agent got. A 504 here signals "the model didn't reach a terminal in the allotted budget" — not necessarily infra failure.

---

## 7. Demo UI patterns (App Router)

### Server Component reading fs `[ARCH]`
[`app/page.tsx`](../project-2-triage/app/page.tsx) reads `evals/triage.jsonl` (Inspect-style dataset, one JSON sample per line) + `evals/results.json` at request time via `fs.readFile`. The loader flattens each `{input, target, metadata}` sample into the flat `TicketFixtureItem` shape the UI consumes — the schema-split lives in `page.tsx`, not the type. `export const dynamic = "force-dynamic"` forces re-read on every load — the Day-9 eval route writes to `results.json` between page loads, so static caching would stale the MetricsCard.

The fixture is passed as a prop to the client `<TriageInbox>`; results to the server `<MetricsCard>`.

### Server + client component split `[ARCH]`
- **Server** (no `"use client"`): `page.tsx`, `MetricsCard.tsx`. No state, no event handlers.
- **Client** (`"use client"` directive): `TriageInbox.tsx` (selection state + fetch + result rendering), `AuditLog.tsx` (EventSource subscription).

The split is principled — anything needing `useState` / `useEffect` / browser APIs goes client-side. Everything else stays server. **Cheapest pattern that works** — server components don't ship JS to the client; only the interactive bits do.

### Cross-component type imports `[ARCH]`
The client components import their types from `app/api/triage/_types.ts` via `import type { ... }`. Type-only imports are stripped at build time so the Server/Client boundary stays clean — the types don't carry runtime weight into either bundle.

---

## 8. Server-Sent Events (SSE) for live audit log

### One-way streaming over HTTP `[ARCH][REL]`
SSE is plain HTTP with `Content-Type: text/event-stream`, `data: <line>\n\n` framing, and connection kept open via `Cache-Control: no-cache, no-transform` + `Connection: keep-alive`. The browser's `EventSource` API consumes it natively — no WebSocket, no polling, no SSE library needed.

### Position-tracked file tail `[REL]`
`/api/audit/stream` does a 50-line backlog read on connect, then polls every 500ms:
1. `fs.stat` for size growth.
2. If grown, `fs.open` + `fd.read(buf, 0, size - lastSize, lastSize)` — read only the NEW bytes.
3. Split on `\n`, frame each non-empty line as `data: <line>\n\n`, enqueue.
4. Update `lastSize`.

Same model as `tail -f`. The position tracking avoids re-reading the whole file on every tick.

### Cancellation hygiene `[REL]`
The Web Streams API's `ReadableStream.cancel()` callback fires when the browser closes the EventSource. The endpoint clears the polling interval in `cancel()` to prevent leaked timers. Without this, every closed tab would leak a 500ms interval forever.

### Why not WebSocket `[ARCH]`
SSE is one-way (server → client). Audit log doesn't need client → server messages. SSE is also simpler to deploy: plain HTTP, no upgrade dance, works through most proxies and load balancers without special config. Reach for WebSocket when bidirectional is genuinely needed (live chat, collaborative editing, multiplayer). Not here.

---

## 9. Eval fixture design

### Per-row shape `[REL]`
`evals/triage.jsonl` — 16 rows in Inspect-style format. Each line: `{ id, input: { ticket, image_url? }, target: { category, action }, metadata: { notes? } }`. Companion `evals/triage.eval.json` carries the task spec (solver, scorers, pass criteria 12/16, policy anchors); `evals/README.md` documents the layout. `metadata.notes` records the policy trigger that *should* fire for each escalation row (e.g. "Trigger: amount > $500 cap", "Trigger: chargeback threat", "Vision-eval seed: agent should incorporate the image"). The Inspect convention is what lets the eval route + the UI consume the same dataset without one of them owning a bespoke shape.

### Distribution `[REL]`
9 escalated / 4 refund_issued / 3 closed_no_action / 4 answered. **Escalation is deliberately overweighted** because it has the most distinct policy triggers (over-cap, chargeback threat, legal threat, ask-for-human, missing-order-id, bug_report). Each row targets one trigger cleanly so failures point at *which* rule regressed. Skewing makes the eval more diagnostic than balanced.

### Image rows seed for vision `[ARCH][REL]`
Rows 2 (refund / damage photo) and 10 (bug / error screenshot) carry `image_url`. Day-10 vision work compares "blind" runs vs "with image" runs against the **same** `expected_action` — any improvement is attributable to vision, not to a different decision boundary.

### Placeholder results file `[REL]`
`evals/results.json` ships in the repo with placeholder data so the MetricsCard renders during development. The Day-9 eval script will overwrite this file with real numbers. The MetricsCard gracefully degrades to "Not yet run" if the file is missing entirely — important for first-clone bootstrap.

---

## 10. Prompt-injection mitigations — three tiers

### Defence by location `[PROMPT][REL]`
Strongest → weakest by **where the defence lives**:

| Tier | Where | In this codebase |
| --- | --- | --- |
| 1. **Harness-level capability isolation** | The harness refuses the action regardless of model behaviour | `buildRefundCapHook` PreToolUse guard, tool allowlist on the agent definition |
| 2. **Output validation at the API boundary** | API or harness validates output before propagation | `strict: true` on `submit_triage_report` |
| 3. **Prompt-side hardening / input delimiting** | Tell the model to behave; structurally separate trusted vs untrusted content | Aria's system prompt instructions, `<user_content>` tags (not used here — no untrusted docs in the loop yet) |

Defence in depth uses all three. Tier 1 is strongest because it doesn't depend on the model. Tier 3 is weakest because it relies on the model respecting prompt conventions.

### Anthropic's 5 named techniques cross-reference `[PROMPT]`
Project 1's concepts doc lists Anthropic's 5 specific mitigations (harmlessness screens, input validation, prompt engineering, continuous monitoring, chain safeguards). The three-tier model here is a structural rephrasing of the same idea:

- **Harmlessness screens** → Tier 1 (pre-screen at the harness boundary).
- **Input validation** → Tier 2 if validating before dispatch; Tier 3 if just regex on raw text.
- **Prompt engineering** → Tier 3.
- **Continuous monitoring** → meta-tier — informs all three via audit logs + evals.
- **Chain safeguards** → the principle the tiers implement (defence in depth).

### Citations vs. appended sources `[PROMPT]`
Not strictly an injection mitigation but adjacent. **Appending sources** = stuff docs into the prompt and trust the model to cite faithfully. The model can fabricate quotes, misattribute, paraphrase wrongly. **Anthropic Citations** (`documents: [...]` + `citations: { enabled: true }`) is structurally grounded — the API rejects fabricated offsets server-side; you get back `document_index` + `start_char_index`/`end_char_index` + `cited_text` from the actual source. For anything user-facing where misattribution is a liability — legal, medical, RAG — Citations is the right primitive; appending sources is a prototype shortcut.

---

## Exam-domain heatmap

How this project's concepts split across the 5 CCA-F domains:

| Section | Primary domain | Notes |
| --- | --- | --- |
| 1. Manual tool-use loop | `[ARCH]` 27% | Assistant-turn append contract + parallel dispatch + forced recovery + loop exits. Heavy here. |
| 2. Structured outputs via forced tool | `[PROMPT]` 20% | `tool_choice: tool` + `strict: true` + `disable_parallel_tool_use`. The canonical exam pattern. |
| 3. In-process MCP (InMemoryTransport) | `[MCP]` 18% | Direct-MCP-SDK path vs. Agent-SDK path. Same wire format, different ergonomics. |
| 4. PreToolUse hook (emulated) | `[CC]` 20% + `[REL]` 15% | Factory + deny semantics + the reason-as-prompt trick. |
| 5. PCI redaction | `[REL]` 15% | Regex + Luhn + recursive walk + "disk is the source of truth". |
| 6. Error handling & cleanup | `[REL]` 15% | Typed Anthropic errors, `finally` close, MAX_TURNS cap. |
| 7. Demo UI patterns | `[ARCH]` 27% | Server vs client component split — Next.js App Router specifics. |
| 8. SSE | `[ARCH]` + `[REL]` | One-way streaming, position-tracked tail, cancellation. |
| 9. Eval fixture design | `[REL]` 15% | Per-row shape, skewed distribution, image seeds. |
| 10. Prompt injection mitigations | `[PROMPT]` 20% | Three-tier model — defence by location. Cross-references project-1's 5-technique list. |

Weakest coverage (relative to project 1): `[MCP]` 18% — project 2 covers the InMemoryTransport variant but not the broader MCP surface (transports, sampling, the 5-RFC auth spec). Re-read [project-1-concepts §2](project-1-concepts.md#2-mcp) for those before the exam.
