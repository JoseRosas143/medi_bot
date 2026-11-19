import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!supabaseUrl || !supabaseServiceKey) {
  console.warn('⚠️ Faltan las credenciales de Supabase en las variables de entorno.');
}

// Usamos estrictamente el SERVICE_ROLE_KEY para tener permisos de escritura absolutos
// y saltarnos las políticas de seguridad (RLS) en el backend.
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});