import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Env } from './env.js';

export function db(env: Env): SupabaseClient | null {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return null;
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });
}
