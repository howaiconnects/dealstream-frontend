import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient, logBrightDataInteraction } from "../../../../lib/supabase";

/**
 * Proxy route for Bright Data Marketplace - Get Snapshot Meta
 * POST /api/brightdata/datasets/snapshot-meta
 *
 * Body: { snapshot_id: string, dryRun?: boolean }
 *
 * Behavior:
 * - Requires BRIGHTDATA_API_TOKEN in server env (returns 400 if missing).
 * - Best-effort Supabase logging to bd_logs via logBrightDataInteraction; logging failures are swallowed.
 * - Returns Bright Data response as-is (status + json).
 *
 * Docs: https://docs.brightdata.com/api-reference/marketplace-dataset-api/get-snapshot-meta
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
    const { snapshot_id } = body as { snapshot_id?: string };

    if (!snapshot_id) {
      return NextResponse.json({ error: "snapshot_id is required" }, { status: 400 });
    }

    const url = `https://api.brightdata.com/marketplace/datasets/snapshots/${encodeURIComponent(snapshot_id)}/meta`;

    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
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
          endpoint: "/marketplace/datasets/snapshots/:snapshot_id/meta",
          method: "GET",
          request: { snapshot_id },
          response: { status: res.status, body: data },
          status: res.status >= 200 && res.status < 300 ? "ok" : "error",
          meta: { duration_ms: Date.now() - start },
        });
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("Supabase logging (snapshot-meta) failed:", (e as any)?.message || e);
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
    console.error("Marketplace snapshot-meta proxy error:", err);
    return NextResponse.json({ error: "Internal proxy error", detail: err?.message || String(err) }, { status: 500 });
  }
}