import {
  createSdkMcpServer,
  query,
  tool,
  type AgentDefinition,
  type HookCallback,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export type Note = {
  title: string;
  body: string;
  source_url?: string;
  sub_query: string;
  created_at: string;
};

export function buildNotesServer(
  notes: Note[],
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "notes",
    version: "1.0.0",
    tools: [
      tool(
        "save_note",
        "Save a research finding as a note. Use one note per discrete fact, quote, or data point.",
        {
          title: z.string(),
          body: z.string(),
          source_url: z.string().optional(),
          sub_query: z.string(),
        },
        async (args) => {
          notes.push({ ...args, created_at: new Date().toISOString() });
          return {
            content: [
              {
                type: "text",
                text: `Saved '${args.title}' (${notes.length} total).`,
              },
            ],
          };
        },
      ),
      tool(
        "recent_notes",
        "Return every note gathered so far, newest first. Call once before writing the report.",
        {},
        async () => {
          if (notes.length === 0) {
            return { content: [{ type: "text", text: "No notes yet." }] };
          }
          const text = [...notes]
            .reverse()
            .map(
              (n) =>
                `# ${n.title}\n(sub_query: ${n.sub_query}${n.source_url ? `, source: ${n.source_url}` : ""})\n\n${n.body}`,
            )
            .join("\n\n---\n\n");
          return { content: [{ type: "text", text }] };
        },
      ),
    ],
  });
}

// PII-blocking PreToolUse hook --------------------------------------------

const PII_PATTERNS: { name: string; regex: RegExp }[] = [
  { name: "email", regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { name: "ssn", regex: /\b\d{3}-\d{2}-\d{4}\b/ },
];

export function findPii(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    for (const { name, regex } of PII_PATTERNS) {
      if (regex.test(value)) return name;
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const r = findPii(v);
      if (r) return r;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      const r = findPii(v);
      if (r) return r;
    }
  }
  return null;
}

export type PiiBlock = {
  tool_name: string;
  pattern: string;
  reason: string;
};

// Factory that returns a hook closing over a `blocks` array so callers can
// observe denies without parsing SDK message internals.
export function buildPiiHook(blocks: PiiBlock[]): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const hit = findPii(input.tool_input);
    if (!hit) return {};
    const reason = `[PII guard] Tool call to '${input.tool_name}' blocked: arguments contain a ${hit} pattern. Rewrite the arguments with the PII redacted (e.g. replace with [REDACTED]) and try again.`;
    blocks.push({ tool_name: input.tool_name, pattern: hit, reason });
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    };
  };
}

// Sub-agent harness -------------------------------------------------------

export type RunAgentResult = {
  text: string;
  blocks: PiiBlock[];
};

export async function runAgent(
  prompt: string,
  agent: AgentDefinition,
  notes: Note[],
): Promise<RunAgentResult> {
  // Build a fresh in-process MCP server per query() call. The McpServer
  // instance underneath isn't re-entrant across concurrent connections, but
  // every server's tool handlers close over the same `notes` array so the
  // shared-writeboard semantics survive.
  const notesServer = buildNotesServer(notes);
  const blocks: PiiBlock[] = [];
  const piiHook = buildPiiHook(blocks);

  const stream = query({
    prompt,
    options: {
      mcpServers: { notes: notesServer },
      agents: { _main: agent },
      agent: "_main",
      tools: ["WebSearch"],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      hooks: {
        PreToolUse: [{ hooks: [piiHook] }],
      },
    },
  });

  for await (const m of stream) {
    if (m.type === "result") {
      if (m.subtype === "success") return { text: m.result, blocks };
      throw new Error(`Sub-agent failed (${m.subtype})`);
    }
  }
  throw new Error("Sub-agent produced no result message");
}
