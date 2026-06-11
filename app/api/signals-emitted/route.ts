// ─────────────────────────────────────────────────────────────────────────────
// app/api/signals-emitted/route.ts
//
// Sistema de registro automático de señales emitidas por el motor (regla #24).
//
// GET    /api/signals-emitted                    — list user's emitted signals
//   query opcional: ?status=OPEN        — filtra por status
//   query opcional: ?direction=LONG     — filtra por dirección
//   query opcional: ?limit=N            — limita filas (default 200, max 1000)
//
// POST   /api/signals-emitted                    — crear una señal nueva
//   La usa el pipeline del motor cuando emite veredicto ENTRAR.
//   Inserta 1 fila con status='OPEN' (default).
//
// PATCH  /api/signals-emitted                    — actualizar una señal
//   La usa el tracker para 3 propósitos posibles (combinables):
//   1. CIERRE      → status WIN/LOSS/EXPIRED + result_price + result_at + pnl_pct + r_multiple
//   2. EXCURSION   → mae_price/mae_pct/mfe_price/mfe_pct (durante OPEN)
//   3. MANUAL UI   → was_taken=true + taken_op_id opcional
//   Actualiza solo los campos que vienen en el body (UPDATE selectivo).
//
// Patrón espejado de /api/shadow-trades/route.ts: mismo auth helper, mismo
// estilo de validaciones, mismas respuestas. user_id se inyecta desde el JWT
// (no se confía en el cliente). RLS de la tabla usa auth.uid()::text como
// default, pero como el API corre con supabaseAdmin (service_role) bypassea
// RLS — por eso pasamos user_id explícitamente en cada query.
//
// Complementario a /api/shadow-trades: shadow captura señales RECHAZADAS por
// gates, signals_emitted captura señales EMITIDAS por el motor. Juntos dan
// visibilidad completa del comportamiento del motor (regla #24 del knowledge).
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db/supabase";

// ── Auth helper (idéntico al de /api/shadow-trades) ─────────────────────────
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
const VALID_DIRECTIONS    = ["LONG", "SHORT"] as const;
const VALID_HTF_TFS       = ["1h", "4h"] as const;
const VALID_FUERZAS       = ["FUERTE", "MODERADA"] as const;
const VALID_TF_SIGS       = ["UP", "DOWN", "WAIT"] as const;
const VALID_LIQUIDEZ      = ["alta", "baja", "weekend"] as const;
const VALID_SESSION_TAGS  = ["LDN", "NY", "CLOSED", "WEEKEND"] as const;
const VALID_STRUCTURES    = ["BULLISH", "BEARISH", "NEUTRAL"] as const;
const VALID_STATUSES      = ["OPEN", "WIN", "LOSS", "EXPIRED"] as const;
const CLOSED_STATUSES     = ["WIN", "LOSS", "EXPIRED"] as const;

type Direction   = (typeof VALID_DIRECTIONS)[number];
type HtfTf       = (typeof VALID_HTF_TFS)[number];
type Fuerza      = (typeof VALID_FUERZAS)[number];
type TfSig       = (typeof VALID_TF_SIGS)[number];
type Liquidez    = (typeof VALID_LIQUIDEZ)[number];
type SessionTag  = (typeof VALID_SESSION_TAGS)[number];
type Structure   = (typeof VALID_STRUCTURES)[number];
type StatusVal   = (typeof VALID_STATUSES)[number];
type ClosedStat  = (typeof CLOSED_STATUSES)[number];

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

function validateTfSig(value: unknown, fieldName: string, nullable: boolean): string | null {
  if (value == null) {
    return nullable ? null : `${fieldName} es obligatorio`;
  }
  if (typeof value !== "string" || !(VALID_TF_SIGS as readonly string[]).includes(value)) {
    return `${fieldName} debe ser UP, DOWN o WAIT`;
  }
  return null;
}

