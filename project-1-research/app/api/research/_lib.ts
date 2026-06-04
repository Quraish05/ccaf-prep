import { promises as fs } from "node:fs";
import path from "node:path";

import Anthropic from "@anthropic-ai/sdk";
import {
  createSdkMcpServer,
  query,
  tool,
  type AgentDefinition,
  type HookCallback,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type {
  AuditRecord,
  Citation,
  Note,
  PiiBlock,
  ResearchProfile,
  ResearchResult,
  RunAgentResult,
  RunResearchEvents,
  SearcherSummary,
} from "./_types";

// The Agent SDK accepts model aliases natively for sub-agents
// (sonnet/haiku/opus). The raw Messages API (used by makePlan and now by the
// citation-aware synthesizer) needs full model IDs. Keep this map in sync
// with the FAST_PROFILE / PROD_PROFILE shapes.
function resolveModelAlias(alias: string): string {
  switch (alias) {
    case "haiku":
      return "claude-haiku-4-5";
    case "sonnet":
      return "claude-sonnet-4-6";
    case "opus":
      return "claude-opus-4-7";
    default:
      return alias; // assume already a full id
  }
}

export function buildNotesServer(
  notes: Note[],
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "notes",
    version: "1.0.0",
    tools: [
      tool(
        "save_note",
        "Save a research finding as a note. Use one note per discrete fact, quote, or data point.",
        {
          title: z.string(),
          body: z.string(),
          source_url: z.string().optional(),
          sub_query: z.string(),
        },
        async (args) => {
          notes.push({ ...args, created_at: new Date().toISOString() });
          return {
            content: [
              {
                type: "text",
                text: `Saved '${args.title}' (${notes.length} total).`,
              },
            ],
          };
        },
      ),
      tool(
        "recent_notes",
        "Return every note gathered so far, newest first. Call once before writing the report.",
        {},
        async () => {
          if (notes.length === 0) {
            return { content: [{ type: "text", text: "No notes yet." }] };
          }
          const text = [...notes]
            .reverse()
            .map(
              (n) =>
                `# ${n.title}\n(sub_query: ${n.sub_query}${n.source_url ? `, source: ${n.source_url}` : ""})\n\n${n.body}`,
            )
            .join("\n\n---\n\n");
          return { content: [{ type: "text", text }] };
        },
      ),
    ],
  });
}

// PII-blocking PreToolUse hook --------------------------------------------

const PII_PATTERNS: { name: string; regex: RegExp }[] = [
  { name: "email", regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { name: "ssn", regex: /\b\d{3}-\d{2}-\d{4}\b/ },
];

export function findPii(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    for (const { name, regex } of PII_PATTERNS) {
      if (regex.test(value)) return name;
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const r = findPii(v);
      if (r) return r;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      const r = findPii(v);
      if (r) return r;
    }
  }
  return null;
}

// MITIGATION: "Input validation" (Anthropic prompt-injection guidance —
// https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks).
// Anthropic frames this as "Filter prompts for jailbreaking patterns";
// here we apply the same technique egress-side, to TOOL-ARG inputs, so
// the model can't exfiltrate PII through downstream tool calls (e.g. via
// mcp__notes__save_note or WebSearch).
//
// Also supports the AUP's prohibition on systems used to "Misuse, collect,
// solicit, or gain access without permission to private information"
// including "non-public contact details" (anthropic.com/legal/aup).
//
// One layer in "Chain safeguards" — defense in depth alongside the
// AgentDefinition.tools allowlist and permissionMode: "bypassPermissions".
export function buildPiiHook(blocks: PiiBlock[]): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const hit = findPii(input.tool_input);
    if (!hit) return {};
    const reason = `[PII guard] Tool call to '${input.tool_name}' blocked: arguments contain a ${hit} pattern. Rewrite the arguments with the PII redacted (e.g. replace with [REDACTED]) and try again.`;
    blocks.push({ tool_name: input.tool_name, pattern: hit, reason });
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    };
  };
}

// Report saving -----------------------------------------------------------

