"use client";

import { useState } from "react";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  getToolName,
  isReasoningUIPart,
  isStaticToolUIPart,
  isTextUIPart,
  type ToolUIPart,
  type UIMessage,
} from "ai";

export default function Home() {
  const { messages, sendMessage, status, error, stop } = useChat({
    transport: new DefaultChatTransport({ api: "/api/research/chat" }),
  });
  const [input, setInput] = useState("");
  const busy = status === "submitted" || status === "streaming";

  return (
    <main className="mx-auto max-w-3xl px-6 py-12 font-sans">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">
          Research Orchestrator
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Streamed orchestrator-worker pipeline via the AI SDK. Each plan,
          searcher, and synth stage appears live in the sub-agent trace as it
          runs.
        </p>
      </header>

      <div className="space-y-4">
        {messages.map((m) => (
          <MessageCard key={m.id} message={m} />
        ))}
        {messages.length === 0 && (
          <p className="text-sm text-zinc-500">
            Ask a research question to start. The full pipeline (Haiku
            planner → 3 parallel searchers → Haiku synthesizer) runs once per
            send — expect ~1–2 minutes per response on the fast profile.
          </p>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!input.trim() || busy) return;
          sendMessage({ text: input });
          setInput("");
        }}
        className="mt-8 space-y-3"
      >
        <textarea
          className="w-full rounded border border-zinc-300 bg-white p-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          rows={3}
          placeholder="e.g. compare Pinecone vs Weaviate for hybrid search"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
        />
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            {busy ? "Researching…" : "Send"}
          </button>
          {busy && (
            <button
              type="button"
              onClick={stop}
              className="rounded border border-zinc-300 px-4 py-2 text-sm dark:border-zinc-700"
            >
              Stop
            </button>
          )}
        </div>
      </form>

      {error && (
        <div className="mt-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {error.message}
        </div>
      )}
    </main>
  );
}

function MessageCard({ message }: { message: UIMessage }) {
  const isUser = message.role === "user";
  const textParts = message.parts.filter(isTextUIPart);
  const toolParts = message.parts.filter(isStaticToolUIPart);
  const reasoningParts = message.parts.filter(isReasoningUIPart);
  const text = textParts.map((p) => p.text).join("\n");
  const reasoning = reasoningParts.map((p) => p.text).join("\n\n");

  const synthPart = toolParts.find(
    (p) => getToolName(p) === "synthesize" && p.state === "output-available",
  );
  const synthOutput =
    synthPart && "output" in synthPart && synthPart.output && typeof synthPart.output === "object"
      ? (synthPart.output as Record<string, unknown>)
      : null;
  const filename =
    synthOutput && "filename" in synthOutput
      ? String(synthOutput.filename)
      : null;
  const citations: Citation[] =
    synthOutput && Array.isArray(synthOutput.citations)
      ? (synthOutput.citations as Citation[])
      : [];

  return (
    <article
      className={`rounded border p-4 ${
        isUser
          ? "border-zinc-300 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900"
          : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"
      }`}
    >
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
        {isUser ? "You" : "Assistant"}
      </div>

      {toolParts.length > 0 && (
        <details
          open={!text}
          className="mb-3 rounded border border-zinc-200 bg-zinc-50 p-2 text-xs dark:border-zinc-800 dark:bg-zinc-900"
        >
          <summary className="cursor-pointer font-medium">
            Sub-agent trace ({toolParts.length} step
            {toolParts.length === 1 ? "" : "s"})
          </summary>
          <ul className="mt-2 space-y-1">
            {toolParts.map((part) => (
              <TraceRow key={part.toolCallId} part={part} />
            ))}
          </ul>
        </details>
      )}

      {reasoning && (
        <details className="mb-3 rounded border border-amber-200 bg-amber-50 p-2 text-xs dark:border-amber-900/50 dark:bg-amber-950/30">
          <summary className="cursor-pointer font-medium">
            Planner&rsquo;s extended thinking (
            {reasoning.length.toLocaleString()} chars)
          </summary>
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap text-zinc-700 dark:text-zinc-300">
            {reasoning}
          </pre>
        </details>
      )}

      {text && (
        <div className="whitespace-pre-wrap text-sm leading-relaxed">
          {renderReportWithCitationLinks(text)}
        </div>
      )}

      {citations.length > 0 && (
        <section className="mt-4 border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Sources
          </h3>
          <ol className="space-y-1.5 text-xs">
            {citations.map((c) => (
              <li
                key={c.number}
                id={`cite-${c.number}`}
                className="text-zinc-700 dark:text-zinc-300"
              >
                <span className="mr-1 font-mono text-zinc-500">
                  [{c.number}]
                </span>
                {c.source_url ? (
                  <a
                    href={c.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-700 hover:underline dark:text-blue-400"
                  >
                    {c.title}
                  </a>
                ) : (
                  <span>{c.title}</span>
                )}
                {c.cited_text && (
                  <div className="ml-6 mt-0.5 italic text-zinc-500">
                    &ldquo;
                    {c.cited_text.slice(0, 200)}
                    {c.cited_text.length > 200 ? "…" : ""}
                    &rdquo;
                  </div>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

      {filename && (
        <div className="mt-3">
          <a
            href={`/api/research/download/${encodeURIComponent(filename)}`}
            download
            className="inline-flex items-center rounded border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-900 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-900"
          >
            Download report (.md)
          </a>
        </div>
      )}
    </article>
  );
}

function TraceRow({ part }: { part: ToolUIPart }) {
  const name = getToolName(part);
  const { label, color } = pillFor(part.state);
  const input = "input" in part ? part.input : undefined;
  const subQuery =
    name === "search" &&
    input &&
    typeof input === "object" &&
    "sub_query" in input
      ? String((input as { sub_query: unknown }).sub_query)
      : null;
  return (
    <li className="flex items-start gap-2">
      <span
        className={`mt-0.5 inline-block min-w-[64px] rounded px-2 py-0.5 text-center text-[10px] font-medium uppercase tracking-wide ${color}`}
      >
        {label}
      </span>
      <span className="text-zinc-700 dark:text-zinc-300">
        <strong className="font-medium">{name}</strong>
        {subQuery ? ` — ${subQuery}` : null}
      </span>
    </li>
  );
}

// Citation shape carried on the synth tool's output — kept in sync with
// the server-side `Citation` type in app/api/research/_types.ts.
type Citation = {
  number: number;
  source_url: string | null;
  title: string;
  cited_text: string;
};

// Turn literal "[N]" footnote markers in the report body into anchor links
// that scroll to the matching <li id="cite-N"> in the Sources section.
function renderReportWithCitationLinks(text: string) {
  const parts = text.split(/(\[\d+\])/g);
  return parts.map((part, i) => {
    const m = part.match(/^\[(\d+)\]$/);
    if (m) {
      return (
        <a
          key={i}
          href={`#cite-${m[1]}`}
          className="text-blue-700 no-underline hover:underline dark:text-blue-400"
        >
          {part}
        </a>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

function pillFor(state: ToolUIPart["state"]): {
  label: string;
  color: string;
} {
  switch (state) {
    case "input-streaming":
    case "input-available":
      return {
        label: "running",
        color:
          "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
      };
    case "output-available":
      return {
        label: "done",
        color:
          "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
      };
    case "output-error":
      return {
        label: "failed",
        color:
          "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
      };
    default:
      return {
        label: state,
        color: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
      };
  }
}
