import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { Database } from "./schema";

export type SupabaseClientType = SupabaseClient<Database>;

/**
 * Creates a Supabase client instance for database operations
 * Uses environment variables for connection credentials
 *
 * @param supabaseUrl - The Supabase project URL
 * @param supabaseKey - The Supabase anon/public key
 * @returns Supabase client instance typed with our database schema
 */
export function createSupabaseClient(
  supabaseUrl: string,
  supabaseKey: string
): SupabaseClientType {
  return createClient<Database>(supabaseUrl, supabaseKey);
}

/**
 * Creates a Supabase client from Cloudflare Worker environment bindings
 *
 * @param env - Cloudflare Worker environment bindings
 * @returns Supabase client instance
 */
export function getSupabaseClient(env: {
  SUPABASE_URL: string;
  SUPABASE_KEY: string;
}): SupabaseClientType {
  return createSupabaseClient(env.SUPABASE_URL, env.SUPABASE_KEY);
}

export { Database };
