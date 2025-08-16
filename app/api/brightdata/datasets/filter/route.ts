import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient, logBrightDataInteraction } from "../../../../lib/supabase";

/**
 * Proxy route for Bright Data Marketplace - Filter Dataset
 * POST /api/brightdata/datasets/filter
 *
 * Body: { dataset_id?: string, query?: object, file_url?: string, dryRun?: boolean, limit?: number, [otherBrightDataProps]: any }
 *
 * Behavior:
 * - Requires BRIGHTDATA_API_TOKEN in server env (returns 400 if missing).
 * - When dryRun is true, forces a conservative limit (1) to avoid heavy costs.
 * - Best-effort Supabase logging to bd_logs via logBrightDataInteraction; logging failures are swallowed.
 * - Returns Bright Data response as-is (status + json).
 *
 * Notes:
 * - This file is server-only. Do NOT expose BRIGHTDATA_API_TOKEN to the client.
 * - Adjust path or payload mapping to Bright Data if your API shape differs.
 */

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const start = Date.now();
  try {
    const token = process.env.BRIGHTDATA_API_TOKEN;
    if (!token) {
      return NextResponse.json({ error: "Missing BRIGHTDATA_API_TOKEN" }, { status: 400 });
    }

    const body = await req.json().catch(() => ({}));
    const {
      dryRun = false,
      limit: incomingLimit,
      ...payload
    } = body as Record<string, any>;

    // Apply dry-run guard: keep results very small
    if (dryRun) {
      payload.limit = Math.min(incomingLimit || 1, 1);
    } else if (incomingLimit) {
      payload.limit = incomingLimit;
    }

    // Construct Bright Data Marketplace filter endpoint
    // Docs: https://docs.brightdata.com/api-reference/marketplace-dataset-api/filter-dataset
    const url = "https://api.brightdata.com/marketplace/datasets/filter";

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await res.text().then((t) => {
      try {
        return JSON.parse(t);
      } catch {
        return t;
      }
    });

    // Best-effort Supabase logging
    try {
      const supabase = getSupabaseClient();
      if (supabase) {
        await logBrightDataInteraction(supabase, {
          source: "marketplace_dataset",
          endpoint: "/marketplace/datasets/filter",
          method: "POST",
          request: { payload, dryRun },
          response: { status: res.status, body: data },
          status: res.status >= 200 && res.status < 300 ? "ok" : "error",
          meta: { duration_ms: Date.now() - start },
        });
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("Supabase logging (marketplace filter) failed:", (e as any)?.message || e);
    }

    const headers: Record<string, string> = {};
    // Mirror some response headers if needed (Content-Type)
    const contentType = res.headers.get("Content-Type");
    if (contentType) headers["Content-Type"] = contentType;

    return new NextResponse(typeof data === "string" ? data : JSON.stringify(data), {
      status: res.status,
      headers,
    });
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.error("Marketplace filter proxy error:", err);
    return NextResponse.json({ error: "Internal proxy error", detail: err?.message || String(err) }, { status: 500 });
  }
}