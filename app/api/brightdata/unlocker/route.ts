import { NextRequest, NextResponse } from "next/server";
import { HttpsProxyAgent } from "https-proxy-agent";
import { getSupabaseClient, logBrightDataInteraction } from "../../../../lib/supabase";

export const runtime = "nodejs";

/**
 * POST { url: string, headers?: Record<string,string>, dryRun?: boolean }
 * - Uses Bright Data Unlocker via native proxy auth to fetch a target URL server-side.
 * - Returns { status, text, headers } on success.
 * - If Supabase is configured, logs the request/response to bd_logs table (best-effort).
 *
 * Environment variables required for Unlocker:
 *   BRIGHTDATA_PROXY_HOST
 *   BRIGHTDATA_PROXY_PORT
 *   BRIGHTDATA_PROXY_USER
 *   BRIGHTDATA_PROXY_PASS
 *
 * Note: Keep these server-side only (.env.local, not exposed to browser)
 */

function assertEnv() {
  const {
    BRIGHTDATA_PROXY_HOST,
    BRIGHTDATA_PROXY_PORT,
    BRIGHTDATA_PROXY_USER,
    BRIGHTDATA_PROXY_PASS,
  } = process.env;
  if (!BRIGHTDATA_PROXY_HOST || !BRIGHTDATA_PROXY_PORT || !BRIGHTDATA_PROXY_USER || !BRIGHTDATA_PROXY_PASS) {
    throw new Error("Missing Bright Data Unlocker proxy env vars");
  }
}

export async function POST(req: NextRequest) {
  const start = Date.now();
  let supabase = null;
  try {
    assertEnv();

    const body = await req.json();
    const { url, headers = {}, dryRun = false } = body || {};

    if (!url) {
      return NextResponse.json({ error: "Missing url" }, { status: 400 });
    }

    // Construct proxy agent for node fetch
    const agent = new HttpsProxyAgent({
      host: process.env.BRIGHTDATA_PROXY_HOST!,
      port: Number(process.env.BRIGHTDATA_PROXY_PORT || 22225),
      auth: `${process.env.BRIGHTDATA_PROXY_USER}:${process.env.BRIGHTDATA_PROXY_PASS}`,
    });

    // If dryRun is true, only fetch HEAD to conserve credits
    const fetchOptions: any = { method: dryRun ? "HEAD" : "GET", headers };
    // @ts-expect-error - Node fetch agent typing
    fetchOptions.agent = agent;

    const res = await fetch(url, fetchOptions);
    const status = res.status;
    const resHeaders = Object.fromEntries(res.headers.entries ? res.headers.entries() : []);
    const text = dryRun ? "" : await res.text();

    // Best-effort supabase logging (disabled if env missing)
    try {
      supabase = getSupabaseClient();
      if (supabase) {
        await logBrightDataInteraction(supabase, {
          source: "unlocker",
          endpoint: url,
          method: fetchOptions.method,
          request: { headers, dryRun },
          response: { status, headers: resHeaders, length: text ? text.length : 0 },
          status: status >= 200 && status < 300 ? "ok" : "error",
          meta: { duration_ms: Date.now() - start },
        });
      }
    } catch (e) {
      // swallow supabase errors to avoid failing the main request
      // eslint-disable-next-line no-console
      console.error("Supabase logging (unlocker) failed:", (e as any)?.message || e);
    }

    return NextResponse.json({ status, text, headers: resHeaders }, { status });
  } catch (err: any) {
    // Log error to supabase if available
    try {
      supabase = getSupabaseClient();
      if (supabase) {
        await logBrightDataInteraction(supabase, {
          source: "unlocker",
          endpoint: "error",
          method: "POST",
          request: {},
          response: { error: err.message || String(err) },
          status: "error",
          meta: { duration_ms: Date.now() - start },
        });
      }
    } catch {}
    return NextResponse.json({ error: err.message || "Unlocker error" }, { status: 500 });
  }
}