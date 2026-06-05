// Shared helpers and constants for this folder.
//
// The triage agent exercises BOTH tool-definition paths in one loop:
//
//   Path A — inline SDK tools.  `classify_ticket` and `fetch_customer` are
//            declared in the `tools: [...]` array passed to messages.create.
//            When Claude emits a tool_use block, dispatchTool routes it to a
//            plain TS function in this file.
//
//   Path B — in-process MCP tool. `issue_refund` is registered with an MCP
//            server built via `createSdkMcpServer` from the Claude Agent SDK,
//            wired to an MCP Client through `InMemoryTransport`. Its schema is
//            mirrored into `tools: [...]` so Claude sees it the same way as
//            the inline tools, but when it's called the invocation round-trips
//            through the MCP transport (real JSON-RPC, just over an in-memory
//            pipe).
//
// The point isn't that one path is better — both surfaces the model the same
// way. The point is to feel the difference at the dispatch site so the CCA-F
// surface area (raw SDK tool defs + in-process MCP) lives in one folder.

import { appendFile } from "node:fs/promises";
import path from "node:path";

import Anthropic from "@anthropic-ai/sdk";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import type {
  AuditRecord,
  Customer,
  HookBlock,
  PreToolUseHook,
  RefundRecord,
  RefundsClientHandle,
  RetryFallbackOptions,
  RetryFallbackResult,
} from "./_types";
import { REPORT_TOOL } from "./_prompt";

// ---------------------------------------------------------------------------
// Path A — inline tool handlers
// ---------------------------------------------------------------------------

// Keyword classifier — stub. A real impl would call out to a classification
// model or rule engine; the shape (string in, string-enum out) is what matters
// for the agent loop.
//
// Patterns cover common inflections (crash/crashes/crashed, error/errors,
// bug/bugs, refund/refunds, reimburse(d|ment)) so the regex doesn't miss the
// obvious-shaped cases. The question regex covers "how / where / what / why"
// openers — the dominant shapes in the eval fixture.
export function classifyTicket(args: { ticket: string }): string {
  const t = args.ticket.toLowerCase();

  if (/\b(refunds?|money back|chargebacks?|reimburse(d|ment)?)\b/.test(t)) {
    return "refund_request";
  }

  if (
    /\b(bugs?|errors?|crash(es|ed|ing)?|broke(n)?|fail(s|ed|ing)?|not working|exception|stack trace)\b/.test(
      t,
    )
  ) {
    return "bug_report";
  }

  if (
    /\b(how (do|can|should) (i|we|you)|where (can|is|do) (i|we)|what'?s the (difference|best|easiest)|what is|why (does|is)|do you (support|have))\b/.test(
      t,
    )
  ) {
    return "question";
  }

  return "other";
}

// Fake customer lookup. Returns a deterministic record per id so the agent
// has something stable to reason about across the loop.
export function fetchCustomer(args: { customer_id: string }): Customer {
  const id = args.customer_id;
  return {
    id,
    name: id === "cus_001" ? "Acme Corp" : `Customer ${id}`,
    plan: "pro",
    lifetime_value_cents: 240_000,
    refund_eligible: true,
  };
}

// ---------------------------------------------------------------------------
// Redaction hook — strip PCI card numbers from any tool argument before it
// reaches an observability record (toolCalls, hookBlocks, response payload).
// ---------------------------------------------------------------------------
//
// PCI requires that primary account numbers (PANs) never appear in logs.
// In this route, "logs" = the JSON response and the in-memory records that
// feed it (toolCalls, hookBlocks). The redactor is a pure function used at
// every capture site — same data, redacted before storage.
//
// Detection is regex + Luhn: any 13-19 digit run with optional space/hyphen
// separators is a CANDIDATE; only candidates whose digits Luhn-validate get
// replaced. Luhn keeps false positives off non-card numerics (timestamps,
// long order IDs, tracking numbers).

