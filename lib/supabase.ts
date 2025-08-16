import { createClient, SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

/**
 * Returns a Supabase client configured for server-side use when a service role key is present.
 * Falls back to anon key if only anon key is available (not recommended for server logging).
 */
export function getSupabaseClient(): SupabaseClient {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Supabase.env variables not set: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY required');
  }

  // Use service role key when available for privileged server operations (logging)
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });
}

/**
 * Log a Bright Data request/response record to the `bd_logs` table.
 * - table schema expected: (id uuid PK, source text, endpoint text, method text, request jsonb, response jsonb, status text, created_at timestamptz)
 *
 * Example usage:
 *   const sb = getSupabaseClient();
 *   await logBrightDataInteraction(sb, { source: 'unlocker', endpoint: '/unlock', method: 'POST', request, response, status: 'ok' });
 */
export async function logBrightDataInteraction(
  supabase: SupabaseClient,
  opts: {
    source: string;
    endpoint: string;
    method: string;
    request: any;
    response: any;
    status?: 'ok' | 'error' | 'dry-run';
    meta?: Record<string, any>;
  }
) {
  const payload = {
    source: opts.source,
    endpoint: opts.endpoint,
    method: opts.method,
    request: opts.request,
    response: opts.response,
    status: opts.status || 'ok',
    meta: opts.meta || {},
    created_at: new Date().toISOString(),
  };

  const { error } = await supabase.from('bd_logs').insert(payload);
  if (error) {
    // Best-effort logging failure shouldn't crash calling route
    // Use console.error because routes run server-side
    // and we don't want to throw during request handling
    // eslint-disable-next-line no-console
    console.error('Supabase logging failed:', error);
    return { ok: false, error };
  }

  return { ok: true };
}