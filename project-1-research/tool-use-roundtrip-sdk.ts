import Anthropic from "@anthropic-ai/sdk";
import {
  MessageParam,
  Tool,
  ToolResultBlockParam,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages/messages.mjs";

const client = new Anthropic();

// ── cache_control placement rules ──────────────────────────────────────────
// 1. Render order is `tools` → `system` → `messages`. A marker on the LAST
//    tool definition caches the entire `tools` (and `system`) prefix, so
//    turn 2 below reuses the cached schema instead of re-billing it.
// 2. Caching is a strict PREFIX match. Any byte change before the marker
//    invalidates everything after it. Never attach cache_control to a block
//    that varies per request (timestamps, user IDs, the user message).
// 3. Max 4 `cache_control` breakpoints per request.
// 4. Min cacheable prefix on Opus 4.7 is 4096 tokens. This tool is tiny —
//    the marker is harmless but silently won't cache. Pad with a real
//    system prompt or more tools to actually see `cache_read_input_tokens`.
// 5. Multi-turn pattern not used here: you'd also drop a marker on the last
//    content block of the most-recently-appended turn to extend the cached
//    prefix further into the conversation history.
const tools: Tool[] = [
  {
    name: "get_weather",
    description: "Get the current weather for a given location.",
    input_schema: {
      type: "object",
      properties: {
        location: {
          type: "string",
          description: "City and state, e.g. San Francisco, CA",
        },
        unit: { type: "string", enum: ["celsius", "fahrenheit"] },
      },
      required: ["location"],
    },
    cache_control: { type: "ephemeral" }, // caches `tools` across both turns
  },
];

function runTool(name: string, input: Record<string, unknown>): string {
  if (name === "get_weather") {
    return `72°F and sunny in ${input.location}`;
  }
  return `Unknown tool: ${name}`;
}

const messages: MessageParam[] = [
  { role: "user", content: "What's the weather in Paris?" },
];

// Turn 1: model decides to call a tool
console.log("--- Turn 1 ---");
const stream1 = client.messages.stream({
  model: "claude-opus-4-7",
  max_tokens: 1024,
  tools,
  messages,
});
stream1.on("text", (delta) => process.stdout.write(delta));
let response = await stream1.finalMessage();
console.log("\nstop_reason:", response.stop_reason);
console.log("usage:", response.usage);

// Execute every tool_use block and send results back
if (response.stop_reason === "tool_use") {
  messages.push({ role: "assistant", content: response.content });

  const toolResults: ToolResultBlockParam[] = response.content
    .filter((b): b is ToolUseBlock => b.type === "tool_use")
    .map((b) => ({
      type: "tool_result",
      tool_use_id: b.id,
      content: runTool(b.name, b.input as Record<string, unknown>),
    }));

  messages.push({ role: "user", content: toolResults });

  // Turn 2: identical `tools` prefix → if it crosses the 4096-token cache
  // minimum, `usage.cache_read_input_tokens` will be > 0 here.
  console.log("\n--- Turn 2 ---");
  const stream2 = client.messages.stream({
    model: "claude-opus-4-7",
    max_tokens: 1024,
    tools,
    messages,
  });
  stream2.on("text", (delta) => process.stdout.write(delta));
  response = await stream2.finalMessage();
  console.log("\nstop_reason:", response.stop_reason);
  console.log("usage:", response.usage);
}
