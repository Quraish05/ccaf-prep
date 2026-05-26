#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["claude-agent-sdk>=0.1.0"]
# ///
"""Same notes server as `server.py`, but in-process inside an Agent SDK script.

Differences from the stdio version:
- No `claude_desktop_config.json` entry — the SDK wires the server in-process
  via `ClaudeAgentOptions(mcp_servers=...)`. No subprocess, no JSON-RPC.
- `FastMCP` → `create_sdk_mcp_server`.
- `@mcp.tool()` → `@tool(name, description, input_schema)` with explicit
  args. Handler must be `async`, take a single `args: dict`, and return
  the `{"content": [{"type": "text", "text": "..."}]}` MCP shape.
- The Agent SDK's in-process MCP servers DO NOT SUPPORT RESOURCES, only
  tools. The `notes://recent` resource from the stdio version is
  re-exposed here as a `recent_notes` tool.
- Tool names Claude sees are namespaced: `mcp__notes__save_note` and
  `mcp__notes__recent_notes`. The `allowed_tools` list uses that form.

Requires the Claude Code CLI on PATH (the Agent SDK spawns it).
"""

import asyncio
import json
from datetime import datetime
from pathlib import Path

from claude_agent_sdk import (
    ClaudeAgentOptions,
    create_sdk_mcp_server,
    query,
    tool,
)

# Shared on-disk store with the stdio server — same file, two different hosts.
NOTES_FILE = Path.home() / ".notes-mcp.json"


def _load() -> list[dict]:
    if not NOTES_FILE.exists():
        return []
    try:
        return json.loads(NOTES_FILE.read_text())
    except json.JSONDecodeError:
        return []


def _save(notes: list[dict]) -> None:
    NOTES_FILE.write_text(json.dumps(notes, indent=2))


@tool("save_note", "Save a note with a title and body.", {"title": str, "body": str})
async def save_note(args: dict) -> dict:
    notes = _load()
    notes.append(
        {
            "title": args["title"],
            "body": args["body"],
            "created_at": datetime.now().isoformat(),
        }
    )
    _save(notes)
    return {
        "content": [
            {"type": "text", "text": f"Saved note '{args['title']}' ({len(notes)} total)."}
        ]
    }


@tool("recent_notes", "Return the 10 most recent notes, newest first.", {})
async def recent_notes(_args: dict) -> dict:
    notes = _load()
    if not notes:
        return {"content": [{"type": "text", "text": "No notes yet."}]}
    recent = list(reversed(notes))[:10]
    formatted = "\n\n---\n\n".join(
        f"# {n['title']}\n({n['created_at']})\n\n{n['body']}" for n in recent
    )
    return {"content": [{"type": "text", "text": formatted}]}


notes_server = create_sdk_mcp_server(
    name="notes",
    version="1.0.0",
    tools=[save_note, recent_notes],
)


async def main() -> None:
    options = ClaudeAgentOptions(
        mcp_servers={"notes": notes_server},
        # Tool names are namespaced mcp__<server>__<tool>.
        allowed_tools=["mcp__notes__save_note", "mcp__notes__recent_notes"],
    )
    prompt = (
        "Save a note titled 'in-process mcp wired up' with body "
        "'Built the same notes server inside the Agent SDK — no subprocess.' "
        "Then list my recent notes."
    )
    async for message in query(prompt=prompt, options=options):
        print(message)


if __name__ == "__main__":
    asyncio.run(main())
