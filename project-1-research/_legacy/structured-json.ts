const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) throw new Error("Set ANTHROPIC_API_KEY");

// Schema we want the model to produce. We describe it in the prompt
// (prefill is unsupported on Opus 4.7), and validate it ourselves.
const SCHEMA = {
  sentiment: "positive | negative | neutral",
  key_issues: "string[]",
  action_items: "{ team: string; task: string }[]",
} as const;

const EXAMPLE = {
  sentiment: "negative",
  key_issues: ["slow checkout", "missing dark mode"],
  action_items: [
    { team: "frontend", task: "profile checkout flow" },
    { team: "design", task: "ship dark-mode theme" },
  ],
};

const SYSTEM = `You output JSON only — no prose, no markdown fences, no preamble.
The JSON must match this shape exactly: ${JSON.stringify(SCHEMA)}.
sentiment must be one of: "positive", "negative", "neutral".
Here is a worked example of the format:
${JSON.stringify(EXAMPLE, null, 2)}`;

async function callClaude(userText: string): Promise<string> {
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
      system: SYSTEM,
      messages: [{ role: "user", content: userText }],
    }),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  const body = await res.json();
  return body.content.find((b: any) => b.type === "text")?.text ?? "";
}

type Feedback = {
  sentiment: "positive" | "negative" | "neutral";
  key_issues: string[];
  action_items: { team: string; task: string }[];
};

// Pull a JSON object out of the response, even if the model wrapped it in
// markdown fences or added a sentence on either side.
function extractJson(raw: string): string | null {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end > start) return raw.slice(start, end + 1);
  return null;
}

function parseFeedback(raw: string):
  | { ok: true; value: Feedback }
  | { ok: false; error: string; raw: string } {
  const jsonStr = extractJson(raw);
  if (!jsonStr) return { ok: false, error: "no JSON object found in response", raw };

  let parsed: any;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    return { ok: false, error: `JSON.parse failed: ${(e as Error).message}`, raw };
  }

  // Cheap schema validation — enough to catch model drift.
  if (!["positive", "negative", "neutral"].includes(parsed.sentiment))
    return { ok: false, error: `invalid sentiment: ${parsed.sentiment}`, raw };
  if (!Array.isArray(parsed.key_issues) || !parsed.key_issues.every((x: any) => typeof x === "string"))
    return { ok: false, error: "key_issues must be string[]", raw };
  if (
    !Array.isArray(parsed.action_items) ||
    !parsed.action_items.every(
      (x: any) => x && typeof x.team === "string" && typeof x.task === "string",
    )
  )
    return { ok: false, error: "action_items must be { team, task }[]", raw };

  return { ok: true, value: parsed as Feedback };
}

const userFeedback =
  "The app crashes when I open the settings page on Android, and the search results are usually irrelevant. On the bright side, the new onboarding is great.";

const raw = await callClaude(userFeedback);
const result = parseFeedback(raw);

if (result.ok) {
  console.log("Parsed OK:");
  console.log(JSON.stringify(result.value, null, 2));
} else {
  console.error("Failed to parse model output:", result.error);
  console.error("--- raw response ---");
  console.error(result.raw);
  process.exit(1);
}
