// ─────────────────────────────────────────────────────────────────────────────
// app/api/shadow-trades/route.ts
// GET    /api/shadow-trades                  — list user's shadow trades
//   query opcional: ?status=OPEN  para filtrar (lo usa el tracker)
// POST   /api/shadow-trades                  — crear evento (1 a 4 rows)
// PATCH  /api/shadow-trades                  — actualizar status de una row
//   (lo usa el tracker para WIN / LOSS / EXPIRED)
//
// Patrón espejado de /api/operations/route.ts: mismo auth helper, mismas
// validaciones, mismo estilo de respuesta. user_id se inyecta desde el JWT
// (no se confía en el cliente). RLS de la tabla usa auth.uid()::text como
// default, pero como el API corre con supabaseAdmin (service_role) bypassea
// RLS — por eso pasamos user_id explícitamente en cada query.
//
// Diseño del POST:
// El cliente manda 1 "evento" con su contexto compartido + N perfiles de TP
// válidos (entre 1 y 4). El API genera un event_id UUID y persiste N filas,
// todas con el mismo event_id y mismo SL pero distintos TP. Cada perfil
// representa una hipótesis comparativa de salida.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db/supabase";

// ── Auth helper (idéntico a /api/operations) ─────────────────────────────────
async function getUserIdFromRequest(req: NextRequest): Promise<string | null> {
  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user.id;
}

// ── Constantes de validación (espejan los CHECK constraints de la tabla) ─────
const VALID_DIRECTIONS  = ["LONG", "SHORT"] as const;
const VALID_CASE_TYPES  = ["d1_blocked", "structure_contradicts"] as const;
const VALID_TP_TYPES    = ["structural", "swing_minor", "atr_15x", "rr_15_fixed"] as const;
const VALID_STATUSES    = ["OPEN", "WIN", "LOSS", "EXPIRED"] as const;
const VALID_LIQUIDEZ    = ["alta", "baja", "weekend"] as const;
const VALID_BIAS        = ["UP", "DOWN", "WAIT"] as const;

type Direction  = (typeof VALID_DIRECTIONS)[number];
type CaseType   = (typeof VALID_CASE_TYPES)[number];
type TpType     = (typeof VALID_TP_TYPES)[number];
type StatusVal  = (typeof VALID_STATUSES)[number];
type Liquidez   = (typeof VALID_LIQUIDEZ)[number];
type BiasVal    = (typeof VALID_BIAS)[number];

// ── Validation helpers ───────────────────────────────────────────────────────
function validatePositiveNumber(value: unknown, fieldName: string): string | null {
  if (typeof value !== "number") return `${fieldName} debe ser un número`;
  if (!Number.isFinite(value)) return `${fieldName} no puede ser Infinity/NaN`;
  if (value <= 0) return `${fieldName} debe ser positivo`;
  return null;
}

function validateNumberOrNull(value: unknown, fieldName: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number") return `${fieldName} debe ser un número o null`;
  if (!Number.isFinite(value)) return `${fieldName} no puede ser Infinity/NaN`;
  return null;
}

function validateIntInRange(value: unknown, min: number, max: number, fieldName: string): string | null {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return `${fieldName} debe ser un entero`;
  }
  if (value < min || value > max) return `${fieldName} fuera de rango [${min}, ${max}]`;
  return null;
}

function validateLevels(direction: string, entry: number, sl: number, tp: number): string | null {
  if (direction === "LONG") {
    if (sl >= entry) return "En LONG el SL debe ser menor al entry";
    if (tp <= entry) return "En LONG el TP debe ser mayor al entry";
  } else if (direction === "SHORT") {
    if (sl <= entry) return "En SHORT el SL debe ser mayor al entry";
    if (tp >= entry) return "En SHORT el TP debe ser menor al entry";
  }
  return null;
}

// ── Tipos del payload del POST ────────────────────────────────────────────────
interface ShadowTpProfileInput {
  tp_type:   TpType;
  tp_price:  number;
  tp_pct:    number;
}

interface ShadowEventInput {
  case_type:       CaseType;
  direction:       Direction;
  entry_price:     number;
  sl_price:        number;
  sl_pct:          number;
  score_puro:      number;
  score_ajustado:  number;
  rsi_at_entry?:   number | null;
  atr_at_entry?:   number | null;
  liquidez?:       Liquidez | null;
  d1_bias?:        BiasVal | null;
  profiles:        ShadowTpProfileInput[];   // entre 1 y 4
}

