"use client";

// Two-column layout:
//   left  — ticket list (selectable)
//   right — selected ticket: editable text + image + Triage button + result
//
// The textarea is editable so you can paste a card number to see PCI
// redaction surface in the AuditLog at the bottom of the page.

import { useState } from "react";

import type { TicketFixtureItem } from "@/app/api/triage/_types";

type TriageResult = {
  report?: {
    ticket_category: string;
    customer_id: string | null;
    action_taken: "refund_issued" | "escalated" | "answered" | "closed_no_action";
    refund: { refund_id: string; amount_cents: number; reason: string } | null;
    escalation_reason: string | null;
    summary: string;
  };
  tool_calls?: Array<{
    path: "inline" | "mcp" | "hook-denied";
    name: string;
    input: unknown;
    output: string;
  }>;
  hook_blocks?: Array<{
    tool_name: string;
    reason: string;
    input: Record<string, unknown>;
  }>;
  turns?: number;
  forced_recovery?: boolean;
  error?: string;
};

export function TriageInbox({ tickets }: { tickets: TicketFixtureItem[] }) {
  const [selectedId, setSelectedId] = useState<number>(tickets[0]?.id ?? 0);
  const [draft, setDraft] = useState<string>(tickets[0]?.ticket ?? "");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TriageResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selected = tickets.find((t) => t.id === selectedId) ?? tickets[0];

  const selectTicket = (t: TicketFixtureItem) => {
    setSelectedId(t.id);
    setDraft(t.ticket);
    setResult(null);
    setError(null);
  };

  const runTriage = async () => {
    setLoading(true);
    setResult(null);
    setError(null);
    try {
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket: draft }),
      });
      const data: TriageResult = await res.json();
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
      } else {
        setResult(data);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="grid grid-cols-[280px_1fr] gap-4">
      {/* Left rail — ticket list */}
      <div className="overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950">
        <div className="border-b border-zinc-800 px-3 py-2 text-xs uppercase tracking-wider text-zinc-500">
          Tickets ({tickets.length})
        </div>
        <ul className="divide-y divide-zinc-900">
          {tickets.map((t) => {
            const isSelected = t.id === selectedId;
            return (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => selectTicket(t)}
                  className={`block w-full px-3 py-2 text-left text-sm transition-colors ${
                    isSelected
                      ? "bg-zinc-800 text-zinc-100"
                      : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs tabular-nums text-zinc-500">
                      #{t.id}
                    </span>
                    {t.image_url ? (
                      <span title="has image attachment">🖼️</span>
                    ) : null}
                  </div>
                  <div className="mt-0.5 line-clamp-2 text-xs">
                    {t.ticket.slice(0, 90)}
                  </div>
                  <div className="mt-1 text-[10px] uppercase tracking-wider text-zinc-600">
                    {t.expected_category} → {t.expected_action}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Right pane — selected ticket + triage */}
      <div className="space-y-3">
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-xs uppercase tracking-wider text-zinc-500">
              Ticket #{selected.id} ·{" "}
              <span className="text-zinc-400">{selected.expected_category}</span>{" "}
              <span className="text-zinc-600">→</span>{" "}
              <span className="text-zinc-400">{selected.expected_action}</span>
            </div>
            <button
              type="button"
              onClick={runTriage}
              disabled={loading || !draft.trim()}
              className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? "Triaging…" : "Triage"}
            </button>
          </div>

          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={4}
            className="w-full resize-y rounded border border-zinc-800 bg-zinc-900 p-2 text-sm text-zinc-200 focus:border-zinc-600 focus:outline-none"
          />

          {selected.image_url ? (
            <div className="mt-3">
              <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
                Attached image
              </div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={selected.image_url}
                alt={`Attachment for ticket #${selected.id}`}
                className="max-h-48 rounded border border-zinc-800"
                onError={(e) => {
                  // Placeholder URLs from the fixture won't resolve in dev.
                  // Replace the broken image with a labelled stand-in so the
                  // layout doesn't break.
                  e.currentTarget.outerHTML = `<div class="rounded border border-dashed border-zinc-700 bg-zinc-900 p-3 text-xs text-zinc-500">[image placeholder] ${selected.image_url}</div>`;
                }}
              />
            </div>
          ) : null}

          {selected.notes ? (
            <div className="mt-3 rounded border border-zinc-800 bg-zinc-900 p-2 text-xs text-zinc-400">
              <span className="text-zinc-500">Fixture note:</span>{" "}
              {selected.notes}
            </div>
          ) : null}

          <p className="mt-2 text-[11px] text-zinc-500">
            Tip: paste a card number (e.g. <code>4242 4242 4242 4242</code>) into
            the ticket text and hit Triage — watch the AuditLog at the bottom of
            the page redact it to <code>[REDACTED CARD]</code>.
          </p>
        </div>

        {/* Result card */}
        {error ? (
          <div className="rounded-lg border border-rose-700 bg-rose-950 p-3 text-sm text-rose-300">
            <div className="text-xs uppercase tracking-wider text-rose-400">
              Error
            </div>
            <div className="mt-1 font-mono">{error}</div>
          </div>
        ) : null}

        {result?.hook_blocks && result.hook_blocks.length > 0 ? (
          <div className="rounded-lg border border-rose-700 bg-rose-950 p-3">
            <div className="text-xs uppercase tracking-wider text-rose-400">
              Policy hook fired — {result.hook_blocks.length} block(s)
            </div>
            <ul className="mt-2 space-y-2">
              {result.hook_blocks.map((b, i) => (
                <li key={i} className="text-sm text-rose-200">
                  <div className="font-medium">
                    refund-cap · {b.tool_name}
                  </div>
                  <div className="mt-0.5 text-xs text-rose-300/80">
                    {b.reason}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {result?.report ? (
          <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
            <div className="flex items-center justify-between">
              <div className="text-xs uppercase tracking-wider text-zinc-500">
                Triage report
              </div>
              <div className="flex items-center gap-2 text-[10px] text-zinc-500">
                <span>turns: {result.turns}</span>
                {result.forced_recovery ? (
                  <span className="rounded bg-amber-900 px-1.5 py-0.5 text-amber-200">
                    forced recovery
                  </span>
                ) : null}
              </div>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
              <ReportField label="category" value={result.report.ticket_category} />
              <ReportField
                label="action_taken"
                value={result.report.action_taken}
                tone={
                  result.report.action_taken === "refund_issued"
                    ? "emerald"
                    : result.report.action_taken === "escalated"
                      ? "amber"
                      : "zinc"
                }
              />
              <ReportField
                label="customer_id"
                value={result.report.customer_id ?? "—"}
              />
              <ReportField
                label="refund"
                value={
                  result.report.refund
                    ? `$${(result.report.refund.amount_cents / 100).toFixed(2)} (${result.report.refund.refund_id})`
                    : "—"
                }
              />
              {result.report.escalation_reason ? (
                <div className="col-span-2 rounded border border-amber-700 bg-amber-950 p-2">
                  <div className="text-[10px] uppercase tracking-wider text-amber-400">
                    escalation_reason
                  </div>
                  <div className="mt-0.5 text-sm text-amber-200">
                    {result.report.escalation_reason}
                  </div>
                </div>
              ) : null}
            </div>

            <div className="mt-3">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500">
                summary
              </div>
              <p className="mt-1 text-sm text-zinc-300">
                {result.report.summary}
              </p>
            </div>

            {result.tool_calls && result.tool_calls.length > 0 ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-300">
                  tool calls ({result.tool_calls.length})
                </summary>
                <ul className="mt-2 space-y-1 text-xs">
                  {result.tool_calls.map((c, i) => (
                    <li
                      key={i}
                      className="flex items-center gap-2 font-mono text-zinc-400"
                    >
                      <span
                        className={`rounded px-1.5 py-0.5 text-[9px] uppercase ${
                          c.path === "mcp"
                            ? "bg-purple-900 text-purple-200"
                            : c.path === "hook-denied"
                              ? "bg-rose-900 text-rose-200"
                              : "bg-zinc-800 text-zinc-300"
                        }`}
                      >
                        {c.path}
                      </span>
                      <span className="text-zinc-300">{c.name}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ReportField({
  label,
  value,
  tone = "zinc",
}: {
  label: string;
  value: string;
  tone?: "zinc" | "emerald" | "amber";
}) {
  const toneClass =
    tone === "emerald"
      ? "text-emerald-300"
      : tone === "amber"
        ? "text-amber-300"
        : "text-zinc-200";
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900 p-2">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">
        {label}
      </div>
      <div className={`mt-0.5 font-mono text-sm ${toneClass}`}>{value}</div>
    </div>
  );
}
