import { createClient } from '@supabase/supabase-js';

function requiredEnvironment(name: 'NEXT_PUBLIC_SUPABASE_URL' | 'SUPABASE_SERVICE_ROLE_KEY'): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/** Server-only Supabase client. Do not import this module from Client Components. */
export const supabaseAdmin = createClient(
  requiredEnvironment('NEXT_PUBLIC_SUPABASE_URL'),
  requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
  {
    auth: { autoRefreshToken: false, persistSession: false },
  },
);
