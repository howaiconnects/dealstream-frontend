import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient, logBrightDataInteraction } from "../../../../lib/supabase";

export const runtime = "nodejs";

/**
 * POST { endpoint: string, payload?: any, dryRun?: boolean }
 * - Triggers a Bright Data Scraper Library / IDE endpoint via BRIGHTDATA_API_TOKEN.
 * - Returns job response (job id / results) and logs to Supabase if configured.
 *
 * Environment variables required:
 *   BRIGHTDATA_API_TOKEN
 *   (Optional) SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * Notes:
 * - Prefer using library endpoints that return structured data in one call to minimize credits.
 * - Use dryRun to cap results or request a lightweight mode if the endpoint supports it.
 */

export async function POST(req: NextRequest) {
  const start = Date.now();
  let supabase = null;
  try {
    if (!process.env.BRIGHTDATA_API_TOKEN) {
      return NextResponse.json({ error: "Missing BRIGHTDATA_API_TOKEN" }, { status: 400 });
    }

    const body = await req.json();
    const { endpoint, payload = {}, dryRun = false } = body || {};

    if (!endpoint) {
      return NextResponse.json({ error: "Missing endpoint" }, { status: 400 });
    }

    // Optionally modify payload for dry runs to limit results
    const execPayload = { ...payload };
    if (dryRun) {
      // common guard: add limit=10 if not present
      if (typeof execPayload.limit === "undefined") {
        execPayload.limit = 10;
      }
    }

    const res = await fetch(`https://api.brightdata.com/datasets/v3/execute/${encodeURIComponent(endpoint)}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.BRIGHTDATA_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(execPayload),
    });

    const data = await res.json();

    // Best-effort supabase logging
    try {
      supabase = getSupabaseClient();
      if (supabase) {
        await logBrightDataInteraction(supabase, {
          source: "scraper",
          endpoint: `/datasets/v3/execute/${endpoint}`,
          method: "POST",
          request: execPayload,
          response: { status: res.status, body: data },
          status: res.status >= 200 && res.status < 300 ? "ok" : "error",
          meta: { duration_ms: Date.now() - start },
        });
      }
    } catch (e) {
      // swallow supabase errors
      // eslint-disable-next-line no-console
      console.error("Supabase logging (scraper) failed:", (e as any)?.message || e);
    }

    return NextResponse.json(data, { status: res.status });
  } catch (err: any) {
    try {
      supabase = getSupabaseClient();
      if (supabase) {
        await logBrightDataInteraction(supabase, {
          source: "scraper",
          endpoint: "error",
          method: "POST",
          request: {},
          response: { error: err.message || String(err) },
          status: "error",
          meta: { duration_ms: Date.now() - start },
        });
      }
    } catch {}
    return NextResponse.json({ error: err.message || "Scraper error" }, { status: 500 });
  }
}