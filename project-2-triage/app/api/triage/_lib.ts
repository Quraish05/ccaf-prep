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
} from "./_types";

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

// Factory rather than module-scope singleton — McpServer + InMemoryTransport
// instances aren't safely re-entrant across concurrent requests (project-1
// learned this the hard way with parallel searchers sharing one server). A
// fresh server + transport pair per POST keeps each invocation isolated.
export function buildRefundsServer() {
  return createSdkMcpServer({
    name: "refunds",
    version: "1.0.0",
    tools: [
      tool(
        "issue_refund",
        "Issue a refund for a customer order. SENSITIVE: only call after classify_ticket returns 'refund_request' AND fetch_customer confirms refund_eligible=true.",
        {
          customer_id: z.string(),
          order_id: z.string(),
          amount_cents: z.number().int().positive(),
          reason: z.string(),
        },
        async (args) => {
          // Stub: a real impl would call Stripe / payment processor.
          const refundId = `rfd_${Math.random().toString(36).slice(2, 10)}`;
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  refund_id: refundId,
                  status: "issued",
                  ...args,
                }),
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
export async function connectRefundsClient(): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
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

// ---------------------------------------------------------------------------
// Tool schemas the model sees (both paths combined)
// ---------------------------------------------------------------------------
//
// cache_control on the last tool definition caches the tool list + system
// across loop turns (skill default). The 4096-token cache minimum on Opus 4.7
// means this won't actually hit until the agent loop accumulates context —
// the marker is correct placement, not an immediate win.
export const TOOLS: Anthropic.Tool[] = [
  {
    name: "classify_ticket",
    description:
      "Classify a support ticket into a category. Returns one of: refund_request, bug_report, question, other.",
    input_schema: {
      type: "object",
      properties: {
        ticket: { type: "string", description: "Raw ticket body text." },
      },
      required: ["ticket"],
    },
  },
  {
    name: "fetch_customer",
    description:
      "Fetch a customer record by id. Returns plan, lifetime value, and refund eligibility.",
    input_schema: {
      type: "object",
      properties: {
        customer_id: {
          type: "string",
          description: "Customer id (e.g. 'cus_001').",
        },
      },
      required: ["customer_id"],
    },
  },
  {
    name: "issue_refund",
    description:
      "Issue a refund. SENSITIVE: only call after classify_ticket says 'refund_request' and fetch_customer confirms refund_eligible=true. amount_cents MUST be <= 50000 (the $500 cap); larger amounts must be escalated, not refunded.",
    input_schema: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        order_id: { type: "string" },
        amount_cents: { type: "integer" },
        reason: { type: "string" },
      },
      required: ["customer_id", "order_id", "amount_cents", "reason"],
    },
  },
  // -------------------------------------------------------------------------
  // The structured-output tool. Forcing the final emit through this tool via
  // tool_choice: {type:"tool", name:"submit_triage_report"} is the canonical
  // "structured output" pattern: the tool's input_schema *is* the response
  // schema, and the model is required to produce arguments that satisfy it.
  // strict:true tells the API to enforce the schema server-side.
  // -------------------------------------------------------------------------
  {
    name: "submit_triage_report",
    description:
      "Submit the final triage report. Call this exactly ONCE, at the very end, after all other tools. This is the only acceptable way to conclude the interaction — the report's fields are the ticket's audit record.",
    input_schema: {
      type: "object",
      properties: {
        ticket_category: {
          type: "string",
          enum: ["refund_request", "bug_report", "question", "other"],
          description: "The category returned by classify_ticket.",
        },
        customer_id: {
          type: ["string", "null"],
          description:
            "Customer id if one was mentioned in the ticket, else null.",
        },
        action_taken: {
          type: "string",
          enum: [
            "refund_issued",
            "escalated",
            "answered",
            "closed_no_action",
          ],
          description: "What this triage run did with the ticket.",
        },
        refund: {
          anyOf: [
            {
              type: "object",
              properties: {
                refund_id: { type: "string" },
                amount_cents: { type: "integer" },
                reason: { type: "string" },
              },
              required: ["refund_id", "amount_cents", "reason"],
              additionalProperties: false,
            },
            { type: "null" },
          ],
          description:
            "Refund details when action_taken='refund_issued', else null. amount_cents MUST be <= 50000.",
        },
        escalation_reason: {
          type: ["string", "null"],
          description:
            "One short sentence stating why this was escalated. Required when action_taken='escalated'; null otherwise.",
        },
        summary: {
          type: "string",
          description: "One-paragraph audit summary for the support log.",
        },
      },
      required: [
        "ticket_category",
        "customer_id",
        "action_taken",
        "refund",
        "escalation_reason",
        "summary",
      ],
      additionalProperties: false,
    },
    strict: true,
    cache_control: { type: "ephemeral" },
  },
];

// Name pulled into a const so the forced-tool-choice call and the
// terminal-detection check in the route loop can't drift.
export const REPORT_TOOL = "submit_triage_report";

export const SYSTEM = `# Persona

You are Aria, a Tier 1 customer support triage agent for Acme Cloud. You handle routine tickets autonomously and escalate the rest to a human agent cleanly. You are concise, professional, and policy-bound: you do not improvise around the rules below.

# Order of operations

For every ticket, in this order:

1. Call \`classify_ticket\` on the raw ticket body.
2. If the category is \`refund_request\` and the ticket mentions a customer id, call \`fetch_customer\` to check eligibility.
3. Decide the action based on the policies below.
4. If issuing a refund, call \`issue_refund\` with sensible \`amount_cents\` and \`reason\`.
5. ALWAYS finish by calling \`submit_triage_report\` exactly once, with the structured outcome. This is the only acceptable way to end the interaction.

# Refund policy

- The maximum refund you are authorized to issue is **$500 USD (50_000 cents)**. Refunds at or below this cap are pre-approved when eligibility holds; refunds above this cap MUST be escalated, never issued.
- Issue a refund (via \`issue_refund\`) only when ALL of these hold:
  - \`classify_ticket\` returned \`refund_request\`
  - \`fetch_customer\` returned \`refund_eligible: true\`
  - The appropriate refund amount is ≤ 50_000 cents
  - The ticket names an order id (or one can be unambiguously inferred)
- If the customer didn't name a specific amount, infer a reasonable one from the ticket (typical order value) but never exceed the $500 cap.
- If the customer NAMES a specific amount > $500, escalate — do NOT issue a smaller "partial" refund as a workaround. The named amount is what they're asking for; partial refunds are unauthorized.

# Escalation policy

Set \`action_taken = "escalated"\` and populate \`escalation_reason\` when ANY of the following:

- The customer requests, or the situation warrants, a refund > $500.
- \`fetch_customer\` returned \`refund_eligible: false\`.
- The ticket is a refund_request but lacks both an order id and any way to infer one.
- The category is \`bug_report\`, or is \`other\` and the customer's intent is unclear.
- The customer expresses anger, threatens a chargeback or legal action, or explicitly asks for a human.

\`escalation_reason\` must be one short sentence (≤ 25 words) naming the specific trigger above.

# Final-output contract

The structured fields you submit via \`submit_triage_report\` are the ticket's audit record. They must be self-consistent:

- If \`action_taken = "refund_issued"\`, \`refund\` must be populated AND \`escalation_reason\` must be null.
- If \`action_taken = "escalated"\`, \`refund\` must be null AND \`escalation_reason\` must be non-null.
- For \`answered\` and \`closed_no_action\`, both \`refund\` and \`escalation_reason\` are null.
- \`summary\` is one short paragraph for the human reviewer — what you saw, what you did, why.`;

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
