import { createClient, SupabaseClient } from '@supabase/supabase-js';

const FALLBACK_DEV_URL = 'http://127.0.0.1:54321';
const FALLBACK_DEV_ANON_KEY = 'countup-dev-anon-key-placeholder';

const supabaseUrl =
  (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() || FALLBACK_DEV_URL;
const supabaseAnonKey =
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim() || FALLBACK_DEV_ANON_KEY;

if (typeof window !== 'undefined' && supabaseAnonKey.toLowerCase().includes('service_role')) {
  throw new Error('Security error: service_role key must never be used in client configuration.');
}

/**
 * Browser Supabase client using the public anon/publishable key only.
 * Row-Level Security and Edge Function authorization enforce every access check.
 */
export const supabase: SupabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: 'countup_supabase_auth',
  },
});

export function getTurnstileSiteKey(): string {
  return ((import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined) ?? '').trim();
}

export function isSupabaseConfigured(): boolean {
  const rawUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() ?? '';
  const rawKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim() ?? '';
  return Boolean(rawUrl && rawKey);
}
