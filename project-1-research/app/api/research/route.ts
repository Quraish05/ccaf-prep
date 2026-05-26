import Anthropic from "@anthropic-ai/sdk";
import {
  createSdkMcpServer,
  query,
  tool,
  type AgentDefinition,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 300;

type Note = {
  title: string;
  body: string;
  source_url?: string;
  sub_query: string;
  created_at: string;
};

function buildNotesServer(notes: Note[]): McpSdkServerConfigWithInstance {
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
              { type: "text", text: `Saved '${args.title}' (${notes.length} total).` },
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

async function makePlan(userQuery: string): Promise<string[]> {
  const client = new Anthropic();
  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system:
      'You break a research question into 3-5 focused, non-overlapping sub-queries that together cover the question. Respond with JSON only, no prose: {"sub_queries": ["...", "..."]}',
    messages: [{ role: "user", content: userQuery }],
  });
  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Planner returned no JSON. Raw: ${text}`);
  const parsed = JSON.parse(match[0]) as { sub_queries?: unknown };
  const subQueries = parsed.sub_queries;
  if (!Array.isArray(subQueries) || subQueries.length < 3 || subQueries.length > 5) {
    throw new Error(
      `Planner returned ${Array.isArray(subQueries) ? subQueries.length : 0} sub-queries; expected 3-5`,
    );
  }
  return subQueries.map(String);
}

const SEARCHER_AGENT: AgentDefinition = {
  description: "Researches one sub-query via WebSearch and saves findings as notes.",
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
- Open with a 2-3 sentence executive summary
- Use markdown headings for major sections
- Cite sources inline as [title](url) where available
- End with a "## Sources" section listing every URL referenced`,
  tools: ["mcp__notes__recent_notes"],
  mcpServers: ["notes"],
  model: "opus",
};

async function runAgent(
  prompt: string,
  agent: AgentDefinition,
  notesServer: McpSdkServerConfigWithInstance,
): Promise<string> {
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
  for await (const m of stream) {
    if (m.type === "result") {
      if (m.subtype === "success") return m.result;
      throw new Error(`Sub-agent failed (${m.subtype})`);
    }
  }
  throw new Error("Sub-agent produced no result message");
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
    return Response.json({ error: "Missing 'query' string in body" }, { status: 400 });
  }

  const notes: Note[] = [];
  const notesServer = buildNotesServer(notes);

  const subQueries = await makePlan(userQuery);

  const searcherResults = await Promise.allSettled(
    subQueries.map((sq) =>
      runAgent(
        `Sub-query: ${sq}\n\nOverall research question (for context only): ${userQuery}`,
        SEARCHER_AGENT,
        notesServer,
      ),
    ),
  );

  const searcher_summaries = searcherResults.map((r, i) => ({
    sub_query: subQueries[i],
    status: r.status,
    summary: r.status === "fulfilled" ? r.value : null,
    error: r.status === "rejected" ? String(r.reason) : null,
  }));

  const synthPrompt = `Original research question: ${userQuery}

Sub-queries covered:
${subQueries.map((q, i) => `${i + 1}. ${q}`).join("\n")}

Write the final report now using mcp__notes__recent_notes.`;
  const report = await runAgent(synthPrompt, SYNTHESIZER_AGENT, notesServer);

  return Response.json({
    query: userQuery,
    sub_queries: subQueries,
    searcher_summaries,
    notes,
    report,
  });
}
