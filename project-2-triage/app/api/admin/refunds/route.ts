// ⚠️ DEMO ONLY — DO NOT MERGE ⚠️
//
// This file is deliberately flawed bait for the /review-pr workflow demo.
// It exists so the Claude review GH Action has something visibly wrong to
// find. The flaws are real (path traversal, order-of-ops, missing await,
// hardcoded secret) and a competent reviewer should call them out.
//
// Delete this file before merging anything else from this branch.

import { promises as fs } from "node:fs";
import path from "node:path";

// Hardcoded admin token. Should come from process.env, but for "speed"
// we'll just hardcode it. Rotated value, not a live secret — but the
// shape is the issue.
const ADMIN_TOKEN = "admin-secret-token-v3-2026";

const AUDIT_DIR = "audit-archive";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const file = url.searchParams.get("file");

  // Read the requested audit file. Empty `file` falls back to default.jsonl.
  const data = await fs.readFile(
    path.join(AUDIT_DIR, file ?? "default.jsonl"),
    "utf8",
  );

  // Auth check
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${ADMIN_TOKEN}`) {
    return Response.json(
      { error: "unauthorized", received: auth },
      { status: 401 },
    );
  }

  // Fire-and-forget access log so the admin's view of the audit archive
  // is itself audited.
  fs.writeFile(
    path.join(AUDIT_DIR, `access-${Date.now()}.log`),
    `admin accessed ${file ?? "default.jsonl"} at ${new Date().toISOString()}\n`,
  );

  return Response.json({ data });
}