// 13-19 digits with optional space/hyphen separators; \b anchors stop the
// match from leaking into adjacent word characters.
const CARD_NUMBER_REGEX = /\b(?:\d[ -]?){13,19}\b/g;

function isLuhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// Recursively replaces every Luhn-valid 13-19 digit sequence inside `value`
// with the literal "[REDACTED CARD]". Strings, arrays, and plain objects are
// walked; primitives pass through untouched. Returns a NEW value — does not
// mutate the input.
export function redactCardNumbers(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(CARD_NUMBER_REGEX, (match) => {
      const digits = match.replace(/[ -]/g, "");
      if (digits.length < 13 || digits.length > 19) return match;
      if (!isLuhnValid(digits)) return match;
      return "[REDACTED CARD]";
    });
  }
  if (Array.isArray(value)) return value.map(redactCardNumbers);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactCardNumbers(v);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// PreToolUse hook — deterministic refund-cap guard
// ---------------------------------------------------------------------------
//
// Defense-in-depth on top of the system prompt's $500 cap. The system prompt
// asks the model nicely; this hook makes the cap a hard rule the route
// enforces regardless of what the model emits. Same shape project-1 used:
// a *factory* that closes over a `blocks` array so denials are observable
// from the caller without parsing message internals.
//
// In the Claude Agent SDK this would be registered as
//   hooks: { PreToolUse: [{ hooks: [hook] }] }
// on the query() options. The triage route uses the raw SDK with a manual
// tool loop, so it calls the hook itself at the dispatch site — same contract,
// different transport.

export const REFUND_CAP_CENTS = 50_000;

export function buildRefundCapHook(blocks: HookBlock[]): PreToolUseHook {
  return ({ tool_name, tool_input }) => {
    if (tool_name !== "issue_refund") return { decision: "allow" };

    const amount = tool_input.amount_cents;
    if (typeof amount !== "number" || !Number.isFinite(amount)) {
      const reason = `[refund-cap guard] issue_refund blocked: amount_cents is missing or not a number. Conclude this triage by calling submit_triage_report with action_taken="escalated" and an escalation_reason explaining that the refund could not be processed automatically and needs human approval. Do not retry issue_refund.`;
      blocks.push({
        tool_name,
        reason,
        input: redactCardNumbers(tool_input) as Record<string, unknown>,
      });
      return { decision: "deny", reason };
    }

    if (amount > REFUND_CAP_CENTS) {
      const reason = `[refund-cap guard] issue_refund blocked: amount_cents=${amount} exceeds the $500 cap (${REFUND_CAP_CENTS}). DO NOT retry issue_refund with a different amount. Conclude this triage by calling submit_triage_report with action_taken="escalated" and an escalation_reason explicitly citing the $500 cap — this refund needs human approval.`;
      blocks.push({
        tool_name,
        reason,
        input: redactCardNumbers(tool_input) as Record<string, unknown>,
      });
      return { decision: "deny", reason };
    }

    return { decision: "allow" };
  };
}

// ---------------------------------------------------------------------------
// Path B — in-process MCP server hosting `issue_refund`
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Idempotency store for issue_refund
// ---------------------------------------------------------------------------
//
// Module-scope Map keyed by `${customer_id}|${order_id}`. The MCP server
// itself is built per-request (re-entrancy concerns — see project-1
// lesson), but the idempotency store HAS to persist across requests for
// the dedup to be useful: two POST /api/triage calls for the same order
// must return the same refund_id. Survives process lifetime; restart
// clears the dedup state (acceptable for the demo — a real implementation
// would persist this to a payments-processor-side idempotency key store,
// not in-memory).
//
// In a production refund flow you'd also pass an Idempotency-Key header
// to the downstream payment provider (Stripe, etc.) so the SAME refund
// request goes through at most once even if the network drops between
// here and them. The two layers compose: this Map dedupes inside our
// process; the provider's Idempotency-Key dedupes across the network.

const refundIdempotency = new Map<string, RefundRecord>();

