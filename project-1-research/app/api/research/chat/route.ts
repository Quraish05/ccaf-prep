import path from "node:path";

import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from "ai";

import { FAST_PROFILE, runResearch, saveReport } from "../_lib";

export const runtime = "nodejs";
export const maxDuration = 600;

function extractLastUserText(messages: UIMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === "user");
  if (!last) return "";
  return last.parts
    .filter((p): p is { type: "text"; text: string } =>
      p.type === "text" && typeof (p as { text?: unknown }).text === "string",
    )
    .map((p) => p.text)
    .join("\n")
    .trim();
}

export async function POST(req: Request) {
  const body = (await req.json()) as { messages: UIMessage[] };
  const query = extractLastUserText(body.messages ?? []);
  if (!query) {
    return Response.json({ error: "no user text in messages" }, { status: 400 });
  }

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      // Each pipeline stage is modeled as a synthetic tool call. useChat
      // surfaces these to the UI as ToolUIPart entries with input-available /
      // output-available / output-error states — perfect for status pills.
      const planId = "plan-1";
      const synthId = "synth-1";
      const searcherIds: Record<number, string> = {};
      const textId = "report-1";

      try {
        const result = await runResearch(query, FAST_PROFILE, {
          onPlanStart: () => {
            writer.write({
              type: "tool-input-start",
              toolCallId: planId,
              toolName: "plan",
            });
            writer.write({
              type: "tool-input-available",
              toolCallId: planId,
              toolName: "plan",
              input: { query },
            });
          },
          onPlanDone: (subQueries, thinking) => {
            writer.write({
              type: "tool-output-available",
              toolCallId: planId,
              output: { sub_queries: subQueries },
            });
            // Surface the planner's extended-thinking text as a reasoning
            // part — the UI renders these in a collapsed <details> above
            // the answer.
            if (thinking) {
              const rid = "plan-thinking";
              writer.write({ type: "reasoning-start", id: rid });
              writer.write({ type: "reasoning-delta", id: rid, delta: thinking });
              writer.write({ type: "reasoning-end", id: rid });
            }
          },
          onSearcherStart: (subQuery, i) => {
            const id = `search-${i}`;
            searcherIds[i] = id;
            writer.write({
              type: "tool-input-start",
              toolCallId: id,
              toolName: "search",
            });
            writer.write({
              type: "tool-input-available",
              toolCallId: id,
              toolName: "search",
              input: { sub_query: subQuery, index: i },
            });
          },
          onSearcherDone: (subQuery, i, ok, summary) => {
            const id = searcherIds[i];
            if (ok) {
              writer.write({
                type: "tool-output-available",
                toolCallId: id,
                output: { sub_query: subQuery, summary },
              });
            } else {
              writer.write({
                type: "tool-output-error",
                toolCallId: id,
                errorText: "searcher rejected",
              });
            }
          },
          onSynthStart: () => {
            writer.write({
              type: "tool-input-start",
              toolCallId: synthId,
              toolName: "synthesize",
            });
            writer.write({
              type: "tool-input-available",
              toolCallId: synthId,
              toolName: "synthesize",
              input: { stage: "reading notes + writing report" },
            });
          },
          // synth output is emitted AFTER saveReport so we can include the
          // saved filename (used by the Download button in the UI).
          onSynthDone: undefined,
        });

        if (result.report) {
          const filepath = await saveReport(
            query,
            result.report,
            result.subQueries,
            result.citations,
          );
          const filename = path.basename(filepath);
          writer.write({
            type: "tool-output-available",
            toolCallId: synthId,
            // citations carried on the synth tool's output → page.tsx reads
            // them from this part and renders the Sources footnote list.
            output: {
              report_chars: result.report.length,
              filename,
              citations: result.citations,
            },
          });

          writer.write({ type: "text-start", id: textId });
          writer.write({ type: "text-delta", id: textId, delta: result.report });
          writer.write({ type: "text-end", id: textId });
        } else {
          writer.write({ type: "text-start", id: textId });
          writer.write({
            type: "text-delta",
            id: textId,
            delta:
              "All searchers failed; no notes were gathered, so no report could be synthesized.",
          });
          writer.write({ type: "text-end", id: textId });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        writer.write({ type: "error", errorText: `Research failed: ${msg}` });
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}
