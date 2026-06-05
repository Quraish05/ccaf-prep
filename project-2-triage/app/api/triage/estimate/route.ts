// POST /api/triage/estimate — predict the input-token count + cost range for
// a triage call before running it. Uses anthropic.messages.countTokens() with
// the same `system + tools + messages` shape /api/triage would assemble.
//
// countTokens is a free endpoint and returns only input_tokens — output is
// unknown until the run completes, so we return a *range* using a heuristic
// min/max output estimate (most triage runs land between ~150 and 700 output
// tokens across the loop). Cost figures are based on the in-route model
// pricing (claude-haiku-4-5 at $1/MTok in, $5/MTok out as of 2026-06).

import Anthropic from "@anthropic-ai/sdk";

import { REPORT_TOOL, SYSTEM, TOOLS } from "../_prompt";

export const runtime = "nodejs";

// Pricing in USD per 1M tokens for claude-haiku-4-5. Hardcoded here rather
// than imported so the source of truth for the price is local + grep-able.
const PRICE_PER_MTOK_INPUT = 1.0;
const PRICE_PER_MTOK_OUTPUT = 5.0;

// Output-token range observed in practice across the triage fixture. The
// model's terminal turn (submit_triage_report) tends to dominate output;
// classify-only paths hit the lower bound, multi-turn refund paths the upper.
const OUTPUT_TOKEN_MIN = 150;
const OUTPUT_TOKEN_MAX = 700;

export async function POST(req: Request) {
  let body: { ticket?: unknown; image_url?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const ticket = typeof body.ticket === "string" ? body.ticket.trim() : "";
  if (!ticket) {
    return Response.json(
      { error: "body must contain { ticket: string }" },
      { status: 400 },
    );
  }

  const imageUrl =
    typeof body.image_url === "string" && body.image_url.trim()
      ? body.image_url.trim()
      : undefined;

  // Build the same content + messages shape /api/triage uses, so the count
  // reflects the actual first-turn request. We only count the FIRST turn —
  // subsequent turns add tool_result blocks but those are bounded by the
  // model's tool calls, which we can't predict here.
  const userContent: Anthropic.ContentBlockParam[] | string = imageUrl
    ? [
        { type: "image", source: { type: "url", url: imageUrl } },
        { type: "text", text: ticket },
      ]
    : ticket;

  const anthropic = new Anthropic();

  try {
    const count = await anthropic.messages.countTokens({
      model: "claude-haiku-4-5",
      system: SYSTEM,
      tools: TOOLS,
      messages: [{ role: "user", content: userContent }],
    });

    const inputTokens = count.input_tokens;

    // Per-call input cost is fixed; output cost is a range.
    const inputCostCents = (inputTokens / 1_000_000) * PRICE_PER_MTOK_INPUT * 100;
    const outputCostCentsMin =
      (OUTPUT_TOKEN_MIN / 1_000_000) * PRICE_PER_MTOK_OUTPUT * 100;
    const outputCostCentsMax =
      (OUTPUT_TOKEN_MAX / 1_000_000) * PRICE_PER_MTOK_OUTPUT * 100;

    return Response.json({
      input_tokens: inputTokens,
      output_tokens_estimate: {
        min: OUTPUT_TOKEN_MIN,
        max: OUTPUT_TOKEN_MAX,
      },
      cost_cents: {
        // Three figures keep this honest about precision — sub-cent estimates
        // shown to 4 decimals so the UI can render "<0.01¢" gracefully.
        input: Number(inputCostCents.toFixed(4)),
        output_min: Number(outputCostCentsMin.toFixed(4)),
        output_max: Number(outputCostCentsMax.toFixed(4)),
        total_min: Number((inputCostCents + outputCostCentsMin).toFixed(4)),
        total_max: Number((inputCostCents + outputCostCentsMax).toFixed(4)),
      },
      pricing: {
        model: "claude-haiku-4-5",
        per_mtok_input_usd: PRICE_PER_MTOK_INPUT,
        per_mtok_output_usd: PRICE_PER_MTOK_OUTPUT,
      },
      assumptions: {
        // Document what we counted and what we didn't, so the caller knows
        // why a real run might consume more tokens than this estimate.
        counts: "first-turn system + tools + messages",
        excludes:
          "subsequent loop turns (tool_result blocks + assistant follow-ups), forced-recovery branch",
        report_tool_uses_strict: REPORT_TOOL,
      },
    });
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      return Response.json(
        { error: err.message, type: err.constructor.name, status: err.status },
        { status: err.status ?? 500 },
      );
    }
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