// Factory rather than module-scope singleton — McpServer + InMemoryTransport
// instances aren't safely re-entrant across concurrent requests (project-1
// learned this the hard way with parallel searchers sharing one server). A
// fresh server + transport pair per POST keeps each invocation isolated.
// The idempotency store ABOVE stays at module scope so dedup spans requests.
export function buildRefundsServer() {
  return createSdkMcpServer({
    name: "refunds",
    version: "1.0.0",
    tools: [
      tool(
        "issue_refund",
        "Issue a refund for a customer order. SENSITIVE: only call after classify_ticket returns 'refund_request' AND fetch_customer confirms refund_eligible=true. Idempotent on (customer_id, order_id) — calling twice for the same order returns the same refund_id with status='already_issued' rather than issuing two refunds.",
        {
          customer_id: z.string(),
          order_id: z.string(),
          amount_cents: z.number().int().positive(),
          reason: z.string(),
        },
        async (args) => {
          const key = `${args.customer_id}|${args.order_id}`;
          const existing = refundIdempotency.get(key);
          if (existing) {
            // Idempotent return — same refund_id, flagged so the agent
            // knows this was a retry rather than a fresh issuance.
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    ...existing,
                    status: "already_issued",
                    note: "Idempotent return: a refund for this (customer_id, order_id) was already issued. Returning the original refund_id.",
                  }),
                },
              ],
            };
          }

          // First time — issue + store.
          const record: RefundRecord = {
            refund_id: `rfd_${Math.random().toString(36).slice(2, 10)}`,
            amount_cents: args.amount_cents,
            reason: args.reason,
            issued_at: new Date().toISOString(),
            customer_id: args.customer_id,
            order_id: args.order_id,
          };
          refundIdempotency.set(key, record);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ ...record, status: "issued" }),
              },
            ],
          };
        },
      ),
    ],
  });
}

// Open an MCP client connected to a fresh refunds server over the in-memory
// transport pair. Returns the client and a cleanup fn the route can defer.
export async function connectRefundsClient(): Promise<RefundsClientHandle> {
  const server = buildRefundsServer();
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport);

  const client = new Client({ name: "triage-agent", version: "1.0.0" });
  await client.connect(clientTransport);

  return {
    client,
    close: async () => {
      await client.close();
      await server.instance.close();
    },
  };
}

// TOOLS / REPORT_TOOL / SYSTEM live in ./_prompt — the model-facing
// surface of the agent. _lib.ts keeps the runtime helpers below.

// ---------------------------------------------------------------------------
// Dispatch a tool_use block to the right path
// ---------------------------------------------------------------------------

