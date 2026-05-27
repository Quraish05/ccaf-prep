import { promises as fs } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";

import { runAgent, type Note, type PiiBlock } from "./_lib";

export const runtime = "nodejs";
export const maxDuration = 300;

const PLAN_THINKING_BUDGET = 4000;

async function makePlan(
  userQuery: string,
): Promise<{ subQueries: string[]; thinking: string }> {
  const client = new Anthropic();
  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    // With thinking enabled, max_tokens must exceed budget_tokens.
    max_tokens: PLAN_THINKING_BUDGET + 1024,
    thinking: { type: "enabled", budget_tokens: PLAN_THINKING_BUDGET },
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
  const subQueries = parsed.sub_queries;
  if (
    !Array.isArray(subQueries) ||
    subQueries.length < 3 ||
    subQueries.length > 5
  ) {
    throw new Error(
      `Planner returned ${Array.isArray(subQueries) ? subQueries.length : 0} sub-queries; expected 3-5`,
    );
  }
  return { subQueries: subQueries.map(String), thinking };
}

const SEARCHER_AGENT: AgentDefinition = {
  description:
    "Researches one sub-query via WebSearch and saves findings as notes.",
  prompt: `You are a research searcher. You will be given ONE sub-query and the overall research question for context.

Run WebSearch with 1-3 well-chosen queries. For every distinct fact, quote, statistic, or claim worth keeping, call mcp__notes__save_note with:
- title: a short label
- body: the finding (1-3 sentences)
- source_url: the source URL
- sub_query: the sub-query you were given (verbatim)

Aim for 3-6 notes. When done, reply with a one-paragraph summary of what you found and any gaps.`,
  tools: ["WebSearch", "mcp__notes__save_note"],
  mcpServers: ["notes"],
  model: "sonnet",
};

const SYNTHESIZER_AGENT: AgentDefinition = {
  description: "Reads all gathered notes and writes the final research report.",
  prompt: `You are a research synthesizer. Call mcp__notes__recent_notes exactly once to read every note the searchers gathered, then write a coherent report that answers the original research question.

The report MUST:
- Target roughly 1 page (~500-800 words). Be substantive but not bloated.
- Open with a 2-3 sentence executive summary
- Use markdown headings for major sections
- Cite sources inline as [title](url) where available
- End with a "## Sources" section listing every URL referenced`,
  tools: ["mcp__notes__recent_notes"],
  mcpServers: ["notes"],
  model: "opus",
};

const REPORTS_DIR = path.join(process.cwd(), "reports");

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function saveReport(
  userQuery: string,
  report: string,
  subQueries: string[],
): Promise<string> {
  await fs.mkdir(REPORTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${stamp}-${slugify(userQuery)}.md`;
  const filepath = path.join(REPORTS_DIR, filename);
  const header = `# ${userQuery}

*Generated: ${new Date().toISOString()}*

**Sub-queries covered:**
${subQueries.map((q, i) => `${i + 1}. ${q}`).join("\n")}

---

`;
  await fs.writeFile(filepath, header + report, "utf8");
  return filepath;
}

export async function POST(req: Request) {
  let body: { query?: unknown };
  try {
    body = (await req.json()) as { query?: unknown };
  } catch {
    return Response.json({ error: "Body must be valid JSON" }, { status: 400 });
  }
  const userQuery = typeof body.query === "string" ? body.query.trim() : "";
  if (!userQuery) {
    return Response.json(
      { error: "Missing 'query' string in body" },
      { status: 400 },
    );
  }

  const notes: Note[] = [];

  try {
    const { subQueries, thinking: plan_thinking } = await makePlan(userQuery);

    const searcherResults = await Promise.allSettled(
      subQueries.map((sq) =>
        runAgent(
          `Sub-query: ${sq}\n\nOverall research question (for context only): ${userQuery}`,
          SEARCHER_AGENT,
          notes,
        ),
      ),
    );

    const allBlocks: PiiBlock[] = [];
    const searcher_summaries = searcherResults.map((r, i) => {
      if (r.status === "fulfilled") {
        allBlocks.push(...r.value.blocks);
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
      return Response.json(
        {
          error:
            "All searchers failed; no notes were gathered, so no report could be synthesized.",
          query: userQuery,
          sub_queries: subQueries,
          searcher_summaries,
          pii_blocks: allBlocks,
        },
        { status: 502 },
      );
    }

    const synthPrompt = `Original research question: ${userQuery}

Sub-queries covered:
${subQueries.map((q, i) => `${i + 1}. ${q}`).join("\n")}

Write the final report now using mcp__notes__recent_notes.`;
    const synth = await runAgent(synthPrompt, SYNTHESIZER_AGENT, notes);
    allBlocks.push(...synth.blocks);
    const report = synth.text;
    const report_path = await saveReport(userQuery, report, subQueries);

    return Response.json({
      query: userQuery,
      sub_queries: subQueries,
      plan_thinking,
      searcher_summaries,
      notes,
      report,
      report_path,
      pii_blocks: allBlocks,
    });
  } catch (err) {
    console.error("[/api/research] failed", err);
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