// ── GET — listar shadow_trades del usuario ───────────────────────────────────
export async function GET(req: NextRequest) {
  const userId = await getUserIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const statusFilter = searchParams.get("status");           // 'OPEN' | 'WIN' | ...
  const limitRaw = searchParams.get("limit");
  const limit = limitRaw ? Math.min(Math.max(parseInt(limitRaw, 10) || 200, 1), 1000) : 200;

  let q = supabaseAdmin
    .from("shadow_trades")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (statusFilter && (VALID_STATUSES as readonly string[]).includes(statusFilter)) {
    q = q.eq("status", statusFilter);
  }

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(data ?? []);
}

// ── POST — crear evento (1 a 4 rows con el mismo event_id) ───────────────────
export async function POST(req: NextRequest) {
  const userId = await getUserIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: ShadowEventInput;
  try {
    body = (await req.json()) as ShadowEventInput;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // ── Validación del contexto compartido ──
  if (!body.case_type || !(VALID_CASE_TYPES as readonly string[]).includes(body.case_type)) {
    return NextResponse.json({ error: "case_type inválido" }, { status: 400 });
  }
  if (!body.direction || !(VALID_DIRECTIONS as readonly string[]).includes(body.direction)) {
    return NextResponse.json({ error: "direction inválida" }, { status: 400 });
  }

  const errEntry = validatePositiveNumber(body.entry_price, "entry_price");
  if (errEntry) return NextResponse.json({ error: errEntry }, { status: 400 });
  const errSL    = validatePositiveNumber(body.sl_price, "sl_price");
  if (errSL) return NextResponse.json({ error: errSL }, { status: 400 });
  const errSlPct = validatePositiveNumber(body.sl_pct, "sl_pct");
  if (errSlPct) return NextResponse.json({ error: errSlPct }, { status: 400 });

  const errScore  = validateIntInRange(body.score_puro, 0, 10, "score_puro");
  if (errScore) return NextResponse.json({ error: errScore }, { status: 400 });
  const errScoreA = validateIntInRange(body.score_ajustado, -10, 15, "score_ajustado");
  if (errScoreA) return NextResponse.json({ error: errScoreA }, { status: 400 });

  // Coherencia SL vs entry (lado server, defensa adicional)
  if (body.direction === "LONG" && body.sl_price >= body.entry_price) {
    return NextResponse.json({ error: "En LONG el SL debe ser menor al entry" }, { status: 400 });
  }
  if (body.direction === "SHORT" && body.sl_price <= body.entry_price) {
    return NextResponse.json({ error: "En SHORT el SL debe ser mayor al entry" }, { status: 400 });
  }

  // Campos opcionales con validación blanda
  const errRsi = validateNumberOrNull(body.rsi_at_entry, "rsi_at_entry");
  if (errRsi) return NextResponse.json({ error: errRsi }, { status: 400 });
  const errAtr = validateNumberOrNull(body.atr_at_entry, "atr_at_entry");
  if (errAtr) return NextResponse.json({ error: errAtr }, { status: 400 });

  if (body.liquidez != null && !(VALID_LIQUIDEZ as readonly string[]).includes(body.liquidez)) {
    return NextResponse.json({ error: "liquidez inválida" }, { status: 400 });
  }
  if (body.d1_bias != null && !(VALID_BIAS as readonly string[]).includes(body.d1_bias)) {
    return NextResponse.json({ error: "d1_bias inválido" }, { status: 400 });
  }

  // ── Validación de los perfiles ──
  if (!Array.isArray(body.profiles) || body.profiles.length === 0) {
    return NextResponse.json({ error: "profiles debe ser un array con al menos 1 elemento" }, { status: 400 });
  }
  if (body.profiles.length > 4) {
    return NextResponse.json({ error: "profiles no puede tener más de 4 elementos" }, { status: 400 });
  }

  const seenTpTypes = new Set<string>();
  for (const p of body.profiles) {
    if (!p.tp_type || !(VALID_TP_TYPES as readonly string[]).includes(p.tp_type)) {
      return NextResponse.json({ error: `tp_type inválido: ${p.tp_type}` }, { status: 400 });
    }
    if (seenTpTypes.has(p.tp_type)) {
      return NextResponse.json({ error: `tp_type duplicado: ${p.tp_type}` }, { status: 400 });
    }
    seenTpTypes.add(p.tp_type);

    const errTp = validatePositiveNumber(p.tp_price, `${p.tp_type}.tp_price`);
    if (errTp) return NextResponse.json({ error: errTp }, { status: 400 });
    const errTpPct = validatePositiveNumber(p.tp_pct, `${p.tp_type}.tp_pct`);
    if (errTpPct) return NextResponse.json({ error: errTpPct }, { status: 400 });

    const errLvl = validateLevels(body.direction, body.entry_price, body.sl_price, p.tp_price);
    if (errLvl) return NextResponse.json({ error: `${p.tp_type}: ${errLvl}` }, { status: 400 });
  }

  // ── Construir las N rows y hacer un solo INSERT batch ──
  // event_id se genera lado server para garantizar UUID válido sin confiar
  // en el cliente. Una sola llamada para los 4 perfiles → atomicidad real.
  const eventId = crypto.randomUUID();

  const rows = body.profiles.map((p) => ({
    event_id:       eventId,
    user_id:        userId,
    case_type:      body.case_type,
    direction:      body.direction,
    entry_price:    body.entry_price,
    sl_price:       body.sl_price,
    sl_pct:         body.sl_pct,
    tp_price:       p.tp_price,
    tp_pct:         p.tp_pct,
    tp_type:        p.tp_type,
    score_puro:     body.score_puro,
    score_ajustado: body.score_ajustado,
    rsi_at_entry:   body.rsi_at_entry ?? null,
    atr_at_entry:   body.atr_at_entry ?? null,
    liquidez:       body.liquidez   ?? null,
    d1_bias:        body.d1_bias    ?? null,
    status:         "OPEN" as StatusVal,
    // result_at, result_price, pnl_* quedan null por default
    // (lo exige el constraint shadow_result_chk para filas OPEN)
  }));

  const { data, error } = await supabaseAdmin
    .from("shadow_trades")
    .insert(rows)
    .select();

  if (error) {
    // Postgres error_code 23505 = unique_violation. Será disparado por el
    // UNIQUE INDEX server-side cuando otra instancia o dispositivo intente
    // insertar un evento en el mismo bucket horario UTC para el mismo
    // user + case_type + direction. El cliente está preparado para tratar
    // 409 como éxito (no reintentar) — ver pipeline en LiveTerminal.tsx.
    if ((error as { code?: string }).code === "23505") {
      return NextResponse.json(
        { error: "Duplicate shadow event in this hour bucket" },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    event_id:       eventId,
    inserted_count: data?.length ?? 0,
    rows:           data ?? [],
  }, { status: 201 });
}

// ── PATCH — cerrar una row (status: WIN | LOSS | EXPIRED) ────────────────────
//
// Lo usa el tracker desde el frontend cuando checkShadowOutcome detecta
// que una row OPEN cumplió condición. NO permite reabrir filas cerradas:
// si la row ya tiene status != OPEN, devuelve 409.
//
// Constraint shadow_result_chk: cerrar exige result_at + result_price NOT NULL.
// pnl_pct y pnl_dollars son opcionales (la tabla los acepta null).
export async function PATCH(req: NextRequest) {
  const userId = await getUserIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: {
    id:            string;
    status:        StatusVal;
    result_price:  number;
    result_at?:    string;        // ISO; default = now() lado server
    pnl_pct?:      number | null;
    pnl_dollars?:  number | null;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.id || typeof body.id !== "string") {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }
  if (!body.status || !(VALID_STATUSES as readonly string[]).includes(body.status)) {
    return NextResponse.json({ error: "status inválido" }, { status: 400 });
  }
  if (body.status === "OPEN") {
    return NextResponse.json({ error: "PATCH no acepta status=OPEN (crear via POST)" }, { status: 400 });
  }

  const errPrice = validatePositiveNumber(body.result_price, "result_price");
  if (errPrice) return NextResponse.json({ error: errPrice }, { status: 400 });

  // pnl opcionales
  const errPnlPct = validateNumberOrNull(body.pnl_pct, "pnl_pct");
  if (errPnlPct) return NextResponse.json({ error: errPnlPct }, { status: 400 });
  const errPnlUsd = validateNumberOrNull(body.pnl_dollars, "pnl_dollars");
  if (errPnlUsd) return NextResponse.json({ error: errPnlUsd }, { status: 400 });

  // Verificación: la row debe existir, pertenecer al usuario y estar OPEN.
  const { data: existing, error: fetchErr } = await supabaseAdmin
    .from("shadow_trades")
    .select("id, status, user_id")
    .eq("id", body.id)
    .eq("user_id", userId)
    .maybeSingle();

  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  if (!existing) return NextResponse.json({ error: "Row no encontrada o no pertenece al usuario" }, { status: 404 });
  if (existing.status !== "OPEN") {
    return NextResponse.json({ error: `Row ya cerrada (status=${existing.status})` }, { status: 409 });
  }

  const updates = {
    status:       body.status,
    result_price: body.result_price,
    result_at:    body.result_at ?? new Date().toISOString(),
    pnl_pct:      body.pnl_pct     ?? null,
    pnl_dollars:  body.pnl_dollars ?? null,
  };

  const { data, error } = await supabaseAdmin
    .from("shadow_trades")
    .update(updates)
    .eq("id", body.id)
    .eq("user_id", userId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
