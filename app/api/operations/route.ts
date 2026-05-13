// ─────────────────────────────────────────────────────────────────────────────
// app/api/operations/route.ts
// GET    /api/operations        — list user's operations
// POST   /api/operations        — create new operation
// PATCH  /api/operations        — update result (TP/SL/MANUAL) o edición completa
// DELETE /api/operations?id=X   — eliminar operación
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, OperationRow } from "@/lib/db/supabase";

// ── GET — fetch all ops for a user ───────────────────────────────────────────
export async function GET(req: NextRequest) {
  const userId = req.headers.get("x-user-id");
  if (!userId)
    return NextResponse.json({ error: "Missing x-user-id header" }, { status: 401 });

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
  const userId = req.headers.get("x-user-id");
  if (!userId)
    return NextResponse.json({ error: "Missing x-user-id header" }, { status: 401 });

  const body = await req.json() as Omit<
    OperationRow,
    "id" | "user_id" | "resultado" | "pnl" | "created_at"
  >;

  if (!body.precio_entrada || !body.sl || !body.tp || !body.direccion)
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });

  const { data, error } = await supabaseAdmin
    .from("xau_usd")
    .insert([{ ...body, user_id: userId, resultado: null, pnl: null }])
    .select()
    .single();

  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(data, { status: 201 });
}

// ── PATCH — edición completa o solo resultado/pnl ────────────────────────────
// Si el body incluye precio_entrada → edición completa de todos los campos.
// Si solo incluye resultado + pnl   → comportamiento original (marcar cierre).
export async function PATCH(req: NextRequest) {
  const userId = req.headers.get("x-user-id");
  if (!userId)
    return NextResponse.json({ error: "Missing x-user-id header" }, { status: 401 });

  const body = await req.json();
  const { id } = body;
  if (!id)
    return NextResponse.json({ error: "Missing id" }, { status: 400 });

  // Construir el objeto de actualización con solo los campos presentes
  const updates: Partial<OperationRow> = {};
  if (body.direccion    !== undefined) updates.direccion    = body.direccion;
  if (body.precio_entrada !== undefined) updates.precio_entrada = body.precio_entrada;
  if (body.sl           !== undefined) updates.sl           = body.sl;
  if (body.tp           !== undefined) updates.tp           = body.tp;
  if (body.resultado    !== undefined) updates.resultado    = body.resultado;
  if (body.pnl          !== undefined) updates.pnl          = body.pnl;

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
  const userId = req.headers.get("x-user-id");
  if (!userId)
    return NextResponse.json({ error: "Missing x-user-id header" }, { status: 401 });

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
