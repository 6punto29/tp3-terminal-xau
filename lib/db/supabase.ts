// ─────────────────────────────────────────────────────────────────────────────
// lib/db/supabase.ts
// SERVER-ONLY Supabase client using the service role key.
// Never import this file from a Client Component or the browser.
//
// Cambios v3:
// · Bug 5.2 — agregado campo `capital_momento` al tipo OperationRow.
//   Refleja el capital de la cuenta en el momento de abrir la operación,
//   permite calcular % cuenta histórico preciso aunque el capital cambie después.
//   Requiere columna `capital_momento NUMERIC` en tabla `xau_usd` (ya creada).
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
  id:                string;
  user_id:           string;
  fecha:             string;
  direccion:         "LONG" | "SHORT";
  precio_entrada:    number;
  sl:                number;
  tp:                number;
  lotaje:            number | null;   // lotaje real usado en MT5
  resultado:         "TP" | "SL" | "MANUAL" | null;
  pnl:               number | null;   // P&L en dólares reales (no porcentaje)
  capital_momento:   number | null;   // capital de cuenta al abrir la op (null = ops viejas pre-fix)
  created_at:        string;
}
