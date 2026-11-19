import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Si falta la variable en Vercel, detenemos el proceso con un mensaje claro
if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('🚨 ERROR CRÍTICO: La variable SUPABASE_SERVICE_ROLE_KEY no está configurada en Vercel o está vacía.');
}

// Conexión con permisos absolutos (ignora el RLS)
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});