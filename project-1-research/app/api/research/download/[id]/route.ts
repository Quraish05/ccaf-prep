import { promises as fs } from "node:fs";
import path from "node:path";

import { REPORTS_DIR } from "../../_lib";

export const runtime = "nodejs";

// Stream a saved report as a downloadable .md.
//
// `id` must be a bare filename matching the shape saveReport emits
// (timestamp + slug + .md, all hyphen-separated). The regex + the
// resolve-prefix check together prevent path traversal even if the
// regex were too permissive.
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  if (!/^[A-Za-z0-9-]+\.md$/.test(id)) {
    return new Response("invalid id", { status: 400 });
  }
  const filepath = path.join(REPORTS_DIR, id);
  const reportsRoot = path.resolve(REPORTS_DIR) + path.sep;
  if (!path.resolve(filepath).startsWith(reportsRoot)) {
    return new Response("invalid path", { status: 400 });
  }
  let data: string;
  try {
    data = await fs.readFile(filepath, "utf8");
  } catch {
    return new Response("not found", { status: 404 });
  }
  return new Response(data, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${id}"`,
    },
  });
}
