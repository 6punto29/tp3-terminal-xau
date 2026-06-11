// ─────────────────────────────────────────────────────────────────────────────
// lib/db/supabase.ts
// SERVER-ONLY Supabase client using the service role key.
// Never import this file from a Client Component or the browser.
//
// Lo usan las rutas API server-side: /api/signals-emitted y /api/shadow-trades.
// El tipo OperationRow (tabla xau_usd, ops manuales) fue eliminado el 11/06/26
// junto con su tabla — el motor se valida por signals_emitted, no por ops manuales.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY; // service role — server only

if (!url || !key) {
  throw new Error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment variables."
  );
}

/** Use this in API routes only. Never pass it to the client. */
export const supabaseAdmin = createClient(url, key, {
  auth: { persistSession: false },
});
