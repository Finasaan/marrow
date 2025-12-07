import { createClient } from "@supabase/supabase-js";

/**
 * Helper to get secret value from Secrets Store binding or direct env var
 * Secrets Store bindings are Fetcher objects that need .get() method
 */
async function getSecretValue(value: any): Promise<string | null> {
  if (!value) return null;

  // If it's a string, return it directly (dev environment or plain env vars)
  if (typeof value === "string") {
    return value;
  }

  // If it's a Secrets Store binding (has get method), fetch the secret
  if (value && typeof value.get === "function") {
    try {
      const secretValue = await value.get();
      return secretValue ? String(secretValue) : null;
    } catch (error) {
      console.error("Error fetching secret from Secrets Store:", error);
      return null;
    }
  }

  return null;
}

/**
 * Environment-aware Supabase configuration
 * Determines which environment variables to use based on the deployment context
 */
async function getSupabaseConfig(env: any): Promise<{
  url: string;
  key: string;
}> {
  // Try development environment first (plain strings)
  const devUrl = await getSecretValue(env.SUPABASE_URL);
  const devKey = await getSecretValue(env.SUPABASE_KEY);
  if (devUrl && devKey) {
    console.log("Using development Supabase credentials from env vars");
    return { url: devUrl, key: devKey };
  }

  // Check for production secrets (Secrets Store bindings)
  const prodUrl = await getSecretValue(env.SUPABASE_URL_PRODUCTION);
  const prodKey = await getSecretValue(env.SUPABASE_ANON_KEY_PRODUCTION);
  if (prodUrl && prodKey) {
    console.log("Using production Supabase credentials from Secrets Store");
    return { url: prodUrl, key: prodKey };
  }

  // Check for preview secrets (Secrets Store bindings)
  const previewUrl = await getSecretValue(env.SUPABASE_URL_PREVIEW);
  const previewKey = await getSecretValue(env.SUPABASE_ANON_KEY_PREVIEW);
  if (previewUrl && previewKey) {
    console.log("Using preview Supabase credentials from Secrets Store");
    return { url: previewUrl, key: previewKey };
  }

  throw new Error(
    "Supabase configuration not found. Please set environment variables: SUPABASE_URL_PRODUCTION/SUPABASE_ANON_KEY_PRODUCTION (prod) or SUPABASE_URL_PREVIEW/SUPABASE_ANON_KEY_PREVIEW (preview) or SUPABASE_URL/SUPABASE_KEY (dev)"
  );
}

/**
 * Creates a Supabase client from Cloudflare Worker environment bindings
 * Automatically selects the correct credentials based on the deployment environment:
 * - Production: Uses SUPABASE_URL_PRODUCTION and SUPABASE_ANON_KEY_PRODUCTION from Secrets Store
 * - Preview: Uses SUPABASE_URL_PREVIEW and SUPABASE_ANON_KEY_PREVIEW from Secrets Store
 * - Development: Uses SUPABASE_URL and SUPABASE_KEY from .dev.vars
 *
 * Note: When using secrets_store_secrets in wrangler.jsonc, the bindings are Fetcher objects
 * that require calling .get() to retrieve the actual secret values.
 */
export async function getSupabaseClient(env: {
  SUPABASE_URL?: string | any;
  SUPABASE_KEY?: string | any;
  SUPABASE_URL_PRODUCTION?: string | any;
  SUPABASE_ANON_KEY_PRODUCTION?: string | any;
  SUPABASE_URL_PREVIEW?: string | any;
  SUPABASE_ANON_KEY_PREVIEW?: string | any;
}) {
  const config = await getSupabaseConfig(env);
  console.log("Using Supabase URL:", config.url);
  return createClient(config.url, config.key);
}
