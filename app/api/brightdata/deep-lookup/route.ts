import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient, logBrightDataInteraction } from "../../../../lib/supabase";

export const runtime = "nodejs";

/**
 * POST { query: string, filters?: any, dryRun?: boolean }
 * - Forwards NLQ queries to Bright Data Deep Lookup API using BRIGHTDATA_API_TOKEN.
 * - If Supabase is configured, logs the request/response to bd_logs table (best-effort).
 *
 * Environment variables required:
 *   BRIGHTDATA_API_TOKEN
 *   (Optional) SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

export async function POST(req: NextRequest) {
  const start = Date.now();
  let supabase = null;
  try {
    if (!process.env.BRIGHTDATA_API_TOKEN) {
      return NextResponse.json({ error: "Missing BRIGHTDATA_API_TOKEN" }, { status: 400 });
    }

    const body = await req.json();
    const { query, filters = {}, dryRun = false } = body || {};

    if (!query) {
      return NextResponse.json({ error: "Missing query" }, { status: 400 });
    }

    // Build request payload; when dryRun is true, request minimal data (if API supports)
    const payload: any = { query, filters };
    if (dryRun) {
      payload.limit = 1;
    }

    const res = await fetch("https://api.brightdata.com/deep-lookup/query", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.BRIGHTDATA_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    // Best-effort supabase logging
    try {
      supabase = getSupabaseClient();
      if (supabase) {
        await logBrightDataInteraction(supabase, {
          source: "deep_lookup",
          endpoint: "/deep-lookup/query",
          method: "POST",
          request: { query, filters, dryRun },
          response: { status: res.status, body: data },
          status: res.status >= 200 && res.status < 300 ? "ok" : "error",
          meta: { duration_ms: Date.now() - start },
        });
      }
    } catch (e) {
      // swallow logging errors
      // eslint-disable-next-line no-console
      console.error("Supabase logging (deep-lookup) failed:", (e as any)?.message || e);
    }

    return NextResponse.json(data, { status: res.status });
  } catch (err: any) {
    // Attempt to log error
    try {
      supabase = getSupabaseClient();
      if (supabase) {
        await logBrightDataInteraction(supabase, {
          source: "deep_lookup",
          endpoint: "error",
          method: "POST",
          request: {},
          response: { error: err.message || String(err) },
          status: "error",
          meta: { duration_ms: Date.now() - start },
        });
      }
    } catch {}
    return NextResponse.json({ error: err.message || "Deep Lookup error" }, { status: 500 });
  }
}