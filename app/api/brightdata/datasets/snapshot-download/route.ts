import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient, logBrightDataInteraction } from "../../../../lib/supabase";
import { snapshotDownloadUrl } from "../../../../lib/brightdata-datasets";

/**
 * Proxy route for Bright Data Marketplace - Snapshot Download
 * POST /api/brightdata/datasets/snapshot-download
 *
 * Body: { snapshot_id: string, file_id?: string, dryRun?: boolean }
 *
 * Behavior:
 * - Requires BRIGHTDATA_API_TOKEN in server env (returns 400 if missing).
 * - If dryRun is true, returns metadata only (no large download).
 * - Proxies the Bright Data snapshot download endpoint and streams content back to caller.
 * - Best-effort Supabase logging to bd_logs via logBrightDataInteraction; logging failures are swallowed.
 *
 * Note: For large downloads this will stream through the Next.js server; consider returning a signed Bright Data URL
 *       if Bright Data provides one to avoid proxying large binary payloads through your server.
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
    const { snapshot_id, file_id, dryRun = false } = body as { snapshot_id?: string; file_id?: string; dryRun?: boolean };

    if (!snapshot_id) {
      return NextResponse.json({ error: "snapshot_id is required" }, { status: 400 });
    }

    // If dryRun, return lightweight metadata (delegate to snapshot-meta route or call metadata endpoint)
    if (dryRun) {
      const metaRes = await fetch(`https://api.brightdata.com/marketplace/datasets/snapshots/${encodeURIComponent(snapshot_id)}/meta`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      const metaText = await metaRes.text();
      let metaData: any = metaText;
      try { metaData = JSON.parse(metaText); } catch {}
      // Log dry-run
      try {
        const supabase = getSupabaseClient();
        if (supabase) {
          await logBrightDataInteraction(supabase, {
            source: "marketplace_dataset",
            endpoint: "/marketplace/datasets/snapshots/:snapshot_id/download (dry-run)",
            method: "POST",
            request: { snapshot_id, file_id, dryRun },
            response: { status: metaRes.status, body: metaData },
            status: metaRes.status >= 200 && metaRes.status < 300 ? "dry-run" : "error",
            meta: { duration_ms: Date.now() - start },
          });
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("Supabase logging (snapshot-download dry-run) failed:", (e as any)?.message || e);
      }

      return NextResponse.json(metaData, { status: metaRes.status });
    }

    // Build download URL. Append file_id as query if provided.
    let url = snapshotDownloadUrl(snapshot_id);
    if (file_id) {
      // Bright Data may accept ?file_id= or /{file_id}; using query param as a generic approach
      url = `${url}?file_id=${encodeURIComponent(file_id)}`;
    }

    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "*/*",
      },
    });

    // Stream response headers and body back to client
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      // Copy essential headers only to avoid exposing sensitive server headers
      if (["content-type", "content-disposition", "content-length", "cache-control"].includes(key.toLowerCase())) {
        headers[key] = value;
      }
    });

    // Attempt Supabase logging (metadata about download)
    try {
      const supabase = getSupabaseClient();
      if (supabase) {
        const logBody = { snapshot_id, file_id };
        let respBodyPreview: any = null;
        try {
          // Only attempt to read a small preview for logging (text up to 1KB)
          const clone = res.clone();
          const text = await clone.text();
          respBodyPreview = text.slice(0, 1024);
        } catch {
          respBodyPreview = "<binary or streaming content>";
        }
        await logBrightDataInteraction(supabase, {
          source: "marketplace_dataset",
          endpoint: "/marketplace/datasets/snapshots/:snapshot_id/download",
          method: "GET",
          request: logBody,
          response: { status: res.status, body: respBodyPreview },
          status: res.status >= 200 && res.status < 300 ? "ok" : "error",
          meta: { duration_ms: Date.now() - start },
        });
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("Supabase logging (snapshot-download) failed:", (e as any)?.message || e);
    }

    // Return streamed body. NextResponse can accept a ReadableStream in newer runtimes;
    // We'll return the response body as-is using new NextResponse with the stream and headers.
    const bodyStream = res.body;
    return new NextResponse(bodyStream, { status: res.status, headers });
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.error("Marketplace snapshot-download proxy error:", err);
    return NextResponse.json({ error: "Internal proxy error", detail: err?.message || String(err) }, { status: 500 });
  }
}