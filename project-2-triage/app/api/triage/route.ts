// Triage agent entry point.
//
// All the substance — tools, schemas, system prompt, MCP server, PreToolUse
// hook, dispatch — lives in ./_lib.ts and ./_types.ts. This file is the route
// handler: parse the request, run the manual tool-use loop against Claude,
// short-circuit on submit_triage_report (or force it via tool_choice if the
// model tries to end without one), and shape the JSON response.

import { randomUUID } from "node:crypto";

import Anthropic from "@anthropic-ai/sdk";

import type { HookBlock, ToolCallRecord } from "./_types";
import {
  appendAudit,
  buildRefundCapHook,
  connectRefundsClient,
  dispatchTool,
  MAX_TURNS,
  redactCardNumbers,
  REPORT_TOOL,
  SYSTEM,
  TOOLS,
} from "./_lib";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: { ticket?: unknown; image_url?: unknown };
  try {
    body = (await req.json()) as { ticket?: unknown; image_url?: unknown };
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

  // Optional image attachment — vision branch. When provided we send the
  // user message as a content array with the image FIRST (Anthropic best
  // practice: image-then-text) so the model sees the visual context before
  // the textual claim.
  //
  // Accepts two URL flavors via the same `image_url` field:
  //   - http(s):// URL → forwarded as { type: "url" } source. Anthropic
  //     fetches it server-side. CAVEAT: their fetcher respects robots.txt,
  //     so most public image hosts (wikimedia, placehold.co, etc.) fail
  //     with 400 "disallowed by robots.txt". Works for hosts you control.
  //   - data:image/<type>;base64,<data> → parsed locally into a
  //     { type: "base64" } source. Always works (no server-side fetch),
  //     at the cost of more bytes on the wire. Required for Bedrock/Vertex.
  const imageUrl =
    typeof body.image_url === "string" && body.image_url.trim().length > 0
      ? body.image_url.trim()
      : null;

  const buildImageSource = (
    src: string,
  ): Anthropic.Base64ImageSource | Anthropic.URLImageSource => {
    const m = src.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
    if (m) {
      return {
        type: "base64",
        media_type: m[1] as Anthropic.Base64ImageSource["media_type"],
        data: m[2],
      };
    }
    return { type: "url", url: src };
  };

  const requestId = randomUUID();
  const anthropic = new Anthropic();
  const { client: mcp, close } = await connectRefundsClient();

  // Track tool calls so the response shows which path each one took.
  // "hook-denied" rows mean the PreToolUse hook fired before dispatch.
  const toolCalls: ToolCallRecord[] = [];

  // Fresh hook + observability array per request — denials end up here so
  // the response can report them.
  const hookBlocks: HookBlock[] = [];
  const preToolUseHook = buildRefundCapHook(hookBlocks);

  const userContent: Anthropic.ContentBlockParam[] | string = imageUrl
    ? [
        { type: "image", source: buildImageSource(imageUrl) },
        { type: "text", text: ticket },
      ]
    : ticket;

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userContent },
  ];

  // Helper: pull the structured payload out of a forced submit_triage_report
  // tool_use block. The block's `.input` is the validated JSON the schema
  // enforces — strict:true on the tool means the API has already checked it.
  const extractReport = (msg: Anthropic.Message): unknown | null => {
    const block = msg.content.find(
      (b): b is Anthropic.ToolUseBlock =>
        b.type === "tool_use" && b.name === REPORT_TOOL,
    );
    return block ? block.input : null;
  };

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const apiStart = Date.now();
      const res = await anthropic.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 2048,
        // temperature: 0 makes the eval reproducible — the same ticket should
        // produce the same triage decision run after run. Non-determinism at
        // the default temperature made one bad sample per pass mask real
        // failure modes (e.g. partial-refund-as-workaround).
        temperature: 0,
        system: SYSTEM,
        tools: TOOLS,
        messages,
        // tool_choice defaults to "auto" — let the model classify, fetch, and
        // refund as needed. Forcing only fires below on the end_turn recovery
        // path, when the model tried to finish without the report.
      });
      const apiLatency = Date.now() - apiStart;
      const apiUsage = res.usage;
      // api_call audit row carries the full turn's usage + latency. Per-tool
      // rows below reference the same `turn` so aggregation by turn doesn't
      // double-count tokens.
      await appendAudit({
        ts: new Date().toISOString(),
        request_id: requestId,
        turn,
        kind: "api_call",
        tool: "messages.create",
        latency_ms: apiLatency,
        input_tokens: apiUsage.input_tokens,
        output_tokens: apiUsage.output_tokens,
        cache_creation_input_tokens: apiUsage.cache_creation_input_tokens ?? undefined,
        cache_read_input_tokens: apiUsage.cache_read_input_tokens ?? undefined,
      });

      // Did the model emit submit_triage_report this turn? That's the terminal.
      // We accept it even if the model also emitted other tool_use blocks in
      // the same turn — we just don't dispatch the others, since the model
      // declared the run done.
      const report = extractReport(res);
      if (report !== null) {
        return Response.json({
          report,
          tool_calls: toolCalls,
          hook_blocks: hookBlocks,
          turns: turn + 1,
          forced_recovery: false,
        });
      }

      // No report yet. If the model wanted to end_turn anyway, force it back
      // through the structured output. This is the canonical "you MUST call
      // this exact tool" exam pattern: tool_choice with type:"tool".
      if (res.stop_reason === "end_turn") {
        messages.push({ role: "assistant", content: res.content });
        messages.push({
          role: "user",
          content:
            "You ended without calling submit_triage_report. Conclude now by calling submit_triage_report with the structured outcome of this triage. Do not call any other tool.",
        });
        const forcedStart = Date.now();
        const forced = await anthropic.messages.create({
          model: "claude-haiku-4-5",
          max_tokens: 2048,
          temperature: 0,
          system: SYSTEM,
          tools: TOOLS,
          messages,
          tool_choice: {
            type: "tool",
            name: REPORT_TOOL,
            disable_parallel_tool_use: true,
          },
        });
        // The forced-recovery call counts as its own turn for audit purposes —
        // turn + 1 so a downstream aggregator can distinguish it from the
        // original turn that emitted end_turn.
        await appendAudit({
          ts: new Date().toISOString(),
          request_id: requestId,
          turn: turn + 1,
          kind: "api_call",
          tool: "messages.create:forced-recovery",
          latency_ms: Date.now() - forcedStart,
          input_tokens: forced.usage.input_tokens,
          output_tokens: forced.usage.output_tokens,
          cache_creation_input_tokens: forced.usage.cache_creation_input_tokens ?? undefined,
          cache_read_input_tokens: forced.usage.cache_read_input_tokens ?? undefined,
        });
        const forcedReport = extractReport(forced);
        if (forcedReport === null) {
          // Should be unreachable — tool_choice:tool guarantees the call.
          return Response.json(
            {
              error: "forced submit_triage_report returned no tool_use block",
              partial: forced.content,
              tool_calls: toolCalls,
            },
            { status: 502 },
          );
        }
        return Response.json({
          report: forcedReport,
          tool_calls: toolCalls,
          hook_blocks: hookBlocks,
          turns: turn + 2,
          forced_recovery: true,
        });
      }

      if (res.stop_reason !== "tool_use") {
        return Response.json(
          {
            error: `unexpected stop_reason: ${res.stop_reason}`,
            partial: res.content,
            tool_calls: toolCalls,
          },
          { status: 502 },
        );
      }

      // Normal tool dispatch — classify / fetch / refund.
      messages.push({ role: "assistant", content: res.content });
      const toolUses = res.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
        toolUses.map(async (t) => {
          const input = t.input as Record<string, unknown>;

          // PreToolUse hook runs first. A "deny" decision is fed back as a
          // tool_result with is_error: true — the deny reason itself tells
          // the model to escalate via submit_triage_report instead of
          // retrying, which is what makes the cap a hard rule rather than
          // soft guidance.
          const decision = await preToolUseHook({ tool_name: t.name, tool_input: input });
          if (decision.decision === "deny") {
            const redactedInput = redactCardNumbers(t.input);
            toolCalls.push({
              path: "hook-denied",
              name: t.name,
              input: redactedInput,
              output: decision.reason,
            });
            await appendAudit({
              ts: new Date().toISOString(),
              request_id: requestId,
              turn,
              kind: "hook_block",
              tool: t.name,
              path: "hook-denied",
              hook: "refund-cap",
              reason: decision.reason,
              input: redactedInput,
              // Parent api_call's usage is duplicated here so a single audit
              // line is self-describing. Aggregation tools should group by
              // `turn` to avoid double-counting.
              input_tokens: apiUsage.input_tokens,
              output_tokens: apiUsage.output_tokens,
            });
            return {
              type: "tool_result" as const,
              tool_use_id: t.id,
              content: decision.reason,
              is_error: true,
            };
          }

          const dispatchStart = Date.now();
          const output = await dispatchTool(t.name, input, mcp);
          const dispatchLatency = Date.now() - dispatchStart;
          const redactedInput = redactCardNumbers(t.input);
          const path = t.name === "issue_refund" ? "mcp" : "inline";
          toolCalls.push({
            path,
            name: t.name,
            input: redactedInput,
            output,
          });
          await appendAudit({
            ts: new Date().toISOString(),
            request_id: requestId,
            turn,
            kind: "tool_call",
            tool: t.name,
            path,
            input: redactedInput,
            output_preview: output.slice(0, 200),
            latency_ms: dispatchLatency,
            input_tokens: apiUsage.input_tokens,
            output_tokens: apiUsage.output_tokens,
          });
          return {
            type: "tool_result" as const,
            tool_use_id: t.id,
            content: output,
          };
        }),
      );
      messages.push({ role: "user", content: toolResults });
    }

    return Response.json(
      {
        error: `agent exceeded ${MAX_TURNS} turns without finishing`,
        tool_calls: toolCalls,
      },
      { status: 504 },
    );
  } catch (err) {
    // Typed Anthropic errors (rate-limit, auth, etc.) include `.status`; fall
    // back to the message for everything else.
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
  } finally {
    await close();
  }
}
