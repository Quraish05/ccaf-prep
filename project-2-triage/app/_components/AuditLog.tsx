"use client";

// Collapsible audit log at the bottom of the page. Subscribes to
// /api/audit/stream via EventSource and renders each JSONL line as it arrives.
// The line on the wire IS the line on disk — redactCardNumbers has already
// run by the time anything reaches this UI.

import { useEffect, useRef, useState } from "react";

import type { AuditRecord } from "@/app/api/triage/_types";

const MAX_RECORDS = 200;

export function AuditLog() {
  const [open, setOpen] = useState(true);
  const [records, setRecords] = useState<AuditRecord[]>([]);
  const [connected, setConnected] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const source = new EventSource("/api/audit/stream");

    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (e) => {
      try {
        const record = JSON.parse(e.data) as AuditRecord;
        setRecords((prev) => {
          const next = [...prev, record];
          return next.length > MAX_RECORDS
            ? next.slice(-MAX_RECORDS)
            : next;
        });
      } catch {
        // Malformed line — skip.
      }
    };

    return () => source.close();
  }, []);

  // Auto-scroll to bottom as new records arrive, unless the user scrolled up.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !open) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (isNearBottom) el.scrollTop = el.scrollHeight;
  }, [records, open]);

  const hookBlockCount = records.filter((r) => r.kind === "hook_block").length;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-2 text-left text-sm hover:bg-zinc-900"
      >
        <div className="flex items-center gap-3">
          <span className="text-xs uppercase tracking-wider text-zinc-500">
            Audit log
          </span>
          <span
            className={`h-2 w-2 rounded-full ${
              connected ? "bg-emerald-500" : "bg-zinc-600"
            }`}
            title={connected ? "SSE connected" : "SSE disconnected"}
          />
          <span className="text-xs text-zinc-400">
            {records.length} record{records.length === 1 ? "" : "s"}
          </span>
          {hookBlockCount > 0 ? (
            <span className="rounded bg-rose-900 px-1.5 py-0.5 text-[10px] text-rose-200">
              {hookBlockCount} blocked
            </span>
          ) : null}
        </div>
        <span className="text-xs text-zinc-500">{open ? "▼" : "▶"}</span>
      </button>

      {open ? (
        <div
          ref={containerRef}
          className="max-h-72 overflow-y-auto border-t border-zinc-800 font-mono text-xs"
        >
          {records.length === 0 ? (
            <div className="px-4 py-3 text-zinc-500">
              No audit records yet. Run a triage to see entries appear here.
            </div>
          ) : (
            <ul className="divide-y divide-zinc-900">
              {records.map((r, i) => (
                <AuditRow key={i} record={r} />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

function AuditRow({ record }: { record: AuditRecord }) {
  const isBlock = record.kind === "hook_block";
  const pathBadge =
    record.path === "mcp"
      ? "bg-purple-900 text-purple-200"
      : record.path === "hook-denied"
        ? "bg-rose-900 text-rose-200"
        : "bg-zinc-800 text-zinc-300";

  return (
    <li
      className={`px-3 py-2 ${
        isBlock ? "bg-rose-950/40" : "hover:bg-zinc-900/60"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="text-zinc-600">
          {new Date(record.ts).toLocaleTimeString()}
        </span>
        <span
          className={`rounded px-1.5 py-0.5 text-[9px] uppercase ${pathBadge}`}
        >
          {record.path ?? record.kind}
        </span>
        <span className="text-zinc-200">{record.tool}</span>
        {record.hook ? (
          <span className="text-rose-300">[{record.hook}]</span>
        ) : null}
        <span className="ml-auto text-[10px] text-zinc-600">
          req:{record.request_id.slice(0, 8)}
        </span>
      </div>

      {record.reason ? (
        <div className="mt-1 text-rose-300">{record.reason}</div>
      ) : null}

      {record.input !== undefined ? (
        <div className="mt-1 text-zinc-400">
          <span className="text-zinc-600">input:</span>{" "}
          {JSON.stringify(record.input)}
        </div>
      ) : null}

      {record.output_preview ? (
        <div className="mt-0.5 text-zinc-500">
          <span className="text-zinc-600">output:</span>{" "}
          {record.output_preview}
          {record.output_preview.length >= 200 ? "…" : ""}
        </div>
      ) : null}
    </li>
  );
}
