import { createClient } from '@supabase/supabase-js';

/**
 * Privileged client that bypasses row-level security. Server-only: use it for the admin console unlock and the
 * scheduled statement job, never for requests that should run as the signed-in person, and never expose the key.
 */
export function createSupabaseServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured.');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
