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

export type ResearchResult = {
  subQueries: string[];
  planThinking: string;
  searcherSummaries: SearcherSummary[];
  notes: Note[];
  report: string | null;
  piiBlocks: PiiBlock[];
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
