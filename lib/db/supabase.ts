// ─────────────────────────────────────────────────────────────────────────────
// lib/db/supabase.ts
// SERVER-ONLY Supabase client using the service role key.
// Never import this file from a Client Component or the browser.
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

// ── Row types ─────────────────────────────────────────────────────────────────

export interface OperationRow {
  id:              string;
  user_id:         string;
  fecha:           string;
  direccion:       "LONG" | "SHORT";
  precio_entrada:  number;
  sl:              number;
  tp:              number;
  resultado:       "TP" | "SL" | "MANUAL" | null;
  pnl:             number | null;
  created_at:      string;
}
