import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();
export const liveConfigured = Boolean(url && anonKey);
let client: SupabaseClient | null = null;

/** Lazy: opening the offline workbench never starts auth refresh or any network request. */
export function getSupabaseClient(): SupabaseClient | null {
  if (!url || !anonKey) return null;
  client ??= createClient(url, anonKey);
  return client;
}
