"use client";

import { useState } from "react";

type SearcherSummary = {
  sub_query: string;
  status: "fulfilled" | "rejected";
  summary: string | null;
  error: string | null;
};

type ResearchResponse = {
  query: string;
  sub_queries: string[];
  plan_thinking?: string;
  searcher_summaries: SearcherSummary[];
  notes: Array<{ title: string; sub_query: string; source_url?: string }>;
  report: string;
  report_path: string;
};

export default function Home() {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ResearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `HTTP ${res.status}`);
      } else {
        setResult(data as ResearchResponse);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-12 font-sans">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">
          Research Orchestrator
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Planner (Sonnet, extended thinking) → parallel searcher sub-agents → synthesizer (Opus) → saved <code>.md</code> report.
        </p>
      </header>

      <form onSubmit={submit} className="space-y-3">
        <textarea
          className="w-full rounded border border-zinc-300 bg-white p-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          rows={3}
          placeholder="e.g. compare Pinecone vs Weaviate for hybrid search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={loading}
        />
        <button
          type="submit"
          disabled={loading || !query.trim()}
          className="rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {loading ? "Researching… (3-10 min)" : "Start research"}
        </button>
      </form>

      {error && (
        <div className="mt-6 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {error}
        </div>
      )}

      {result && (
        <section className="mt-8 space-y-6">
          {result.plan_thinking && (
            <details className="rounded border border-zinc-300 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-900">
              <summary className="cursor-pointer text-sm font-medium">
                Planner&rsquo;s extended thinking ({result.plan_thinking.length.toLocaleString()} chars)
              </summary>
              <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap text-xs text-zinc-700 dark:text-zinc-300">
                {result.plan_thinking}
              </pre>
            </details>
          )}

          <div>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">
              Sub-queries
            </h2>
            <ol className="list-decimal space-y-1 pl-5 text-sm">
              {result.sub_queries.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ol>
          </div>

          <div>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">
              Searchers ({result.searcher_summaries.filter((s) => s.status === "fulfilled").length}/{result.searcher_summaries.length} fulfilled · {result.notes.length} notes)
            </h2>
            <ul className="space-y-1 text-sm">
              {result.searcher_summaries.map((s, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span
                    className={
                      s.status === "fulfilled"
                        ? "mt-1 inline-block h-2 w-2 shrink-0 rounded-full bg-green-500"
                        : "mt-1 inline-block h-2 w-2 shrink-0 rounded-full bg-red-500"
                    }
                  />
                  <span className="text-zinc-700 dark:text-zinc-300">
                    {s.sub_query}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">
              Report
            </h2>
            <pre className="whitespace-pre-wrap rounded border border-zinc-200 bg-white p-4 text-sm leading-relaxed dark:border-zinc-800 dark:bg-zinc-950">
              {result.report}
            </pre>
            <p className="mt-2 text-xs text-zinc-500">
              Saved to <code>{result.report_path}</code>
            </p>
          </div>
        </section>
      )}
    </main>
  );
}
