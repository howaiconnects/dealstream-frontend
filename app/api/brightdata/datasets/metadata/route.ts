import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient, logBrightDataInteraction } from "../../../../lib/supabase";
import { datasetMetadataUrl } from "../../../../lib/brightdata-datasets";

/**
 * Proxy route for Bright Data Marketplace - Get Dataset Metadata
 * GET /api/brightdata/datasets/metadata?dataset_id=...
 *
 * Behavior:
 * - Requires BRIGHTDATA_API_TOKEN in server env (returns 400 if missing).
 * - Idempotent, cache-friendly GET that proxies Bright Data dataset metadata.
 * - Best-effort Supabase logging to bd_logs via logBrightDataInteraction; logging failures are swallowed.
 *
 * Example:
 *  GET /api/brightdata/datasets/metadata?dataset_id=dataset_abc123
 */

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const start = Date.now();
  try {
    const token = process.env.BRIGHTDATA_API_TOKEN;
    if (!token) {
      return NextResponse.json({ error: "Missing BRIGHTDATA_API_TOKEN" }, { status: 400 });
    }

    const dataset_id = req.nextUrl.searchParams.get("dataset_id");
    if (!dataset_id) {
      return NextResponse.json({ error: "dataset_id query parameter is required" }, { status: 400 });
    }

    const url = datasetMetadataUrl(dataset_id);

    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    const text = await res.text();
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {
      // keep as text
    }

    // Best-effort Supabase logging
    try {
      const supabase = getSupabaseClient();
      if (supabase) {
        await logBrightDataInteraction(supabase, {
          source: "marketplace_dataset",
          endpoint: "/marketplace/datasets/:dataset_id/metadata",
          method: "GET",
          request: { dataset_id },
          response: { status: res.status, body: data },
          status: res.status >= 200 && res.status < 300 ? "ok" : "error",
          meta: { duration_ms: Date.now() - start },
        });
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("Supabase logging (dataset-metadata) failed:", (e as any)?.message || e);
    }

    const headers: Record<string, string> = {};
    const contentType = res.headers.get("Content-Type");
    if (contentType) headers["Content-Type"] = contentType;

    return new NextResponse(typeof data === "string" ? data : JSON.stringify(data), {
      status: res.status,
      headers,
    });
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.error("Marketplace dataset-metadata proxy error:", err);
    return NextResponse.json({ error: "Internal proxy error", detail: err?.message || String(err) }, { status: 500 });
  }
}