export async function dispatchTool(
  name: string,
  input: Record<string, unknown>,
  mcp: Client,
): Promise<string> {
  switch (name) {
    case "classify_ticket":
      return classifyTicket(input as { ticket: string });

    case "fetch_customer":
      return JSON.stringify(fetchCustomer(input as { customer_id: string }));

    case "issue_refund": {
      // Round-trip the call through the MCP transport rather than calling the
      // handler directly. The model sees an identical tool_use block; the
      // dispatch site is where the two paths diverge.
      const result = await mcp.callTool({ name, arguments: input });
      const blocks = (result.content ?? []) as Array<{
        type: string;
        text?: string;
      }>;
      return blocks
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text!)
        .join("\n");
    }

    case REPORT_TOOL:
      // submit_triage_report is terminal — the route loop checks for it before
      // dispatching, so we should never reach this branch. Throw rather than
      // dispatch so a mistake is loud.
      throw new Error(
        `${REPORT_TOOL} is terminal and must be handled by the loop, not dispatched`,
      );

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export const MAX_TURNS = 10;

// ---------------------------------------------------------------------------
// Audit log — append-only JSONL stream for the AuditLog UI (SSE-tailed)
// ---------------------------------------------------------------------------
//
// The route calls appendAudit at every tool-call site AFTER the input has been
// run through redactCardNumbers, so the file on disk is already PCI-clean.
// The UI's <AuditLog> opens an EventSource against /api/audit/stream which
// tails this same file — the file IS the source of truth, not the response
// JSON, so what shows up in the log is exactly what got persisted.

export const AUDIT_LOG_PATH = path.join(process.cwd(), "audit.jsonl");

export async function appendAudit(record: AuditRecord): Promise<void> {
  try {
    await appendFile(AUDIT_LOG_PATH, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // Audit logging is best-effort — never let a disk error fail the triage.
  }
}

// ---------------------------------------------------------------------------
// Retry + model-fallback wrapper for messages.create
// ---------------------------------------------------------------------------
//
// Layered on top of the SDK's built-in retry to add:
//   - Observable retry behaviour (we control + log each attempt).
//   - Chain-style model fallback. The SDK retries the SAME model; this
//     wrapper exhausts retries on the primary, then falls to the next
//     model in the chain. Useful when a specific model tier is saturated.
//   - Caller-supplied idempotency_key on each attempt so retries of the
//     SAME logical call dedupe at the API.
//
// Only retries 429 (RateLimitError) and 529 (APIError with status === 529 —
// the SDK doesn't ship a dedicated OverloadedError class). Other errors
// bubble immediately — retrying 4xx auth/schema bugs wastes spend and
// delays the real error from reaching the caller.

// Haiku-first per the project's cost preference (Haiku-for-project-APIs).
// Sonnet sits in the chain as the *fallback* for burst-overload spikes —
// if Haiku rate-limits, traffic spills up to Sonnet rather than failing.
// "Fall up under spike load" inverts the textbook Sonnet → Haiku graceful-
// degradation pattern, but matches this project's traffic shape: most
// triage calls are well within Haiku's headroom, and the rare overload
// is what the fallback is for.
const DEFAULT_MODEL_CHAIN = ["claude-haiku-4-5", "claude-sonnet-4-6"] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function callWithRetryAndFallback(
  anthropic: Anthropic,
  params: Omit<Anthropic.MessageCreateParamsNonStreaming, "model">,
  options: RetryFallbackOptions = {},
): Promise<RetryFallbackResult> {
  const modelChain = options.modelChain ?? DEFAULT_MODEL_CHAIN;
  const maxAttempts = options.maxAttemptsPerModel ?? 3;
  const initialBackoff = options.initialBackoffMs ?? 1000;
  const maxBackoff = options.maxBackoffMs ?? 30_000;
  const idempotencyKey = options.idempotencyKey;

  const retryLog: RetryFallbackResult["retryLog"] = [];

  for (const model of modelChain) {
    let backoff = initialBackoff;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const message = await anthropic.messages.create(
          { ...params, model },
          idempotencyKey ? { idempotencyKey } : undefined,
        );
        return { message, modelUsed: model, attemptsUsed: attempt, retryLog };
      } catch (err) {
        // 429 has a dedicated class; 529 (overloaded) surfaces as a generic
        // APIError with .status === 529. Check both.
        const isRateLimit = err instanceof Anthropic.RateLimitError;
        const isOverloaded =
          err instanceof Anthropic.APIError && err.status === 529;
        if (!isRateLimit && !isOverloaded) {
          throw err;
        }

        const errMsg = err instanceof Error ? err.message : String(err);
        retryLog.push({ model, attempt, error: errMsg, backoff_ms: backoff });

        if (attempt < maxAttempts) {
          await sleep(backoff);
          backoff = Math.min(backoff * 2, maxBackoff);
          continue;
        }
        // Attempts exhausted on this model — fall through to next model
        // in the chain. The outer loop resets `backoff` + `attempt`.
        break;
      }
    }
  }

  // Every model in the chain was exhausted by 429/529.
  const summary = retryLog
    .map((r) => `${r.model}#${r.attempt}: ${r.error}`)
    .join(" | ");
  throw new Error(
    `All ${modelChain.length} model(s) in the chain exhausted after retries. Last errors: ${summary}`,
  );
}

