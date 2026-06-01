// SSE endpoint that tails audit.jsonl for the <AuditLog> UI.
//
// On connect: stream the last 50 lines as backlog, then poll the file every
// 500ms and emit any new lines as they're appended by the triage route. The
// file is the source of truth — what the UI shows is exactly what got
// persisted, after redactCardNumbers ran. That's the redaction proof.

import { promises as fs } from "node:fs";

import { AUDIT_LOG_PATH } from "@/app/api/triage/_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const POLL_MS = 500;
const BACKLOG_LINES = 50;

const enc = new TextEncoder();
const sse = (data: string) => enc.encode(`data: ${data}\n\n`);
const sseComment = (msg: string) => enc.encode(`: ${msg}\n\n`);

export async function GET() {
  let interval: NodeJS.Timeout | null = null;
  let cancelled = false;
  let lastSize = 0;

  const stream = new ReadableStream({
    async start(controller) {
      // 1) Backlog — last BACKLOG_LINES non-empty lines.
      try {
        const existing = await fs.readFile(AUDIT_LOG_PATH, "utf8");
        const lines = existing.split("\n").filter(Boolean);
        const tail = lines.slice(-BACKLOG_LINES);
        for (const line of tail) controller.enqueue(sse(line));
        lastSize = Buffer.byteLength(existing, "utf8");
      } catch {
        // File doesn't exist yet (no triage has run). That's fine —
        // tailing will catch the first write.
        lastSize = 0;
      }

      // Open marker so the client knows the stream is live even before
      // the first new line arrives.
      controller.enqueue(sseComment("audit-stream open"));

      // 2) Tail — poll the file size; on growth, read the new bytes and
      // emit each line.
      interval = setInterval(async () => {
        if (cancelled) return;
        try {
          const stat = await fs.stat(AUDIT_LOG_PATH);
          if (stat.size <= lastSize) return;

          const fd = await fs.open(AUDIT_LOG_PATH, "r");
          try {
            const buf = Buffer.alloc(stat.size - lastSize);
            await fd.read(buf, 0, buf.length, lastSize);
            const text = buf.toString("utf8");
            const newLines = text.split("\n").filter(Boolean);
            for (const line of newLines) controller.enqueue(sse(line));
            lastSize = stat.size;
          } finally {
            await fd.close();
          }
        } catch {
          // File deleted, transient I/O error — keep polling, recover on
          // the next tick.
        }
      }, POLL_MS);
    },
    cancel() {
      cancelled = true;
      if (interval) clearInterval(interval);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
