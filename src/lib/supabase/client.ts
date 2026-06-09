import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cachedClient: SupabaseClient | null = null;

function getSupabasePublicKey() {
  return (
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}

export function isSupabaseConfigured() {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && getSupabasePublicKey());
}

export function getSupabaseBrowserClient() {
  if (!isSupabaseConfigured()) return null;

  if (!cachedClient) {
    cachedClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      getSupabasePublicKey()!
    );
  }

  return cachedClient;
}
