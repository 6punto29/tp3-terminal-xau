// ─────────────────────────────────────────────────────────────────────────────
// app/api/operations/route.ts
// GET    /api/operations        — list user's operations
// POST   /api/operations        — create new operation
// PATCH  /api/operations        — update result (TP/SL/MANUAL) o edición completa
// DELETE /api/operations?id=X   — eliminar operación
//
// Cambios v4:
// · Fix #1 — Auth real con JWT de Supabase. Reemplaza el header `x-user-id`
//   (spoofeable) por validación del access_token que firma Supabase. Cada ruta
//   llama a getUserIdFromRequest() que verifica el token contra Supabase y
//   devuelve el user_id real, o 401 si el token es inválido/falta.
//
// Cambios v3:
// · Bug 5.2 — POST acepta y guarda `capital_momento`.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, OperationRow } from "@/lib/db/supabase";

// ── Auth helper ───────────────────────────────────────────────────────────────
/**
 * Extrae y verifica el JWT del header Authorization: Bearer <token>.
 * Retorna el user_id real si el token es válido, null si no.
 * El token lo firma Supabase con su secreto — no se puede falsificar.
 */
async function getUserIdFromRequest(req: NextRequest): Promise<string | null> {
  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user.id;
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

  if (!body.precio_entrada || !body.sl || !body.tp || !body.direccion)
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });

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
