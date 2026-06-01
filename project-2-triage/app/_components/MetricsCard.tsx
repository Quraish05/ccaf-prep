// Server Component. Renders eval pass-rate at the top of the page.
// Receives the parsed results JSON from page.tsx; null means the eval script
// hasn't run yet — degrade to a "not yet run" pill instead of blowing up.

import type { EvalResults } from "@/app/api/triage/_types";

export function MetricsCard({ results }: { results: EvalResults | null }) {
  if (!results) {
    return (
      <div className="rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3">
        <div className="text-xs uppercase tracking-wider text-zinc-500">
          Eval pass-rate
        </div>
        <div className="mt-1 text-zinc-400">
          Not yet run —{" "}
          <code className="text-zinc-300">evals/results.json</code> missing.
        </div>
      </div>
    );
  }

  const pct = Math.round(results.pass_rate * 100);
  const tone =
    pct >= 80
      ? "text-emerald-400 border-emerald-700"
      : pct >= 60
        ? "text-amber-400 border-amber-700"
        : "text-rose-400 border-rose-700";

  return (
    <div className={`rounded-lg border bg-zinc-900 px-4 py-3 ${tone}`}>
      <div className="flex items-center justify-between gap-6">
        <div>
          <div className="text-xs uppercase tracking-wider text-zinc-500">
            Eval pass-rate
          </div>
          <div className="mt-1 flex items-baseline gap-3">
            <span className="text-2xl font-semibold tabular-nums">
              {results.passed}/{results.total}
            </span>
            <span className="text-lg tabular-nums opacity-80">({pct}%)</span>
          </div>
        </div>
        <div className="text-right text-xs text-zinc-500">
          <div>
            <span className="text-zinc-400">model:</span> {results.model}
          </div>
          <div className="mt-0.5">
            <span className="text-zinc-400">ran:</span>{" "}
            {new Date(results.ran_at).toLocaleString()}
          </div>
        </div>
      </div>
    </div>
  );
}
