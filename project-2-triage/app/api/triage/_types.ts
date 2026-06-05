// Shared types for this folder.

import type Anthropic from "@anthropic-ai/sdk";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

// Domain type returned by fetchCustomer and consumed across the agent loop.
export type Customer = {
  id: string;
  name: string;
  plan: "free" | "pro" | "enterprise";
  lifetime_value_cents: number;
  refund_eligible: boolean;
};

// PreToolUse hook contract: allow passes the call through; deny short-circuits
// dispatch and feeds `reason` back to the model as the tool_result. Same shape
// project-1 used for its PII guard.
export type PreToolUseDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason: string };

export type PreToolUseHook = (input: {
  tool_name: string;
  tool_input: Record<string, unknown>;
}) => PreToolUseDecision | Promise<PreToolUseDecision>;

// Observed denial record — the hook factory closes over an array of these so
// the route can surface what got blocked without parsing message internals.
export type HookBlock = {
  tool_name: string;
  reason: string;
  input: Record<string, unknown>;
};

// Post-dispatch trace record for one tool call the agent made. The route
// accumulates these per request and surfaces them in the JSON response so
// callers (and the Day-9 eval harness) can see which dispatch path each call
// took: inline TS handler, in-process MCP, or hook-denied before dispatch.
export type ToolCallRecord = {
  path: "inline" | "mcp" | "hook-denied";
  name: string;
  input: unknown;
  output: string;
};

// Flattened ticket row used by the UI's left rail. The on-disk dataset
// (evals/triage.jsonl) ships in Inspect-style {input, target, metadata}
// form; page.tsx flattens each sample into this shape so the client
// component doesn't need to know about the eval-side schema. The eval
// route reads the JSONL directly without going through this type.
export type TicketFixtureItem = {
  id: number;
  ticket: string;
  image_url?: string;
  expected_category: string;
  expected_action: string;
  notes?: string;
};

// What the (Day-9) eval script writes to evals/results.json. The MetricsCard
// at the top of the page renders the pass_rate; everything else is optional
// drill-down detail. The whole file is optional — the UI degrades to "not yet
// run" if it's missing.
export type EvalResults = {
  ran_at: string;
  model: string;
  total: number;
  passed: number;
  pass_rate: number;
  by_ticket?: Array<{
    id: number;
    category_match: boolean;
    action_match: boolean;
    passed: boolean;
  }>;
};

// One line in audit.jsonl. Three kinds:
//   - "tool_call": a tool actually ran. input is the already-redacted args,
//     output_preview is the first ~200 chars of the dispatch result.
//   - "hook_block": the PreToolUse hook denied. hook identifies which guard
//     fired; reason is the deny message fed back to the model.
//   - "api_call": one messages.create round-trip. Carries the latency and
//     token counts; tool_call rows from the same turn share the parent
//     api_call's `turn` index so aggregation tools can sum tokens by turn
//     without double-counting.
//
// Latency + token fields:
//   - latency_ms: tool execution time for tool_call rows; full API
//     round-trip time for api_call rows.
//   - input_tokens / output_tokens: from the parent messages.create's
//     `usage` field. Duplicated onto each tool_call row from the same turn
//     so a single log line is self-describing; aggregate via `turn` to
//     avoid double-counting.
//   - cache_creation_input_tokens / cache_read_input_tokens: same shape
//     as the SDK's usage object; useful for cost-attribution dashboards.
export type AuditRecord = {
  ts: string;
  request_id: string;
  turn?: number;
  kind: "tool_call" | "hook_block" | "api_call";
  tool: string;
  path?: "inline" | "mcp" | "hook-denied";
  input?: unknown;
  output_preview?: string;
  hook?: string;
  reason?: string;
  latency_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

// Single refund issuance, stored in the module-scope idempotency Map
// keyed by `${customer_id}|${order_id}`. Returned (with status flag) from
// the issue_refund MCP tool whether the call is a fresh issuance or an
// idempotent re-return.
export type RefundRecord = {
  refund_id: string;
  amount_cents: number;
  reason: string;
  issued_at: string;
  customer_id: string;
  order_id: string;
};

// Return shape of connectRefundsClient(): the MCP Client plus the cleanup
// callback the route should defer with finally { await close() }. The two
// fields are returned together because the close hides the underlying
// server.instance.close() — callers should treat them as one handle.
export type RefundsClientHandle = {
  client: Client;
  close: () => Promise<void>;
};

// Caller-tunable knobs for callWithRetryAndFallback. All fields are
// optional; the wrapper applies project defaults (3 attempts per model,
// 1s initial backoff doubling to 30s cap, model chain Sonnet → Haiku).
export type RetryFallbackOptions = {
  /** Models to try in order. First entry is the primary. */
  modelChain?: readonly string[];
  /** Max retries PER MODEL on 429/529 before falling to the next model. */
  maxAttemptsPerModel?: number;
  /** Initial backoff in ms; doubles every attempt, capped at maxBackoffMs. */
  initialBackoffMs?: number;
  /** Hard ceiling on a single sleep between retries. */
  maxBackoffMs?: number;
  /**
   * Idempotency key passed to the API on every attempt. Retries of the
   * SAME logical call use the SAME key so the API dedupes them.
   * Different turns / different agent invocations get different keys.
   */
  idempotencyKey?: string;
};

// What callWithRetryAndFallback returns. The retryLog is populated whenever
// at least one retry happened; on a first-attempt success it's empty.
// retryLog's element shape is kept anonymous — referenced via
// RetryFallbackResult["retryLog"] where needed (route.ts).
export type RetryFallbackResult = {
  message: Anthropic.Message;
  /** Which model in the chain finally produced the message. */
  modelUsed: string;
  /** 1 = first attempt succeeded; 2 = one retry was needed; etc. */
  attemptsUsed: number;
  /** Per-model attempt history — populated whenever there was at least one retry. */
  retryLog: Array<{
    model: string;
    attempt: number;
    error: string;
    backoff_ms: number;
  }>;
};
