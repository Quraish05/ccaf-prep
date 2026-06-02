// Server Component. Reads the fixture and eval results from disk, hands them
// to the client-side <TriageInbox> and server-side <MetricsCard>. The audit
// log at the bottom is a self-contained client component that opens its own
// SSE stream against /api/audit/stream.

import { promises as fs } from "node:fs";
import path from "node:path";

import { AuditLog } from "@/app/_components/AuditLog";
import { MetricsCard } from "@/app/_components/MetricsCard";
import { TriageInbox } from "@/app/_components/TriageInbox";
import type {
  EvalResults,
  TicketFixtureItem,
} from "@/app/api/triage/_types";

// Force a fresh read on every request — the eval script writes to results.json
// between page loads, and we want the metric to reflect the latest run.
export const dynamic = "force-dynamic";

type FixtureFile = {
  items: TicketFixtureItem[];
};

async function loadFixture(): Promise<TicketFixtureItem[]> {
  const file = path.join(process.cwd(), "evals", "triage-tickets.json");
  const raw = await fs.readFile(file, "utf8");
  const parsed = JSON.parse(raw) as FixtureFile;
  return parsed.items;
}

async function loadEvalResults(): Promise<EvalResults | null> {
  const file = path.join(process.cwd(), "evals", "results.json");
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as EvalResults;
  } catch {
    return null;
  }
}

export default async function Page() {
  const [tickets, results] = await Promise.all([
    loadFixture(),
    loadEvalResults(),
  ]);

  return (
    <main className="mx-auto min-h-screen max-w-6xl space-y-4 bg-black p-6 font-sans text-zinc-200">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">
            Triage inbox
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Project 2 · <code className="text-zinc-400">/api/triage</code> ·
            Haiku · in-process MCP + PreToolUse cap-guard + PCI redaction
          </p>
        </div>
        <a
          href="/api/triage"
          className="text-xs text-zinc-600 hover:text-zinc-400"
        >
          POST /api/triage
        </a>
      </header>

      <MetricsCard results={results} />

      <TriageInbox tickets={tickets} />

      <AuditLog />
    </main>
  );
}