// ── Tipos del payload del POST ───────────────────────────────────────────────
interface SignalEmittedInput {
  // Identidad / momento
  direction:       Direction;
  htf_tf:          HtfTf;
  // Niveles
  entry_price:     number;
  sl_price:        number;
  tp_price:        number;
  sl_pct:          number;
  rr_planned:      number;
  // Score + fuerza
  score_puro:      number;
  score_ajustado:  number;
  fuerza:          Fuerza;
  // Señales por TF
  htf_sig:         TfSig;
  mtf_sig:         TfSig;
  m15_sig:         TfSig;
  ltf_sig:         TfSig;
  d1_bias?:        TfSig | null;
  h4_bias?:        TfSig | null;
  // Indicadores
  rsi_at_entry?:   number | null;
  atr_at_entry?:   number | null;
  ema200_at?:      number | null;
  // Contexto
  liquidez:        Liquidez;
  session_tag:     SessionTag;
  fvg_active:      boolean;
  structure:       Structure;
  has_news:        boolean;
  // Snapshot capital + riesgo al momento de emisión (Opción B, 10/06/26)
  capital_at_signal?:   number | null;
  risk_pct_at_signal?:  number | null;
}

// ── GET — listar signals_emitted del usuario ─────────────────────────────────
export async function GET(req: NextRequest) {
  const userId = await getUserIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const statusFilter    = searchParams.get("status");
  const directionFilter = searchParams.get("direction");
  const limitRaw        = searchParams.get("limit");
  const limit = limitRaw ? Math.min(Math.max(parseInt(limitRaw, 10) || 200, 1), 1000) : 200;

  let q = supabaseAdmin
    .from("signals_emitted")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (statusFilter && (VALID_STATUSES as readonly string[]).includes(statusFilter)) {
    q = q.eq("status", statusFilter);
  }
  if (directionFilter && (VALID_DIRECTIONS as readonly string[]).includes(directionFilter)) {
    q = q.eq("direction", directionFilter);
  }

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(data ?? []);
}

