// Eval harness for /api/triage.
//
// Loads evals/triage-tickets.json, fetches /api/triage per item (same dev
// server — uses the incoming request's origin), and rule-scores each
// returned report on three axes:
//
//   (a) routing  — report.ticket_category === expected_category
//   (b) action   — report.action_taken === expected_action
//   (c) policy   — internal consistency of the structured output against
//                  the system prompt's "Final-output contract": refund
//                  presence matches action, no >$500 refund slips past
//                  the hook, refund_issued requires category=refund_request,
//                  etc.
//
// An item passes only if all three axes are clean. Body accepts an optional
// { ids: number[] } to re-run a subset cheaply during prompt iteration.
// Target threshold: 12/15.

import { promises as fs } from "node:fs";
import path from "node:path";

export const runtime = "nodejs";
export const maxDuration = 600;

type Ticket = {
  id: number;
  ticket: string;
  image_url?: string;
  expected_category: "refund_request" | "bug_report" | "question" | "other";
  expected_action:
    | "refund_issued"
    | "escalated"
    | "answered"
    | "closed_no_action";
  notes?: string;
};

type Fixture = {
  policy_anchors: { refund_cap_cents: number };
  items: Ticket[];
};

type TriageReport = {
  ticket_category?: string;
  customer_id?: string | null;
  action_taken?: string;
  refund?: { refund_id: string; amount_cents: number; reason: string } | null;
  escalation_reason?: string | null;
  summary?: string;
};

type TriageResponse = {
  report?: TriageReport;
  tool_calls?: Array<{
    path: "inline" | "mcp" | "hook-denied";
    name: string;
    input: unknown;
    output: string;
  }>;
  hook_blocks?: unknown[];
  turns?: number;
  forced_recovery?: boolean;
  error?: string;
};

type ItemResult = {
  id: number;
  expected_category: string;
  expected_action: string;
  actual_category: string | null;
  actual_action: string | null;
  correct_category: boolean;
  correct_action: boolean;
  violations: string[];
  passed: boolean;
  forced_recovery?: boolean;
  turns?: number;
  error?: string;
};

async function loadFixture(): Promise<Fixture> {
  const p = path.join(process.cwd(), "evals", "triage-tickets.json");
  return JSON.parse(await fs.readFile(p, "utf8")) as Fixture;
}

function score(item: Ticket, resp: TriageResponse, cap: number): ItemResult {
  const r = resp.report ?? {};
  const cat = r.ticket_category ?? null;
  const act = r.action_taken ?? null;

  const violations: string[] = [];

  // (c1) Refund cap — should never leak past the hook, but verify any
  //      successfully-dispatched issue_refund call respected the $500 cap.
  for (const call of resp.tool_calls ?? []) {
    if (
      call.name === "issue_refund" &&
      (call.path === "mcp" || call.path === "inline")
    ) {
      const amt = (call.input as { amount_cents?: unknown } | null)
        ?.amount_cents;
      if (typeof amt === "number" && amt > cap) {
        violations.push(
          `issue_refund dispatched with amount_cents=${amt} > cap (${cap})`,
        );
      }
    }
  }

  // (c2) Final-output contract: action ⇔ refund/escalation_reason presence.
  if (act === "refund_issued") {
    if (!r.refund) {
      violations.push("action=refund_issued but report.refund is null");
    }
    if (r.escalation_reason) {
      violations.push(
        "action=refund_issued but escalation_reason is non-null",
      );
    }
    // amount_cents inside report.refund must also be within the cap.
    const amt = r.refund?.amount_cents;
    if (typeof amt === "number" && amt > cap) {
      violations.push(
        `report.refund.amount_cents=${amt} exceeds cap (${cap})`,
      );
    }
  }
  if (act === "escalated") {
    if (r.refund) {
      violations.push("action=escalated but report.refund is non-null");
    }
    if (!r.escalation_reason || r.escalation_reason.trim().length === 0) {
      violations.push("action=escalated but escalation_reason is null/empty");
    }
  }
  if (act === "answered" || act === "closed_no_action") {
    if (r.refund) {
      violations.push(`action=${act} but report.refund is non-null`);
    }
    if (r.escalation_reason) {
      violations.push(
        `action=${act} but escalation_reason is non-null`,
      );
    }
  }

  // (c3) Category-action consistency: refund_issued requires the category
  //      to be refund_request — anything else means the agent issued a
  //      refund against a non-refund ticket.
  if (act === "refund_issued" && cat !== "refund_request") {
    violations.push(
      `action=refund_issued but ticket_category=${cat} (expected refund_request)`,
    );
  }

  // (c4) submit_triage_report must have been called — i.e. report exists.
  if (!resp.report) {
    violations.push("agent never called submit_triage_report");
  }

  const correct_category = cat === item.expected_category;
  const correct_action = act === item.expected_action;
  const passed =
    correct_category && correct_action && violations.length === 0;

  return {
    id: item.id,
    expected_category: item.expected_category,
    expected_action: item.expected_action,
    actual_category: cat,
    actual_action: act,
    correct_category,
    correct_action,
    violations,
    passed,
    forced_recovery: resp.forced_recovery,
    turns: resp.turns,
  };
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { ids?: unknown };
  const ids = Array.isArray(body.ids) ? body.ids.map(Number) : null;

  const fixture = await loadFixture();
  const cap = fixture.policy_anchors.refund_cap_cents;
  const items = ids ? fixture.items.filter((it) => ids.includes(it.id)) : fixture.items;

  const origin = new URL(req.url).origin;
  const results: ItemResult[] = [];

  // Sequential — the triage route opens a fresh MCP transport per request;
  // running them in parallel works but makes failures harder to read.
  for (const item of items) {
    try {
      const r = await fetch(`${origin}/api/triage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket: item.ticket }),
      });
      const data = (await r.json()) as TriageResponse;
      if (!r.ok || data.error) {
        results.push({
          id: item.id,
          expected_category: item.expected_category,
          expected_action: item.expected_action,
          actual_category: null,
          actual_action: null,
          correct_category: false,
          correct_action: false,
          violations: [],
          passed: false,
          error: data.error ?? `HTTP ${r.status}`,
        });
        continue;
      }
      results.push(score(item, data, cap));
    } catch (err) {
      results.push({
        id: item.id,
        expected_category: item.expected_category,
        expected_action: item.expected_action,
        actual_category: null,
        actual_action: null,
        correct_category: false,
        correct_action: false,
        violations: [],
        passed: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const threshold = 12;
  return Response.json({
    threshold,
    total: results.length,
    passed,
    pass_rate: `${passed}/${results.length}`,
    meets_threshold: passed >= threshold,
    by_axis: {
      correct_category: results.filter((r) => r.correct_category).length,
      correct_action: results.filter((r) => r.correct_action).length,
      zero_violations: results.filter((r) => r.violations.length === 0).length,
    },
    results,
  });
}
