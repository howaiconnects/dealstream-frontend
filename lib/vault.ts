/**
 * Minimal HashiCorp Vault helper for server-side secret retrieval.
 *
 * Behavior:
 *  - Reads VAULT_ADDR and VAULT_TOKEN (or VAULT_ROLE_ID & VAULT_SECRET_ID for AppRole) from env.
 *  - Retrieves a secret at path `secretPath` (e.g. "secret/data/dealstream/brightdata") and returns the named key (e.g. "BRIGHTDATA_API_TOKEN").
 *  - Caches retrieved secrets in-memory for `CACHE_TTL_MS` (default 5 minutes).
 *  - Falls back to local process.env when Vault fetch fails or Vault not configured.
 *
 * Usage:
 *   import { getSecret } from "./vault";
 *   const token = await getSecret("secret/data/dealstream/brightdata", "BRIGHTDATA_API_TOKEN");
 *
 * Notes:
 *  - This is intentionally small and dependency-free (uses fetch). In production, prefer the official Vault client
 *    and a more robust auth flow (AppRole, Kubernetes auth, or dedicated Vault agent).
 *  - Ensure VAULT_ADDR and appropriate auth are provisioned in your server runtime (do NOT commit tokens).
 */

type Cached = { value: string | null; expiresAt: number };

const CACHE_TTL_MS = Number(process.env.VAULT_CACHE_TTL_MS || 5 * 60 * 1000); // default 5 minutes
const cache = new Map<string, Cached>(); // key: `${path}#${keyName}`

function cacheKey(path: string, keyName: string) {
  return `${path}#${keyName}`;
}

async function fetchFromVault(path: string): Promise<any> {
  const addr = process.env.VAULT_ADDR;
  if (!addr) throw new Error("VAULT_ADDR not configured");

  // Prefer VAULT_TOKEN, otherwise AppRole (VAULT_ROLE_ID & VAULT_SECRET_ID)
  let token = process.env.VAULT_TOKEN;
  if (!token && process.env.VAULT_ROLE_ID && process.env.VAULT_SECRET_ID) {
    // Exchange role_id + secret_id for a token
    const approleUrl = `${addr.replace(/\/$/, "")}/v1/auth/approle/login`;
    const resp = await fetch(approleUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role_id: process.env.VAULT_ROLE_ID, secret_id: process.env.VAULT_SECRET_ID }),
    });
    if (!resp.ok) throw new Error(`Vault AppRole login failed: ${resp.status}`);
    const body = await resp.json().catch(() => ({}));
    token = body?.auth?.client_token;
    if (!token) throw new Error("Vault AppRole login did not return client_token");
  }

  if (!token) throw new Error("No Vault auth available (VAULT_TOKEN or AppRole required)");

  const url = `${addr.replace(/\/$/, "")}/v1/${path.replace(/^\/+/, "")}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Vault secret fetch failed: ${res.status} ${text}`);
  }

  const data = await res.json().catch(() => ({}));
  // Flexible handling for KV v2 vs v1:
  // KV v2 returns: { data: { data: { key: value }, metadata: {...} } }
  if (data && data.data && data.data.data) return data.data.data;
  if (data && data.data) return data.data;
  return data;
}

/**
 * Get a single secret value by path and key name.
 * path: Vault API path, e.g. "secret/data/dealstream/brightdata" (KV v2) or "secret/dealstream/brightdata" (KV v1)
 * keyName: the property name inside the secret object, e.g. "BRIGHTDATA_API_TOKEN"
 *
 * Behavior:
 *  - Returns process.env[keyName] if Vault not configured or fetch fails (fallback).
 *  - Caches successful Vault responses for CACHE_TTL_MS.
 */
export async function getSecret(secretPath: string, keyName: string): Promise<string | null> {
  const k = cacheKey(secretPath, keyName);
  const now = Date.now();
  const cached = cache.get(k);
  if (cached && cached.expiresAt > now) return cached.value;

  try {
    const data = await fetchFromVault(secretPath);
    const value = (data && typeof data[keyName] !== "undefined") ? String(data[keyName]) : null;
    cache.set(k, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    if (value === null) {
      // Fall back to env var if key missing in Vault
      const envVal = process.env[keyName] ?? null;
      if (envVal) return envVal;
    }
    return value;
  } catch (e) {
    // Vault fetch failed — fall back to env
    // eslint-disable-next-line no-console
    console.error("Vault fetch failed, falling back to env:", (e as any)?.message || e);
    const envVal = process.env[keyName] ?? null;
    // Cache the env fallback briefly to avoid repeated failures hammering Vault
    cache.set(k, { value: envVal, expiresAt: Date.now() + Math.min(CACHE_TTL_MS, 30 * 1000) });
    return envVal;
  }
}

/**
 * Clear cache (useful for tests)
 */
export function clearVaultCache() {
  cache.clear();
}