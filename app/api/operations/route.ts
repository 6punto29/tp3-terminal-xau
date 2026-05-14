// ─────────────────────────────────────────────────────────────────────────────
// app/api/operations/route.ts
// GET    /api/operations        — list user's operations
// POST   /api/operations        — create new operation
// PATCH  /api/operations        — update result (TP/SL/MANUAL) o edición completa
// DELETE /api/operations?id=X   — eliminar operación
//
// Cambios v5:
// · Fix #10 — validación estricta de payload en POST/PATCH. Antes el server
//   confiaba 100% en el cliente: direccion podía ser cualquier string, precios
//   podían ser negativos o no-numéricos, SL/TP podían no tener coherencia con
//   la dirección (LONG con SL>entry). Ahora rechaza con 400 antes de tocar DB.
//
// Cambios v4:
// · Fix #1 — Auth real con JWT de Supabase.
//
// Cambios v3:
// · Bug 5.2 — POST acepta y guarda `capital_momento`.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, OperationRow } from "@/lib/db/supabase";

// ── Auth helper ───────────────────────────────────────────────────────────────
async function getUserIdFromRequest(req: NextRequest): Promise<string | null> {
  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user.id;
}

// ── Validation helpers ───────────────────────────────────────────────────────
// Devuelve null si el valor es un número válido positivo finito, o un mensaje de error.
function validatePositiveNumber(value: unknown, fieldName: string): string | null {
  if (typeof value !== "number") return `${fieldName} debe ser un número`;
  if (!Number.isFinite(value)) return `${fieldName} no puede ser Infinity/NaN`;
  if (value <= 0) return `${fieldName} debe ser positivo`;
  return null;
}

// Valida que SL y TP estén del lado correcto del entry según dirección.
function validateLevels(direccion: string, entry: number, sl: number, tp: number): string | null {
  if (direccion === "LONG") {
    if (sl >= entry) return "En LONG el SL debe ser MENOR al precio de entrada";
    if (tp <= entry) return "En LONG el TP debe ser MAYOR al precio de entrada";
  } else if (direccion === "SHORT") {
    if (sl <= entry) return "En SHORT el SL debe ser MAYOR al precio de entrada";
    if (tp >= entry) return "En SHORT el TP debe ser MENOR al precio de entrada";
  }
  return null;
}

// ── GET — fetch all ops for the authenticated user ───────────────────────────
export async function GET(req: NextRequest) {
  const userId = await getUserIdFromRequest(req);
  if (!userId)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabaseAdmin
    .from("xau_usd")
    .select("*")
    .eq("user_id", userId)
    .order("id", { ascending: false });

  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(data);
}

// ── POST — create new operation ───────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const userId = await getUserIdFromRequest(req);
  if (!userId)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as Omit<
    OperationRow,
    "id" | "user_id" | "resultado" | "pnl" | "created_at"
  >;

  // Fix #10: validación de campos requeridos
  if (!body.precio_entrada || !body.sl || !body.tp || !body.direccion)
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });

  // direccion debe ser LONG o SHORT exacto
  if (body.direccion !== "LONG" && body.direccion !== "SHORT")
    return NextResponse.json({ error: "direccion debe ser 'LONG' o 'SHORT'" }, { status: 400 });

  // precios deben ser números positivos finitos
  const errEntry = validatePositiveNumber(body.precio_entrada, "precio_entrada");
  if (errEntry) return NextResponse.json({ error: errEntry }, { status: 400 });
  const errSL = validatePositiveNumber(body.sl, "sl");
  if (errSL) return NextResponse.json({ error: errSL }, { status: 400 });
  const errTP = validatePositiveNumber(body.tp, "tp");
  if (errTP) return NextResponse.json({ error: errTP }, { status: 400 });

  // lotaje opcional, pero si viene debe ser positivo
  if (body.lotaje != null) {
    const errLot = validatePositiveNumber(body.lotaje, "lotaje");
    if (errLot) return NextResponse.json({ error: errLot }, { status: 400 });
  }

  // coherencia SL/TP vs dirección
  const errLevels = validateLevels(body.direccion, body.precio_entrada, body.sl, body.tp);
  if (errLevels) return NextResponse.json({ error: errLevels }, { status: 400 });

  // capital_momento opcional, debe ser positivo si viene
  const capitalMomento =
    typeof body.capital_momento === "number" && body.capital_momento > 0
      ? body.capital_momento
      : null;

  const { data, error } = await supabaseAdmin
    .from("xau_usd")
    .insert([{
      fecha:          body.fecha,
      direccion:      body.direccion,
      precio_entrada: body.precio_entrada,
      sl:             body.sl,
      tp:             body.tp,
      lotaje:         body.lotaje ?? null,
      capital_momento: capitalMomento,
      user_id:        userId,
      resultado:      null,
      pnl:            null,
    }])
    .select()
    .single();

  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(data, { status: 201 });
}

