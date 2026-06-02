// Shared types for this folder.

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

// One ticket row from evals/triage-tickets.json. The UI's left rail and the
// (future) eval harness both consume this shape.
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

// One line in audit.jsonl. Two kinds:
//   - "tool_call": a tool actually ran. input is the already-redacted args,
//     output_preview is the first ~200 chars of the dispatch result.
//   - "hook_block": the PreToolUse hook denied. hook identifies which guard
//     fired; reason is the deny message fed back to the model.
export type AuditRecord = {
  ts: string;
  request_id: string;
  kind: "tool_call" | "hook_block";
  tool: string;
  path?: "inline" | "mcp" | "hook-denied";
  input?: unknown;
  output_preview?: string;
  hook?: string;
  reason?: string;
};
