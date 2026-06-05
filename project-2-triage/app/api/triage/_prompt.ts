// Model-facing surface for the triage agent — what gets sent to
// messages.create on every call. Three pieces:
//
//   1. TOOLS — the schema list the model sees (4 tools, including the
//      strict-mode submit_triage_report that doubles as the structured
//      output sink).
//   2. SYSTEM — the system prompt: persona, order-of-operations, refund
//      policy, escalation policy, final-output contract.
//   3. REPORT_TOOL — the name of the terminal tool, pulled into a const
//      so the route loop's terminal-detection and the forced-tool_choice
//      can't drift from TOOLS' name field.
//
// Lives in its own file rather than _lib.ts so the agent's "identity"
// (what it sees + what it does) is one grep away. _lib.ts keeps the
// runtime helpers (dispatch, hooks, MCP wiring, retry); operational
// tuning (MAX_TURNS, REFUND_CAP_CENTS, DEFAULT_MODEL_CHAIN) stays there
// too — those are knobs the operator turns, not part of the prompt.

import type Anthropic from "@anthropic-ai/sdk";

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
          enum: ["refund_issued", "escalated", "answered", "closed_no_action"],
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
