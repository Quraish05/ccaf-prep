import { runResearch, PROD_PROFILE, saveReport } from "./_lib";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request) {
  let body: { query?: unknown };
  try {
    body = (await req.json()) as { query?: unknown };
  } catch {
    return Response.json({ error: "Body must be valid JSON" }, { status: 400 });
  }
  const userQuery = typeof body.query === "string" ? body.query.trim() : "";
  if (!userQuery) {
    return Response.json(
      { error: "Missing 'query' string in body" },
      { status: 400 },
    );
  }

  try {
    const result = await runResearch(userQuery, PROD_PROFILE);

    if (result.report === null) {
      return Response.json(
        {
          error:
            "All searchers failed; no notes were gathered, so no report could be synthesized.",
          query: userQuery,
          sub_queries: result.subQueries,
          searcher_summaries: result.searcherSummaries,
          pii_blocks: result.piiBlocks,
        },
        { status: 502 },
      );
    }

    const report_path = await saveReport(
      userQuery,
      result.report,
      result.subQueries,
      result.citations,
    );

    return Response.json({
      query: userQuery,
      sub_queries: result.subQueries,
      plan_thinking: result.planThinking,
      searcher_summaries: result.searcherSummaries,
      notes: result.notes,
      report: result.report,
      report_path,
      pii_blocks: result.piiBlocks,
      citations: result.citations,
    });
  } catch (err) {
    console.error("[/api/research] failed", err);
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