export const REPORTS_DIR = path.join(process.cwd(), "reports");

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export async function saveReport(
  userQuery: string,
  report: string,
  subQueries: string[],
  citations: Citation[] = [],
): Promise<string> {
  await fs.mkdir(REPORTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filepath = path.join(REPORTS_DIR, `${stamp}-${slugify(userQuery)}.md`);
  const header = `# ${userQuery}

*Generated: ${new Date().toISOString()}*

**Sub-queries covered:**
${subQueries.map((q, i) => `${i + 1}. ${q}`).join("\n")}

---

`;
  // Append a Sources footnote section so the .md downloaded via /api/research/download
  // is self-contained — the [N] markers in the body resolve to a URL list at the end.
  const footer =
    citations.length > 0
      ? "\n\n## Sources\n\n" +
        citations
          .map((c) => {
            const label = c.source_url
              ? `[${c.title}](${c.source_url})`
              : c.title;
            return `[${c.number}] ${label}`;
          })
          .join("\n")
      : "";
  await fs.writeFile(filepath, header + report + footer, "utf8");
  return filepath;
}

// WebSearch audit log -----------------------------------------------------

const AUDIT_PATH = path.join(process.cwd(), "audit.jsonl");

// MITIGATION: "Continuous monitoring" (Anthropic prompt-injection guidance —
// https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks).
// The doc says: "Regularly analyze outputs for jailbreaking signs. Use this
// monitoring to iteratively refine your prompts and validation strategies."
// This hook captures the raw signal (every WebSearch query the agent
// issued) into audit.jsonl; the analysis + iteration are the operator's job.
//
// Important distinction from buildPiiHook above: this is OBSERVABILITY only.
// PostToolUse fires AFTER the tool ran — it cannot block or rewrite the
// call. To block, use a PreToolUse hook with permissionDecision: "deny".
//
// Per-tool-use start times captured by the PreToolUse companion below.
// Keyed by tool_use_id (unique per Agent SDK call). The PostToolUse hook
// reads + deletes from this map to compute latency_ms. Module-scope is
// safe here because tool_use_id is unique per sub-agent run.
const toolStartTimes = new Map<string, number>();

// PreToolUse companion: records when WebSearch starts so the post hook
// can compute latency. Doesn't deny anything — pure timing capture.
// Wired alongside the PII hook in PreToolUse below.
export const captureWebSearchStartHook: HookCallback = async (input) => {
  if (input.hook_event_name !== "PreToolUse") return {};
  if (input.tool_name === "WebSearch" && input.tool_use_id) {
    toolStartTimes.set(input.tool_use_id, Date.now());
  }
  return {};
};

// PostToolUse hook: one JSONL line per WebSearch call, in the unified
// AuditRecord shape shared with project-2-triage. Self-filters by tool_name
// so it's safe to wire onto any sub-agent — the synthesizer doesn't have
// WebSearch in its allowlist so it'll never trigger anyway.
//
// Latency is computed against the timestamp captured by the PreToolUse
// companion above. Token counts are left undefined — the Agent SDK doesn't
// surface per-tool-call usage at the hook layer (that's at the
// message-stream level). Future enrichment would add separate "api_call"
// rows from the message stream to populate input_tokens / output_tokens.
export const auditWebSearchHook: HookCallback = async (input) => {
  if (input.hook_event_name !== "PostToolUse") return {};
  if (input.tool_name !== "WebSearch") return {};

  let latencyMs: number | undefined;
  if (input.tool_use_id) {
    const start = toolStartTimes.get(input.tool_use_id);
    if (start !== undefined) {
      latencyMs = Date.now() - start;
      toolStartTimes.delete(input.tool_use_id);
    }
  }

  // tool_response shape varies; best-effort stringify + clip for the
  // output_preview field. Falls back to empty if the response isn't
  // serialisable.
  let outputPreview: string | undefined;
  const resp = (input as { tool_response?: unknown }).tool_response;
  if (resp !== undefined) {
    try {
      outputPreview = JSON.stringify(resp).slice(0, 200);
    } catch {
      outputPreview = String(resp).slice(0, 200);
    }
  }

  const entry: AuditRecord = {
    ts: new Date().toISOString(),
    request_id: (input as { session_id?: string }).session_id ?? "unknown",
    kind: "tool_call",
    tool: input.tool_name,
    tool_use_id: input.tool_use_id,
    input: input.tool_input,
    output_preview: outputPreview,
    latency_ms: latencyMs,
    // input_tokens / output_tokens left undefined — see comment above.
  };
  try {
    await fs.appendFile(AUDIT_PATH, JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    // Logging must never fail the agent — swallow + warn.
    console.warn("[audit] write failed:", err);
  }
  return {};
};

// Sub-agent harness -------------------------------------------------------

async function runAgentOnce(
  prompt: string,
  agent: AgentDefinition,
  notes: Note[],
): Promise<RunAgentResult> {
  // Build a fresh in-process MCP server per query() call. The McpServer
  // instance underneath isn't re-entrant across concurrent connections, but
  // every server's tool handlers close over the same `notes` array so the
  // shared-writeboard semantics survive.
  const notesServer = buildNotesServer(notes);
  const blocks: PiiBlock[] = [];
  const piiHook = buildPiiHook(blocks);

  const stream = query({
    prompt,
    options: {
      mcpServers: { notes: notesServer },
      agents: { _main: agent },
      agent: "_main",
      tools: ["WebSearch"],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      hooks: {
        // PII guard first, then timing capture for the audit log. Hooks
        // in the same matcher are called in order; if PII denies, the
        // tool never runs and the timing hook's recorded start (if any)
        // is just left in the map and overwritten on the next call.
        PreToolUse: [{ hooks: [piiHook, captureWebSearchStartHook] }],
        PostToolUse: [{ hooks: [auditWebSearchHook] }],
      },
    },
  });

  for await (const m of stream) {
    if (m.type === "result") {
      if (m.subtype === "success") return { text: m.result, blocks };
      throw new Error(`Sub-agent failed (${m.subtype})`);
    }
  }
  throw new Error("Sub-agent produced no result message");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Bounded retry with exponential backoff. Sub-agents can fail transiently
// under load (API 429/529, WebSearch throttling, truncated turns) — a burst
// of parallel searchers makes this common. Retry rather than fatally reject.
export async function runAgent(
  prompt: string,
  agent: AgentDefinition,
  notes: Note[],
  retries = 2,
): Promise<RunAgentResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await runAgentOnce(prompt, agent, notes);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(2 ** attempt * 1000); // 1s, 2s
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(String(lastErr));
}

// Cost/quality profiles ---------------------------------------------------

// PROD now defaults to Haiku across every role — the same model FAST uses,
// but without the searcher turn/sub-query caps. The bifurcation that
// originally split PROD (Sonnet/Opus) from FAST (Haiku) is preserved
// structurally so per-role model selection is still a one-line change;
// the defaults just lean cheap. resolveModelAlias still maps "sonnet" and
// "opus" to their full IDs, so flipping back to a heavier profile only
// requires editing the strings below.
export const PROD_PROFILE: ResearchProfile = {
  planModel: "claude-haiku-4-5",
  planThinkingBudget: 4000,
  searchModel: "haiku",
  synthModel: "haiku",
};

// Cheap profile for evals: Haiku everywhere, no extended thinking, capped.
export const FAST_PROFILE: ResearchProfile = {
  planModel: "claude-haiku-4-5-20251001",
  planThinkingBudget: 0,
  searchModel: "haiku",
  synthModel: "haiku",
  searcherMaxTurns: 8,
  maxSubQueries: 3,
};

// Planner -----------------------------------------------------------------

async function makePlan(
  userQuery: string,
  profile: ResearchProfile,
): Promise<{ subQueries: string[]; thinking: string }> {
  const client = new Anthropic();
  const useThinking = profile.planThinkingBudget > 0;
  const msg = await client.messages.create({
    model: profile.planModel,
    max_tokens: useThinking ? profile.planThinkingBudget + 1024 : 1024,
    ...(useThinking
      ? {
          thinking: {
            type: "enabled" as const,
            budget_tokens: profile.planThinkingBudget,
          },
        }
      : {}),
    system:
      'You break a research question into 3-5 focused, non-overlapping sub-queries that together cover the question. Respond with JSON only, no prose: {"sub_queries": ["...", "..."]}',
    messages: [{ role: "user", content: userQuery }],
  });
  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const thinking = msg.content
    .filter((b): b is Anthropic.ThinkingBlock => b.type === "thinking")
    .map((b) => b.thinking)
    .join("\n\n");
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Planner returned no JSON. Raw: ${text}`);
  const parsed = JSON.parse(match[0]) as { sub_queries?: unknown };
  const raw = parsed.sub_queries;
  if (!Array.isArray(raw) || raw.length < 3 || raw.length > 5) {
    throw new Error(
      `Planner returned ${Array.isArray(raw) ? raw.length : 0} sub-queries; expected 3-5`,
    );
  }
  let subQueries: string[] = raw.map(String);
  if (profile.maxSubQueries) {
    subQueries = subQueries.slice(0, profile.maxSubQueries);
  }
  return { subQueries, thinking };
}

// Agent definitions (built per-profile so model/turns can vary) -----------

const SEARCHER_PROMPT = `You are a research searcher. You will be given ONE sub-query and the overall research question for context.

Run WebSearch with 1-3 well-chosen queries. For every distinct fact, quote, statistic, or claim worth keeping, call mcp__notes__save_note with:
- title: a short label
- body: the finding (1-3 sentences)
- source_url: the source URL
- sub_query: the sub-query you were given (verbatim)

Aim for 3-6 notes. When done, reply with a one-paragraph summary of what you found and any gaps.`;

const SYNTHESIZER_SYSTEM = `You are a research synthesizer. The user message attaches every note the searcher sub-agents gathered, each as its own document. Write a coherent report that answers the original research question.

For every factual claim, statistic, quote, or specific detail in the report, cite the note that supports it via the citations mechanism — the citations API will attach structured citation metadata to the relevant spans. Connective tissue (transitions, framing) does not need citations.

The report MUST:
- Target roughly 1 page (~500-800 words). Be substantive but not bloated.
- Open with a 2-3 sentence executive summary.
- Use markdown headings for major sections.
- Read as natural prose. Do NOT include [N] markers, footnote numbers, or a "Sources" section in the body — the UI renders citations + sources automatically from the structured citation metadata you produce.`;

function searcherAgent(profile: ResearchProfile): AgentDefinition {
  return {
    description:
      "Researches one sub-query via WebSearch and saves findings as notes.",
    prompt: SEARCHER_PROMPT,
    tools: ["WebSearch", "mcp__notes__save_note"],
    mcpServers: ["notes"],
    model: profile.searchModel,
    ...(profile.searcherMaxTurns ? { maxTurns: profile.searcherMaxTurns } : {}),
  };
}

// Synthesizer — raw Messages API with citable documents -------------------
//
// Each note becomes a `document` content block with `citations: { enabled: true }`.
// Anthropic's API chunks plain-text documents into sentences and returns
// citation metadata pointing back to the cited span + the document_index.
// We resolve document_index back to notes[i].source_url for the footnote
// rendering downstream. Citations are *incompatible* with the Agent SDK
// path (notes there flow via tool_use, not as input documents) — this is
// why the synth moved off runAgent.

async function synthesizeWithCitations(
  userQuery: string,
  subQueries: string[],
  notes: Note[],
  profile: ResearchProfile,
): Promise<{ report: string; citations: Citation[] }> {
  const client = new Anthropic();

  // One document per note. document_index in the response = position in
  // this array = position in `notes`. context carries the source URL +
  // sub_query as metadata the model can see but won't be cited from
  // (per the spec, only `source.content` is citable; `title` and `context`
  // are not).
  const documents = notes.map((n) => ({
    type: "document" as const,
    source: {
      type: "text" as const,
      media_type: "text/plain" as const,
      data: n.body,
    },
    title: n.title.slice(0, 200),
    context: [
      n.source_url ? `source_url: ${n.source_url}` : null,
      `sub_query: ${n.sub_query}`,
    ]
      .filter(Boolean)
      .join(" · "),
    citations: { enabled: true },
  }));

  const subQueriesList = subQueries
    .map((q, i) => `${i + 1}. ${q}`)
    .join("\n");

  const response = await client.messages.create({
    model: resolveModelAlias(profile.synthModel),
    max_tokens: 4096,
    system: SYNTHESIZER_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          ...documents,
          {
            type: "text",
            text: `Original research question: ${userQuery}\n\nSub-queries covered:\n${subQueriesList}\n\nWrite the final report now, citing the attached documents for every factual claim.`,
          },
        ],
      },
    ],
  });

  return formatReportWithCitations(response.content, notes);
}

// Walk the response's text blocks. For each cited block, append `[N]`
// markers and dedupe footnote numbers by source_url across the whole
// report. Returns the assembled report body + the ordered citation list
// the UI renders as the "Sources" footnote section.
function formatReportWithCitations(
  blocks: Anthropic.ContentBlock[],
  notes: Note[],
): { report: string; citations: Citation[] } {
  const citations: Citation[] = [];
  const keyToNumber = new Map<string, number>();
  let report = "";

  for (const block of blocks) {
    if (block.type !== "text") continue;
    let segment = block.text;

    const blockCitations =
      "citations" in block && Array.isArray(block.citations)
        ? block.citations
        : [];

    if (blockCitations.length > 0) {
      const markers: number[] = [];
      for (const cit of blockCitations) {
        // All citation variants (char_location / page_location / content_block_location /
        // search_result_location) share document_index, document_title, and cited_text.
        const c = cit as {
          document_index: number;
          document_title?: string | null;
          cited_text?: string;
        };
        const note = notes[c.document_index];
        const sourceUrl = note?.source_url ?? null;
        const dedupKey = sourceUrl ?? `doc-${c.document_index}`;

        let num = keyToNumber.get(dedupKey);
        if (num === undefined) {
          num = keyToNumber.size + 1;
          keyToNumber.set(dedupKey, num);
          citations.push({
            number: num,
            source_url: sourceUrl,
            title: c.document_title ?? note?.title ?? "(untitled)",
            cited_text: c.cited_text ?? "",
          });
        }
        if (!markers.includes(num)) markers.push(num);
      }
      const markerStr = markers
        .sort((a, b) => a - b)
        .map((n) => `[${n}]`)
        .join("");
      // Place the markers immediately after the cited span (before any
      // trailing whitespace), so they stay attached to the claim even when
      // the rendered text wraps.
      segment = segment.replace(/(\s*)$/, ` ${markerStr}$1`);
    }

    report += segment;
  }

  return { report, citations };
}

// Orchestrator ------------------------------------------------------------

export async function runResearch(
  userQuery: string,
  profile: ResearchProfile = PROD_PROFILE,
  events?: RunResearchEvents,
): Promise<ResearchResult> {
  const notes: Note[] = [];
  events?.onPlanStart?.();
  const { subQueries, thinking: planThinking } = await makePlan(userQuery, profile);
  events?.onPlanDone?.(subQueries, planThinking);

  const searcher = searcherAgent(profile);
  // Wrap each searcher promise so onSearcherStart/Done fire per-sub-query
  // independent of Promise.allSettled's batch settlement.
  const searcherResults = await Promise.allSettled(
    subQueries.map(async (sq, i) => {
      events?.onSearcherStart?.(sq, i);
      try {
        const r = await runAgent(
          `Sub-query: ${sq}\n\nOverall research question (for context only): ${userQuery}`,
          searcher,
          notes,
        );
        events?.onSearcherDone?.(sq, i, true, r.text);
        return r;
      } catch (err) {
        events?.onSearcherDone?.(sq, i, false, null);
        throw err;
      }
    }),
  );

  const piiBlocks: PiiBlock[] = [];
  const searcherSummaries: SearcherSummary[] = searcherResults.map((r, i) => {
    if (r.status === "fulfilled") {
      piiBlocks.push(...r.value.blocks);
      return {
        sub_query: subQueries[i],
        status: r.status,
        summary: r.value.text,
        blocks: r.value.blocks,
        error: null,
      };
    }
    return {
      sub_query: subQueries[i],
      status: r.status,
      summary: null,
      blocks: [],
      error: String(r.reason),
    };
  });

  if (notes.length === 0) {
    return {
      subQueries,
      planThinking,
      searcherSummaries,
      notes,
      report: null,
      piiBlocks,
      citations: [],
    };
  }

  // Synth moved off the Agent SDK to the raw Messages API so we can attach
  // notes as `document` blocks with citations enabled. The trade-off: this
  // path doesn't run through runAgent's PII/audit hooks. That's fine here
  // because the synth makes no tool calls — there's nothing for the hooks
  // to intercept; their job is already done at the searcher stage.
  events?.onSynthStart?.();
  const { report, citations } = await synthesizeWithCitations(
    userQuery,
    subQueries,
    notes,
    profile,
  );
  events?.onSynthDone?.(report.length);

  return {
    subQueries,
    planThinking,
    searcherSummaries,
    notes,
    report,
    piiBlocks,
    citations,
  };
}
