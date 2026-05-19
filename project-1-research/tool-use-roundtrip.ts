const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) throw new Error("Set ANTHROPIC_API_KEY");

// ── cache_control placement rules ──────────────────────────────────────────
// 1. Render order is `tools` → `system` → `messages`. A marker on the LAST
//    tool definition caches the entire `tools` (and `system`, if present)
//    prefix so turn 2 of this roundtrip reads from cache instead of re-
//    paying for the tool schema.
// 2. Caching is a strict PREFIX match. Any byte change before the marker
//    invalidates everything after it. Don't move it onto something that
//    varies per request (timestamps, user IDs, the user message).
// 3. Max 4 `cache_control` breakpoints per request.
// 4. Min cacheable prefix on Opus 4.7 is 4096 tokens. The tool here is
//    tiny — the marker is harmless but won't actually cache. Pad with a
//    real system prompt / more tools to see `cache_read_input_tokens > 0`.
// 5. Multi-turn pattern not used here: you'd also put a marker on the last
//    block of the most-recently-appended turn to extend the cached prefix
//    further into the conversation.
const TOOLS = [
  {
    name: "get_weather",
    description: "Get the current weather for a given location.",
    input_schema: {
      type: "object",
      properties: {
        location: { type: "string", description: "City and state, e.g. San Francisco, CA" },
        unit: { type: "string", enum: ["celsius", "fahrenheit"] },
      },
      required: ["location"],
    },
    cache_control: { type: "ephemeral" }, // caches `tools` across both turns
  },
];

function runTool(name: string, input: Record<string, unknown>): string {
  if (name === "get_weather") return `72°F and sunny in ${input.location}`;
  return `Unknown tool: ${name}`;
}

// Stream one request, assemble the final Message-like object from SSE.
async function streamClaude(messages: unknown[]): Promise<{
  content: any[];
  stop_reason: string | null;
  usage: any;
}> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-opus-4-7",
      max_tokens: 1024,
      stream: true,
      tools: TOOLS,
      messages,
    }),
  });
  if (!res.ok || !res.body) throw new Error(`${res.status}: ${await res.text()}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const content: any[] = [];
  let stop_reason: string | null = null;
  let usage: any = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE events are separated by blank lines.
    let nl: number;
    while ((nl = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 2);

      const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) continue;
      const ev = JSON.parse(dataLine.slice(6));

      switch (ev.type) {
        case "message_start":
          usage = ev.message.usage; // cache_read/creation_input_tokens land here
          break;
        case "content_block_start":
          content[ev.index] =
            ev.content_block.type === "tool_use"
              ? { ...ev.content_block, input: "" } // input arrives as JSON deltas
              : { ...ev.content_block };
          break;
        case "content_block_delta": {
          const block = content[ev.index];
          if (ev.delta.type === "text_delta") {
            block.text += ev.delta.text;
            process.stdout.write(ev.delta.text);
          } else if (ev.delta.type === "input_json_delta") {
            block.input += ev.delta.partial_json;
          }
          break;
        }
        case "content_block_stop": {
          const block = content[ev.index];
          if (block.type === "tool_use") {
            block.input = block.input ? JSON.parse(block.input) : {};
          }
          break;
        }
        case "message_delta":
          if (ev.delta.stop_reason) stop_reason = ev.delta.stop_reason;
          if (ev.usage) usage = { ...usage, ...ev.usage };
          break;
      }
    }
  }

  return { content, stop_reason, usage };
}

const messages: any[] = [
  { role: "user", content: "What's the weather in Paris?" },
];

// Turn 1: model decides to call a tool
console.log("--- Turn 1 ---");
let response = await streamClaude(messages);
console.log("\nstop_reason:", response.stop_reason);
console.log("usage:", response.usage);

if (response.stop_reason === "tool_use") {
  messages.push({ role: "assistant", content: response.content });

  const toolResults = response.content
    .filter((b: any) => b.type === "tool_use")
    .map((b: any) => ({
      type: "tool_result",
      tool_use_id: b.id,
      content: runTool(b.name, b.input),
    }));

  messages.push({ role: "user", content: toolResults });

  // Turn 2: model produces the final answer using the tool result.
  // The `tools` prefix is identical to turn 1 — if it crosses the 4096-token
  // cache minimum, `usage.cache_read_input_tokens` will be > 0 here.
  console.log("\n--- Turn 2 ---");
  response = await streamClaude(messages);
  console.log("\nstop_reason:", response.stop_reason);
  console.log("usage:", response.usage);
}
