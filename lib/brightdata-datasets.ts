/**
 * Shared Bright Data marketplace dataset helpers (server-side)
 *
 * Usage:
 *  - Import helper functions from server-only routes under app/api
 *  - Keeps BRIGHTDATA_API_TOKEN usage centralized and applies dryRun guards
 *
 * NOTE: This file is intended for server-side (API routes) only.
 * Do NOT expose BRIGHTDATA_API_TOKEN to client-side code.
 */

import { getSupabaseClient, logBrightDataInteraction } from "./supabase";

const BASE = "https://api.brightdata.com/marketplace/datasets";

import { getSecret } from "./vault";

/**
 * Ensure we have a Bright Data API token.
 * Attempts to retrieve from Vault (via getSecret). getSecret will fall back to process.env if Vault unavailable.
 * Returns token string or throws if not available.
 */
async function ensureToken(): Promise<string> {
  const token = await getSecret("secret/data/dealstream/brightdata", "BRIGHTDATA_API_TOKEN");
  if (!token) {
    throw new Error("Missing BRIGHTDATA_API_TOKEN (Vault and env fallback failed)");
  }
  return token;
}

export function marketplaceFilterUrl() {
  return `${BASE}/filter`;
}

export function snapshotMetaUrl(snapshotId: string) {
  return `${BASE}/snapshots/${encodeURIComponent(snapshotId)}/meta`;
}

export function snapshotPartsUrl(snapshotId: string) {
  return `${BASE}/snapshots/${encodeURIComponent(snapshotId)}/parts`;
}

export function snapshotDownloadUrl(snapshotId: string) {
  // Bright Data docs expose download endpoints keyed by snapshot id / file id.
  // This returns the canonical snapshot download root; callers should append query params as needed.
  return `${BASE}/snapshots/${encodeURIComponent(snapshotId)}/download`;
}

export function deliverSnapshotUrl(snapshotId: string) {
  return `${BASE}/snapshots/${encodeURIComponent(snapshotId)}/deliver`;
}

export function datasetMetadataUrl(datasetId: string) {
  return `${BASE}/${encodeURIComponent(datasetId)}/metadata`;
}

/**
 * Apply conservative dry-run guards to a payload object.
 * - For filter: force limit to 1 if dryRun true.
 * - For other endpoints the caller may choose how to modify payload.
 */
export function applyDryRunGuard(payload: Record<string, any> = {}, opts?: { dryRun?: boolean; softCap?: number }) {
  const dryRun = !!opts?.dryRun;
  const softCap = typeof opts?.softCap === "number" ? opts!.softCap : undefined;
  const out = { ...payload };
  if (dryRun) {
    // Use the smallest safe default to avoid large credit consumption
    if (typeof out.limit === "undefined") out.limit = 1;
    else out.limit = Math.min(out.limit, 1);
  } else if (softCap && typeof out.limit !== "undefined") {
    out.limit = Math.min(out.limit, softCap);
  }
  return out;
}

/**
 * Server-side fetch helper that:
 *  - ensures token is present
 *  - forwards request to Bright Data
 *  - attempts best-effort Supabase logging via lib/supabase.getSupabaseClient() and logBrightDataInteraction
 *
 * Parameters:
 *  - method: "GET" | "POST" etc
 *  - url: full URL to call
 *  - body: optional body for POST/PUT
 *  - opts: additional options like source/endpoint names for logging and dryRun flag
 */
export async function fetchBrightData(
  method: string,
  url: string,
  body?: any,
  opts?: { source?: string; endpoint?: string; dryRun?: boolean }
) {
  const start = Date.now();
  const token = await ensureToken();
  
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };

  let init: RequestInit = { method, headers };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const res = await fetch(url, init);
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
      // Provide reasonably compact request/response for logs
      await logBrightDataInteraction(supabase, {
        source: opts?.source || "marketplace_dataset",
        endpoint: opts?.endpoint || url.replace(BASE, ""),
        method,
        request: body ?? {},
        response: { status: res.status, body: data },
        status: res.status >= 200 && res.status < 300 ? "ok" : "error",
        meta: { duration_ms: Date.now() - start, dryRun: !!opts?.dryRun },
      });
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("Supabase logging (brightdata fetch) failed:", (e as any)?.message || e);
  }

  return { status: res.status, headers: res.headers, body: data };
}