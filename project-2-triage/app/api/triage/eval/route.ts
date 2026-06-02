// Eval harness for /api/triage.
//
// Reads two files following the Inspect convention:
//
//   evals/triage.eval.json  — task spec (name, scorers, pass criteria,
//                              policy_anchors, schemas, threshold).
//   evals/triage.jsonl      — one sample per line, each shaped as
//                              { id, input, target, metadata }.
//
// `input` is sent verbatim as the POST body to /api/triage on the same
// dev server (the incoming request's origin). The response is scored on
// three code-based scorers:
//
//   (a) category_match    — report.ticket_category === target.category
//   (b) action_match      — report.action_taken === target.action
//   (c) policy_violations — internal-consistency rules vs. the system
//                            prompt's "Final-output contract" + the
//                            refund_cap_cents anchor in the spec.
//
// An item passes only if all three are clean. The aggregate threshold
// is read from the spec (currently 12/16). Body accepts an optional
// { ids: number[] } to re-run a subset cheaply during prompt iteration.

import { promises as fs } from "node:fs";
import path from "node:path";

export const runtime = "nodejs";
export const maxDuration = 600;

type Category = "refund_request" | "bug_report" | "question" | "other";
type Action =
  | "refund_issued"
  | "escalated"
  | "answered"
  | "closed_no_action";

type Sample = {
  id: number;
  input: { ticket: string; image_url?: string };
  target: { category: Category; action: Action };
  metadata?: { notes?: string };
};

type EvalSpec = {
  name: string;
  version: number;
  description: string;
  dataset: string;
  policy_anchors: { refund_cap_cents: number; escalation_triggers: string[] };
  pass_criteria: { aggregate: { passed_at_least: number; of: number } };
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

async function loadSpec(): Promise<EvalSpec> {
  const p = path.join(process.cwd(), "evals", "triage.eval.json");
  return JSON.parse(await fs.readFile(p, "utf8")) as EvalSpec;
}

async function loadDataset(datasetRelPath: string): Promise<Sample[]> {
  const p = path.join(process.cwd(), "evals", datasetRelPath);
  const raw = await fs.readFile(p, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Sample);
}

function score(sample: Sample, resp: TriageResponse, cap: number): ItemResult {
  const r = resp.report ?? {};
  const cat = r.ticket_category ?? null;
  const act = r.action_taken ?? null;

  const violations: string[] = [];

  // Refund cap — should never leak past the hook, but verify any
  // successfully-dispatched issue_refund call respected the cap.
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

  // Final-output contract: action ⇔ refund/escalation_reason presence.
  if (act === "refund_issued") {
    if (!r.refund) {
      violations.push("action=refund_issued but report.refund is null");
    }
    if (r.escalation_reason) {
      violations.push(
        "action=refund_issued but escalation_reason is non-null",
      );
    }
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
      violations.push(`action=${act} but escalation_reason is non-null`);
    }
  }

  // Category-action consistency.
  if (act === "refund_issued" && cat !== "refund_request") {
    violations.push(
      `action=refund_issued but ticket_category=${cat} (expected refund_request)`,
    );
  }

  // submit_triage_report must have been called — i.e. report exists.
  if (!resp.report) {
    violations.push("agent never called submit_triage_report");
  }

  const correct_category = cat === sample.target.category;
  const correct_action = act === sample.target.action;
  const passed =
    correct_category && correct_action && violations.length === 0;

  return {
    id: sample.id,
    expected_category: sample.target.category,
    expected_action: sample.target.action,
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

  const spec = await loadSpec();
  const dataset = await loadDataset(spec.dataset);
  const cap = spec.policy_anchors.refund_cap_cents;
  const threshold = spec.pass_criteria.aggregate.passed_at_least;
  const samples = ids ? dataset.filter((s) => ids.includes(s.id)) : dataset;

  const origin = new URL(req.url).origin;
  const results: ItemResult[] = [];

  // Sequential — the triage route opens a fresh MCP transport per request;
  // running them in parallel works but makes failures harder to read.
  for (const sample of samples) {
    try {
      const r = await fetch(`${origin}/api/triage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sample.input),
      });
      const data = (await r.json()) as TriageResponse;
      if (!r.ok || data.error) {
        results.push({
          id: sample.id,
          expected_category: sample.target.category,
          expected_action: sample.target.action,
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
      results.push(score(sample, data, cap));
    } catch (err) {
      results.push({
        id: sample.id,
        expected_category: sample.target.category,
        expected_action: sample.target.action,
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
  return Response.json({
    eval: { name: spec.name, version: spec.version },
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
