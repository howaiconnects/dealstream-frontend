import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient, logBrightDataInteraction } from "../../../../lib/supabase";

export const runtime = "nodejs";

/**
 * POST { task: object }
 * - Forwards agent tasks to a hosted Web MCP server (BRIGHTDATA_MCP_URL + BRIGHTDATA_MCP_TOKEN).
 * - Returns MCP response and logs to Supabase if configured (best-effort).
 *
 * Environment variables required for MCP forwarding:
 *   BRIGHTDATA_MCP_URL
 *   BRIGHTDATA_MCP_TOKEN
 */

export async function POST(req: NextRequest) {
  const start = Date.now();
  let supabase = null;
  try {
    const { BRIGHTDATA_MCP_URL, BRIGHTDATA_MCP_TOKEN } = process.env;
    if (!BRIGHTDATA_MCP_URL || !BRIGHTDATA_MCP_TOKEN) {
      return NextResponse.json({ error: "MCP not configured" }, { status: 400 });
    }

    const body = await req.json();
    if (!body || Object.keys(body).length === 0) {
      return NextResponse.json({ error: "Missing task body" }, { status: 400 });
    }

    const mcpUrl = BRIGHTDATA_MCP_URL.replace(/\/$/, "") + "/agent/run";

    const r = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${BRIGHTDATA_MCP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await r.json();

    // Best-effort supabase logging
    try {
      supabase = getSupabaseClient();
      if (supabase) {
        await logBrightDataInteraction(supabase, {
          source: "mcp",
          endpoint: "/agent/run",
          method: "POST",
          request: body,
          response: { status: r.status, body: data },
          status: r.status >= 200 && r.status < 300 ? "ok" : "error",
          meta: { duration_ms: Date.now() - start },
        });
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("Supabase logging (mcp) failed:", (e as any)?.message || e);
    }

    return NextResponse.json(data, { status: r.status });
  } catch (err: any) {
    try {
      supabase = getSupabaseClient();
      if (supabase) {
        await logBrightDataInteraction(supabase, {
          source: "mcp",
          endpoint: "error",
          method: "POST",
          request: {},
          response: { error: err.message || String(err) },
          status: "error",
          meta: { duration_ms: Date.now() - start },
        });
      }
    } catch {}
    return NextResponse.json({ error: err.message || "MCP error" }, { status: 500 });
  }
}