// ── POST — crear una señal nueva (status='OPEN' por default) ─────────────────
export async function POST(req: NextRequest) {
  const userId = await getUserIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: SignalEmittedInput;
  try {
    body = (await req.json()) as SignalEmittedInput;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // ── Validación: dirección + htf_tf ──
  if (!body.direction || !(VALID_DIRECTIONS as readonly string[]).includes(body.direction)) {
    return NextResponse.json({ error: "direction inválida" }, { status: 400 });
  }
  if (!body.htf_tf || !(VALID_HTF_TFS as readonly string[]).includes(body.htf_tf)) {
    return NextResponse.json({ error: "htf_tf inválido (debe ser '1h' o '4h')" }, { status: 400 });
  }

  // ── Validación: niveles ──
  const errEntry = validatePositiveNumber(body.entry_price, "entry_price");
  if (errEntry) return NextResponse.json({ error: errEntry }, { status: 400 });
  const errSL    = validatePositiveNumber(body.sl_price, "sl_price");
  if (errSL) return NextResponse.json({ error: errSL }, { status: 400 });
  const errTP    = validatePositiveNumber(body.tp_price, "tp_price");
  if (errTP) return NextResponse.json({ error: errTP }, { status: 400 });
  const errSlPct = validatePositiveNumber(body.sl_pct, "sl_pct");
  if (errSlPct) return NextResponse.json({ error: errSlPct }, { status: 400 });
  const errRR    = validatePositiveNumber(body.rr_planned, "rr_planned");
  if (errRR) return NextResponse.json({ error: errRR }, { status: 400 });

  // Coherencia niveles vs dirección
  const errLvl = validateLevels(body.direction, body.entry_price, body.sl_price, body.tp_price);
  if (errLvl) return NextResponse.json({ error: errLvl }, { status: 400 });

  // ── Validación: score + fuerza ──
  const errScore  = validateIntInRange(body.score_puro, 0, 10, "score_puro");
  if (errScore) return NextResponse.json({ error: errScore }, { status: 400 });
  const errScoreA = validateIntInRange(body.score_ajustado, -10, 15, "score_ajustado");
  if (errScoreA) return NextResponse.json({ error: errScoreA }, { status: 400 });

  if (!body.fuerza || !(VALID_FUERZAS as readonly string[]).includes(body.fuerza)) {
    return NextResponse.json({ error: "fuerza inválida (debe ser FUERTE o MODERADA)" }, { status: 400 });
  }

  // ── Validación: señales por TF ──
  const errHtf = validateTfSig(body.htf_sig, "htf_sig", false);
  if (errHtf) return NextResponse.json({ error: errHtf }, { status: 400 });
  const errMtf = validateTfSig(body.mtf_sig, "mtf_sig", false);
  if (errMtf) return NextResponse.json({ error: errMtf }, { status: 400 });
  const errM15 = validateTfSig(body.m15_sig, "m15_sig", false);
  if (errM15) return NextResponse.json({ error: errM15 }, { status: 400 });
  const errLtf = validateTfSig(body.ltf_sig, "ltf_sig", false);
  if (errLtf) return NextResponse.json({ error: errLtf }, { status: 400 });
  const errD1  = validateTfSig(body.d1_bias, "d1_bias", true);
  if (errD1) return NextResponse.json({ error: errD1 }, { status: 400 });
  const errH4  = validateTfSig(body.h4_bias, "h4_bias", true);
  if (errH4) return NextResponse.json({ error: errH4 }, { status: 400 });

  // ── Validación: indicadores opcionales ──
  const errRsi = validateNumberOrNull(body.rsi_at_entry, "rsi_at_entry");
  if (errRsi) return NextResponse.json({ error: errRsi }, { status: 400 });
  const errAtr = validateNumberOrNull(body.atr_at_entry, "atr_at_entry");
  if (errAtr) return NextResponse.json({ error: errAtr }, { status: 400 });
  const errEma = validateNumberOrNull(body.ema200_at, "ema200_at");
  if (errEma) return NextResponse.json({ error: errEma }, { status: 400 });

  // ── Validación: snapshot capital + riesgo (Opción B, opcionales) ──
  if (body.capital_at_signal !== undefined && body.capital_at_signal !== null) {
    const err = validatePositiveNumber(body.capital_at_signal, "capital_at_signal");
    if (err) return NextResponse.json({ error: err }, { status: 400 });
  }
  if (body.risk_pct_at_signal !== undefined && body.risk_pct_at_signal !== null) {
    const err = validatePositiveNumber(body.risk_pct_at_signal, "risk_pct_at_signal");
    if (err) return NextResponse.json({ error: err }, { status: 400 });
    if (body.risk_pct_at_signal > 100) {
      return NextResponse.json({ error: "risk_pct_at_signal no puede exceder 100" }, { status: 400 });
    }
  }

  // ── Validación: contexto ──
  if (!body.liquidez || !(VALID_LIQUIDEZ as readonly string[]).includes(body.liquidez)) {
    return NextResponse.json({ error: "liquidez inválida" }, { status: 400 });
  }
  if (!body.session_tag || !(VALID_SESSION_TAGS as readonly string[]).includes(body.session_tag)) {
    return NextResponse.json({ error: "session_tag inválido" }, { status: 400 });
  }
  if (typeof body.fvg_active !== "boolean") {
    return NextResponse.json({ error: "fvg_active debe ser boolean" }, { status: 400 });
  }
  if (!body.structure || !(VALID_STRUCTURES as readonly string[]).includes(body.structure)) {
    return NextResponse.json({ error: "structure inválida" }, { status: 400 });
  }
  if (typeof body.has_news !== "boolean") {
    return NextResponse.json({ error: "has_news debe ser boolean" }, { status: 400 });
  }

  // ── INSERT ──
  const row = {
    user_id:        userId,
    direction:      body.direction,
    htf_tf:         body.htf_tf,
    entry_price:    body.entry_price,
    sl_price:       body.sl_price,
    tp_price:       body.tp_price,
    sl_pct:         body.sl_pct,
    rr_planned:     body.rr_planned,
    score_puro:     body.score_puro,
    score_ajustado: body.score_ajustado,
    fuerza:         body.fuerza,
    htf_sig:        body.htf_sig,
    mtf_sig:        body.mtf_sig,
    m15_sig:        body.m15_sig,
    ltf_sig:        body.ltf_sig,
    d1_bias:        body.d1_bias       ?? null,
    h4_bias:        body.h4_bias       ?? null,
    rsi_at_entry:   body.rsi_at_entry  ?? null,
    atr_at_entry:   body.atr_at_entry  ?? null,
    ema200_at:      body.ema200_at     ?? null,
    liquidez:       body.liquidez,
    session_tag:    body.session_tag,
    fvg_active:     body.fvg_active,
    structure:      body.structure,
    has_news:       body.has_news,
    capital_at_signal:  body.capital_at_signal  ?? null,
    risk_pct_at_signal: body.risk_pct_at_signal ?? null,
    status:         "OPEN" as StatusVal,
    // result_*, mae_*, mfe_*, r_multiple, pnl_pct quedan null por default
    // was_taken default false, taken_op_id default null
  };

  const { data, error } = await supabaseAdmin
    .from("signals_emitted")
    .insert(row)
    .select()
    .single();

  if (error) {
    // Postgres error_code 23505 = unique_violation. Será disparado por el
    // UNIQUE INDEX signals_emitted_unique_hour cuando otra instancia o
    // dispositivo intente insertar una señal en el mismo bucket horario UTC
    // para el mismo user + direction. El cliente está preparado para tratar
    // 409 como éxito (no reintentar) — ver pipeline en LiveTerminal.tsx.
    if ((error as { code?: string }).code === "23505") {
      return NextResponse.json(
        { error: "Duplicate signal in this hour bucket" },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data, { status: 201 });
}

// ── PATCH — actualizar una señal (cierre / excursion / marca manual) ─────────
//
// Modos posibles, combinables:
//   1. CIERRE      → status (WIN/LOSS/EXPIRED) + result_price + result_at + pnl_pct + r_multiple
//   2. EXCURSION   → mae_price/mae_pct/mfe_price/mfe_pct
//   3. MANUAL UI   → was_taken + taken_op_id
//
// Reglas:
// · La row debe existir y pertenecer al usuario.
// · NO se puede reabrir: si la row ya está cerrada (status != OPEN) y se
//   intenta tocar campos de cierre o excursion, devuelve 409.
// · Marca manual (was_taken/taken_op_id) sí se permite en filas cerradas.
// · Constraint shadow_result_chk del DB: cerrar exige result_at + result_price NOT NULL.
export async function PATCH(req: NextRequest) {
  const userId = await getUserIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: {
    id:             string;
    // Cierre
    status?:        ClosedStat;
    result_price?:  number;
    result_at?:     string;
    pnl_pct?:       number | null;
    r_multiple?:    number | null;
    // Excursion
    mae_price?:     number | null;
    mae_pct?:       number | null;
    mfe_price?:     number | null;
    mfe_pct?:       number | null;
    // Marca manual
    was_taken?:     boolean;
    taken_op_id?:   string | null;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.id || typeof body.id !== "string") {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }

  // ── Determinar qué modos vienen en este PATCH ──
  const hasClose = body.status !== undefined;
  const hasExc   = body.mae_price !== undefined || body.mae_pct !== undefined
                || body.mfe_price !== undefined || body.mfe_pct !== undefined;
  const hasMark  = body.was_taken !== undefined || body.taken_op_id !== undefined;

  if (!hasClose && !hasExc && !hasMark) {
    return NextResponse.json({ error: "PATCH vacío: nada que actualizar" }, { status: 400 });
  }

  // ── Validación: CIERRE ──
  if (hasClose) {
    if (!(CLOSED_STATUSES as readonly string[]).includes(body.status as string)) {
      return NextResponse.json({ error: "status inválido (debe ser WIN, LOSS o EXPIRED)" }, { status: 400 });
    }
    const errPrice = validatePositiveNumber(body.result_price, "result_price");
    if (errPrice) return NextResponse.json({ error: errPrice }, { status: 400 });
    const errPnl = validateNumberOrNull(body.pnl_pct, "pnl_pct");
    if (errPnl) return NextResponse.json({ error: errPnl }, { status: 400 });
    const errR = validateNumberOrNull(body.r_multiple, "r_multiple");
    if (errR) return NextResponse.json({ error: errR }, { status: 400 });
  }

  // ── Validación: EXCURSION ──
  if (hasExc) {
    if (body.mae_price !== undefined && body.mae_price !== null) {
      const e = validatePositiveNumber(body.mae_price, "mae_price");
      if (e) return NextResponse.json({ error: e }, { status: 400 });
    }
    if (body.mfe_price !== undefined && body.mfe_price !== null) {
      const e = validatePositiveNumber(body.mfe_price, "mfe_price");
      if (e) return NextResponse.json({ error: e }, { status: 400 });
    }
    const ePctA = validateNumberOrNull(body.mae_pct, "mae_pct");
    if (ePctA) return NextResponse.json({ error: ePctA }, { status: 400 });
    const ePctF = validateNumberOrNull(body.mfe_pct, "mfe_pct");
    if (ePctF) return NextResponse.json({ error: ePctF }, { status: 400 });
  }

  // ── Validación: MARCA MANUAL ──
  if (hasMark) {
    if (body.was_taken !== undefined && typeof body.was_taken !== "boolean") {
      return NextResponse.json({ error: "was_taken debe ser boolean" }, { status: 400 });
    }
    if (body.taken_op_id !== undefined && body.taken_op_id !== null && typeof body.taken_op_id !== "string") {
      return NextResponse.json({ error: "taken_op_id debe ser string o null" }, { status: 400 });
    }
  }

  // ── Verificación: la row debe existir y pertenecer al usuario ──
  const { data: existing, error: fetchErr } = await supabaseAdmin
    .from("signals_emitted")
    .select("id, status, user_id")
    .eq("id", body.id)
    .eq("user_id", userId)
    .maybeSingle();

  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  if (!existing) return NextResponse.json({ error: "Row no encontrada o no pertenece al usuario" }, { status: 404 });

  // ── Reglas de transición ──
  // Cierre o excursion sobre row ya cerrada → 409.
  // Marca manual se permite siempre.
  if (existing.status !== "OPEN" && (hasClose || hasExc)) {
    return NextResponse.json(
      { error: `Row ya cerrada (status=${existing.status})` },
      { status: 409 },
    );
  }

  // ── Construir el UPDATE selectivo ──
  const updates: Record<string, unknown> = {};

  if (hasClose) {
    updates.status       = body.status;
    updates.result_price = body.result_price;
    updates.result_at    = body.result_at ?? new Date().toISOString();
    updates.pnl_pct      = body.pnl_pct    ?? null;
    updates.r_multiple   = body.r_multiple ?? null;
  }
  if (hasExc) {
    if (body.mae_price !== undefined) updates.mae_price = body.mae_price;
    if (body.mae_pct   !== undefined) updates.mae_pct   = body.mae_pct;
    if (body.mfe_price !== undefined) updates.mfe_price = body.mfe_price;
    if (body.mfe_pct   !== undefined) updates.mfe_pct   = body.mfe_pct;
  }
  if (hasMark) {
    if (body.was_taken   !== undefined) updates.was_taken   = body.was_taken;
    if (body.taken_op_id !== undefined) updates.taken_op_id = body.taken_op_id;
  }

  const { data, error } = await supabaseAdmin
    .from("signals_emitted")
    .update(updates)
    .eq("id", body.id)
    .eq("user_id", userId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
