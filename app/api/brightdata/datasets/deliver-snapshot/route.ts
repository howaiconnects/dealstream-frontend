import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient, logBrightDataInteraction } from "../../../../lib/supabase";
import { deliverSnapshotUrl } from "../../../../lib/brightdata-datasets";
import { getSecret } from "../../../../lib/vault";

/**
 * Proxy route for Bright Data Marketplace - Deliver Snapshot
 * POST /api/brightdata/datasets/deliver-snapshot
 *
 * Body: { snapshot_id: string, delivery_params?: any, dryRun?: boolean }
 *
 * Behavior:
 * - Retrieves BRIGHTDATA_API_TOKEN from Vault (via getSecret) with env fallback.
 * - For dryRun, returns a simulated response and logs as dry-run.
 * - For non-dry runs, posts delivery_params to Bright Data deliver endpoint.
 * - Best-effort Supabase logging to bd_logs via logBrightDataInteraction; logging failures are swallowed.
 *
 * Safety:
 * - This endpoint performs an operation that may trigger dataset delivery and incur costs.
 * - Use dryRun=true for testing. Consider adding admin gating (X-Admin-Confirm) in production.
 */

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const start = Date.now();
  let supabase = null;
  try {
    const body = await req.json().catch(() => ({}));
    const { snapshot_id, delivery_params = {}, dryRun = false } = body as {
      snapshot_id?: string;
      delivery_params?: Record<string, any>;
      dryRun?: boolean;
    };

    if (!snapshot_id) {
      return NextResponse.json({ error: "snapshot_id is required" }, { status: 400 });
    }

    // Retrieve token via Vault helper (with env fallback)
    const token = await getSecret("secret/data/dealstream/brightdata", "BRIGHTDATA_API_TOKEN");
    if (!token) {
      return NextResponse.json({ error: "Missing BRIGHTDATA_API_TOKEN (Vault/env fallback)" }, { status: 500 });
    }

    const url = deliverSnapshotUrl(snapshot_id);

    if (dryRun) {
      const simulated = { ok: true, snapshot_id, delivered: false, note: "dry-run: no delivery performed" };
      try {
        supabase = getSupabaseClient();
        if (supabase) {
          await logBrightDataInteraction(supabase, {
            source: "marketplace_dataset",
            endpoint: "/marketplace/datasets/snapshots/:snapshot_id/deliver (dry-run)",
            method: "POST",
            request: { snapshot_id, delivery_params, dryRun },
            response: { status: 200, body: simulated },
            status: "dry-run",
            meta: { duration_ms: Date.now() - start },
          });
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("Supabase logging (deliver-snapshot dry-run) failed:", (e as any)?.message || e);
      }
      return NextResponse.json(simulated, { status: 200 });
    }

    // Perform real delivery
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(delivery_params),
    });

    const text = await res.text();
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {
      // leave as text
    }

    // Log to Supabase (best-effort)
    try {
      supabase = getSupabaseClient();
      if (supabase) {
        await logBrightDataInteraction(supabase, {
          source: "marketplace_dataset",
          endpoint: "/marketplace/datasets/snapshots/:snapshot_id/deliver",
          method: "POST",
          request: { snapshot_id, delivery_params },
          response: { status: res.status, body: data },
          status: res.status >= 200 && res.status < 300 ? "ok" : "error",
          meta: { duration_ms: Date.now() - start },
        });
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("Supabase logging (deliver-snapshot) failed:", (e as any)?.message || e);
    }

    const headers: Record<string, string> = {};
    const contentType = res.headers.get("Content-Type");
    if (contentType) headers["Content-Type"] = contentType;

    return new NextResponse(typeof data === "string" ? data : JSON.stringify(data), {
      status: res.status,
      headers,
    });
  } catch (err: any) {
    try {
      supabase = getSupabaseClient();
      if (supabase) {
        await logBrightDataInteraction(supabase, {
          source: "marketplace_dataset",
          endpoint: "/marketplace/datasets/snapshots/:snapshot_id/deliver",
          method: "POST",
          request: {},
          response: { error: err.message || String(err) },
          status: "error",
          meta: { duration_ms: Date.now() - start },
        });
      }
    } catch {}
    // eslint-disable-next-line no-console
    console.error("Marketplace deliver-snapshot proxy error:", err);
    return NextResponse.json({ error: "Internal proxy error", detail: err?.message || String(err) }, { status: 500 });
  }
}