// ── PATCH — edición completa o solo resultado/pnl ────────────────────────────
export async function PATCH(req: NextRequest) {
  const userId = await getUserIdFromRequest(req);
  if (!userId)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { id } = body;
  if (!id)
    return NextResponse.json({ error: "Missing id" }, { status: 400 });

  // Fix #10: validar solo los campos que vienen en el body
  if (body.direccion !== undefined && body.direccion !== "LONG" && body.direccion !== "SHORT")
    return NextResponse.json({ error: "direccion debe ser 'LONG' o 'SHORT'" }, { status: 400 });

  if (body.precio_entrada !== undefined) {
    const err = validatePositiveNumber(body.precio_entrada, "precio_entrada");
    if (err) return NextResponse.json({ error: err }, { status: 400 });
  }
  if (body.sl !== undefined) {
    const err = validatePositiveNumber(body.sl, "sl");
    if (err) return NextResponse.json({ error: err }, { status: 400 });
  }
  if (body.tp !== undefined) {
    const err = validatePositiveNumber(body.tp, "tp");
    if (err) return NextResponse.json({ error: err }, { status: 400 });
  }
  if (body.lotaje !== undefined && body.lotaje !== null) {
    const err = validatePositiveNumber(body.lotaje, "lotaje");
    if (err) return NextResponse.json({ error: err }, { status: 400 });
  }
  if (body.capital_momento !== undefined && body.capital_momento !== null) {
    const err = validatePositiveNumber(body.capital_momento, "capital_momento");
    if (err) return NextResponse.json({ error: err }, { status: 400 });
  }

  // resultado debe ser uno de los 3 valores válidos o null
  if (body.resultado !== undefined && body.resultado !== null &&
      body.resultado !== "TP" && body.resultado !== "SL" && body.resultado !== "MANUAL")
    return NextResponse.json({ error: "resultado debe ser TP, SL, MANUAL o null" }, { status: 400 });

  // Si llegan precio_entrada + sl + tp + direccion juntos, validar coherencia
  if (body.precio_entrada !== undefined && body.sl !== undefined &&
      body.tp !== undefined && body.direccion !== undefined) {
    const err = validateLevels(body.direccion, body.precio_entrada, body.sl, body.tp);
    if (err) return NextResponse.json({ error: err }, { status: 400 });
  }

  const updates: Partial<OperationRow> = {};
  if (body.direccion       !== undefined) updates.direccion       = body.direccion;
  if (body.precio_entrada  !== undefined) updates.precio_entrada  = body.precio_entrada;
  if (body.sl              !== undefined) updates.sl              = body.sl;
  if (body.tp              !== undefined) updates.tp              = body.tp;
  if (body.lotaje          !== undefined) updates.lotaje          = body.lotaje;
  if (body.resultado       !== undefined) updates.resultado       = body.resultado;
  if (body.pnl             !== undefined) updates.pnl             = body.pnl;
  if (body.capital_momento !== undefined) updates.capital_momento = body.capital_momento;

  if (Object.keys(updates).length === 0)
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });

  const { data, error } = await supabaseAdmin
    .from("xau_usd")
    .update(updates)
    .eq("id", id)
    .eq("user_id", userId)   // row-level ownership check
    .select()
    .single();

  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(data);
}

// ── DELETE — eliminar operación ───────────────────────────────────────────────
export async function DELETE(req: NextRequest) {
  const userId = await getUserIdFromRequest(req);
  if (!userId)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id)
    return NextResponse.json({ error: "Missing id query param" }, { status: 400 });

  const { error } = await supabaseAdmin
    .from("xau_usd")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);   // solo borra las propias del usuario

  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ deleted: true });
}
