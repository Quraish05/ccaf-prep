import { promises as fs } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";

import { runResearch, FAST_PROFILE } from "../_lib";

export const runtime = "nodejs";
export const maxDuration = 600;

const JUDGE_MODEL = "claude-haiku-4-5-20251001";

type EvalSet = {
  pass_threshold: number;
  shared_criteria: string[];
  items: { id: number; query: string; criteria: string[] }[];
};

type CriterionResult = { criterion: string; pass: boolean; reason: string };

type ItemResult = {
  id: number;
  query: string;
  passed: boolean;
  criteria: CriterionResult[];
  notes_count?: number;
  report_chars?: number;
  error?: string;
  searcher_errors?: string[];
};

async function loadEvalSet(): Promise<EvalSet> {
  const p = path.join(process.cwd(), "evals", "research-evals.json");
  return JSON.parse(await fs.readFile(p, "utf8")) as EvalSet;
}

// LLM-as-judge: one cheap Haiku call grades the report against all criteria.
async function judge(
  report: string,
  criteria: string[],
): Promise<CriterionResult[]> {
  const client = new Anthropic();
  const numbered = criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
  const msg = await client.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 1500,
    system:
      'You grade a research report against numbered criteria. For each criterion decide pass (true/false) strictly from the report\'s actual content — do not give benefit of the doubt. Respond with JSON only: {"results":[{"index":1,"pass":true,"reason":"one short sentence"}]}',
    messages: [
      { role: "user", content: `CRITERIA:\n${numbered}\n\nREPORT:\n${report}` },
    ],
  });
  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Judge returned no JSON: ${text}`);
  const parsed = JSON.parse(match[0]) as {
    results: { index: number; pass: boolean; reason: string }[];
  };
  return parsed.results.map((r) => ({
    criterion: criteria[r.index - 1] ?? `criterion #${r.index}`,
    pass: !!r.pass,
    reason: r.reason,
  }));
}

export async function POST(req: Request) {
  // Optional { "ids": [1,3] } to run a subset; default runs all items.
  const body = (await req.json().catch(() => ({}))) as { ids?: unknown };
  const ids = Array.isArray(body.ids) ? body.ids.map(Number) : undefined;

  const evalSet = await loadEvalSet();
  const items = ids
    ? evalSet.items.filter((it) => ids.includes(it.id))
    : evalSet.items;

  const results: ItemResult[] = [];
  // Sequential on purpose: each runResearch spawns several CLI subprocesses;
  // running 5 in parallel would mean ~20 concurrent subprocesses.
  for (const item of items) {
    try {
      const research = await runResearch(item.query, FAST_PROFILE);
      if (research.report === null) {
        results.push({
          id: item.id,
          query: item.query,
          passed: false,
          criteria: [],
          error: "no report (all searchers failed)",
          searcher_errors: research.searcherSummaries
            .map((s) => s.error)
            .filter((e): e is string => e !== null),
        });
        continue;
      }
      const allCriteria = [...evalSet.shared_criteria, ...item.criteria];
      const criteria = await judge(research.report, allCriteria);
      results.push({
        id: item.id,
        query: item.query,
        passed: criteria.every((c) => c.pass),
        criteria,
        notes_count: research.notes.length,
        report_chars: research.report.length,
      });
    } catch (err) {
      results.push({
        id: item.id,
        query: item.query,
        passed: false,
        criteria: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const threshold =
    evalSet.pass_threshold ?? Math.ceil(results.length * 0.8);
  return Response.json({
    profile: "fast (haiku planner/searchers/synth + haiku judge)",
    pass_threshold: threshold,
    total: results.length,
    passed,
    pass_rate: `${passed}/${results.length}`,
    meets_threshold: passed >= threshold,
    results,
  });
}
