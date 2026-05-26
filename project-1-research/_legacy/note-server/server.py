#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["mcp>=1.2.0"]
# ///
"""Minimal MCP server: one tool (save_note) and one resource (notes://recent)."""

import json
from datetime import datetime
from pathlib import Path

from mcp.server.fastmcp import FastMCP

NOTES_FILE = Path.home() / ".notes-mcp.json"

mcp = FastMCP("notes")


def _load() -> list[dict]:
    if not NOTES_FILE.exists():
        return []
    try:
        return json.loads(NOTES_FILE.read_text())
    except json.JSONDecodeError:
        return []


def _save(notes: list[dict]) -> None:
    NOTES_FILE.write_text(json.dumps(notes, indent=2))


@mcp.tool()
def save_note(title: str, body: str) -> str:
    """Save a note with a title and body. Returns a confirmation."""
    notes = _load()
    notes.append(
        {"title": title, "body": body, "created_at": datetime.now().isoformat()}
    )
    _save(notes)
    return f"Saved note '{title}' ({len(notes)} total)."


@mcp.resource("notes://recent")
def recent_notes() -> str:
    """Return the 10 most recent notes, newest first."""
    notes = _load()
    if not notes:
        return "No notes yet."
    recent = list(reversed(notes))[:10]
    return "\n\n---\n\n".join(
        f"# {n['title']}\n({n['created_at']})\n\n{n['body']}" for n in recent
    )


if __name__ == "__main__":
    mcp.run()  # defaults to stdio transport
