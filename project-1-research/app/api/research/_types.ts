// Shared type declarations for the research orchestrator.
// Pure types only — no runtime code. Values (e.g. profile constants) live in _lib.ts.

export type Note = {
  title: string;
  body: string;
  source_url?: string;
  sub_query: string;
  created_at: string;
};

export type PiiBlock = {
  tool_name: string;
  pattern: string;
  reason: string;
};

export type RunAgentResult = {
  text: string;
  blocks: PiiBlock[];
};

export type ResearchProfile = {
  /** Full model id for the planner's raw Anthropic SDK call. */
  planModel: string;
  /** Extended-thinking budget for the planner; 0 disables thinking. */
  planThinkingBudget: number;
  /** Model alias for the searcher sub-agents ('sonnet' | 'haiku' | ...). */
  searchModel: string;
  /** Model alias for the synthesizer sub-agent. */
  synthModel: string;
  /** Cap on searcher agentic turns; undefined = uncapped. */
  searcherMaxTurns?: number;
  /** Cap on how many sub-queries to actually run; undefined = all. */
  maxSubQueries?: number;
};

export type SearcherSummary = {
  sub_query: string;
  status: "fulfilled" | "rejected";
  summary: string | null;
  blocks: PiiBlock[];
  error: string | null;
};

// One line in audit.jsonl. Unified shape with project-2-triage so downstream
// cost/perf dashboards can ingest both projects with one parser. This project
// currently emits "tool_call" rows (one per WebSearch invocation via the
// PostToolUse audit hook); a paired PreToolUse companion records start times
// so latency_ms is populated. Token counts are left undefined here — the
// Agent SDK doesn't expose per-tool-call usage at the hook layer; future
// enrichment would add "api_call" rows at the message-stream level.
export type AuditRecord = {
  ts: string;
  request_id: string;
  kind: "tool_call" | "api_call";
  tool: string;
  tool_use_id?: string;
  input?: unknown;
  output_preview?: string;
  latency_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
};

// One footnote-style citation, deduplicated by source_url across the report.
// Multiple cited spans in the report body that point at the same source URL
// share the same `number`. `cited_text` is the exact substring of the source
// note's body that supported the claim, returned by Anthropic's citations
// API at no output-token cost.
export type Citation = {
  number: number;
  source_url: string | null;
  title: string;
  cited_text: string;
};

export type ResearchResult = {
  subQueries: string[];
  planThinking: string;
  searcherSummaries: SearcherSummary[];
  notes: Note[];
  report: string | null;
  piiBlocks: PiiBlock[];
  citations: Citation[];
};

// Optional lifecycle callbacks fired during runResearch — used by the
// streaming endpoint to emit per-stage trace events to the UI as they
// happen. Fully optional; runResearch works unchanged without them.
export type RunResearchEvents = {
  onPlanStart?: () => void;
  onPlanDone?: (subQueries: string[], thinking: string) => void;
  onSearcherStart?: (subQuery: string, index: number) => void;
  onSearcherDone?: (
    subQuery: string,
    index: number,
    ok: boolean,
    summary: string | null,
  ) => void;
  onSynthStart?: () => void;
  onSynthDone?: (reportChars: number) => void;
};
