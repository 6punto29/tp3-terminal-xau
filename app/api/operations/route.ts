// ─────────────────────────────────────────────────────────────────────────────
// app/api/operations/route.ts
// GET  /api/operations        — list user's operations
// POST /api/operations        — create new operation
// PATCH /api/operations       — update result (TP/SL/MANUAL)
//
// Supabase is called server-side only. No key exposed to browser.
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

// ── PATCH — update result and P&L ────────────────────────────────────────────
export async function PATCH(req: NextRequest) {
  const userId = req.headers.get("x-user-id");
  if (!userId)
    return NextResponse.json({ error: "Missing x-user-id header" }, { status: 401 });

  const { id, resultado, pnl } = await req.json() as {
    id:         string;
    resultado:  "TP" | "SL" | "MANUAL";
    pnl:        number;
  };

  if (!id || !resultado)
    return NextResponse.json({ error: "Missing id or resultado" }, { status: 400 });

  const { data, error } = await supabaseAdmin
    .from("xau_usd")
    .update({ resultado, pnl })
    .eq("id", id)
    .eq("user_id", userId)  // row-level ownership check
    .select()
    .single();

  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(data);
}
