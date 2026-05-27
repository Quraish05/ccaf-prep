import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";

import { runAgent, type Note } from "../_lib";

export const runtime = "nodejs";
export const maxDuration = 120;

// Single-tool agent that only does save_note. No WebSearch, no fan-out.
// Cheap to run and deterministic enough to verify the PII hook end-to-end.
const TEST_AGENT: AgentDefinition = {
  description:
    "Tests the PreToolUse PII guard by attempting to save a note that contains PII, then recovering.",
  prompt: `You are testing a PreToolUse PII guard hook. The user will give you content to save as a note. The content WILL contain PII (an email and/or an SSN).

Follow these steps EXACTLY:
1. First, attempt to call mcp__notes__save_note with the raw content as the body. The hook will block this call.
2. Read the deny reason. It will tell you which pattern was detected.
3. Retry by calling mcp__notes__save_note again, this time with the PII replaced by the literal string '[REDACTED]'.
4. Reply with a one-paragraph summary of what happened: which call was blocked, why, and what you saved on the second attempt.

Do NOT skip step 1 — the test relies on observing the deny.`,
  tools: ["mcp__notes__save_note"],
  mcpServers: ["notes"],
  model: "sonnet",
};

const TEST_BODY = `Customer Jane Doe (jane.doe@example.com, SSN 123-45-6789) reported a billing error on her March invoice.`;

export async function POST() {
  const notes: Note[] = [];
  const startedAt = Date.now();

  try {
    const result = await runAgent(
      `Save a note with title "billing complaint summary" and body:\n\n${TEST_BODY}\n\nThen follow the recovery protocol you were trained on.`,
      TEST_AGENT,
      notes,
    );

    return Response.json({
      ok: true,
      duration_ms: Date.now() - startedAt,
      hook_fired: result.blocks.length > 0,
      blocks: result.blocks,
      agent_reply: result.text,
      notes_saved: notes,
      verdict:
        result.blocks.length > 0 && notes.length > 0
          ? "PASS: hook blocked the PII call, agent recovered and saved a redacted note."
          : result.blocks.length > 0
            ? "PARTIAL: hook fired but no recovered note was saved."
            : "FAIL: hook did not fire (or PII pattern was not detected).",
    });
  } catch (err) {
    return Response.json(
      {
        ok: false,
        duration_ms: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
