import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient, logBrightDataInteraction } from "../../../../lib/supabase";
import { snapshotPartsUrl, applyDryRunGuard } from "../../../../lib/brightdata-datasets";

/**
 * Proxy route for Bright Data Marketplace - Snapshot Parts
 * POST /api/brightdata/datasets/snapshot-parts
 *
 * Body: { snapshot_id: string, dryRun?: boolean }
 *
 * Behavior:
 * - Requires BRIGHTDATA_API_TOKEN in server env (returns 400 if missing).
 * - Returns the list of parts/files for a snapshot.
 * - Best-effort Supabase logging to bd_logs via logBrightDataInteraction; logging failures are swallowed.
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
    const { snapshot_id, dryRun = false } = body as { snapshot_id?: string; dryRun?: boolean };

    if (!snapshot_id) {
      return NextResponse.json({ error: "snapshot_id is required" }, { status: 400 });
    }

    // Construct URL
    const url = snapshotPartsUrl(snapshot_id);

    // Call Bright Data
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
          endpoint: "/marketplace/datasets/snapshots/:snapshot_id/parts",
          method: "GET",
          request: { snapshot_id, dryRun },
          response: { status: res.status, body: data },
          status: res.status >= 200 && res.status < 300 ? "ok" : "error",
          meta: { duration_ms: Date.now() - start },
        });
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("Supabase logging (snapshot-parts) failed:", (e as any)?.message || e);
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
    console.error("Marketplace snapshot-parts proxy error:", err);
    return NextResponse.json({ error: "Internal proxy error", detail: err?.message || String(err) }, { status: 500 });
  }
}