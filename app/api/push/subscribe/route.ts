// app/api/push/subscribe/route.ts
// ─────────────────────────────────────────────────────────────────────────────
// Guarda (o refresca) la suscripción Web Push del navegador del usuario en la
// tabla push_subscriptions.
//
// Patrón de auth IDÉNTICO a /api/signals-emitted: el user_id sale del JWT
// (no se confía en el cliente) y se usa supabaseAdmin (service_role).
//
// runtime "nodejs" explícito: estas rutas de push usan librerías de Node
// (la de envío usa web-push). No edge.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getUserIdFromRequest(req: NextRequest): Promise<string | null> {
  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user.id;
}

export async function POST(req: NextRequest) {
  const userId = await getUserIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const b = (body ?? {}) as Record<string, unknown>;
  const endpoint   = b.endpoint;
  const p256dh     = b.p256dh;
  const auth       = b.auth;
  const userAgent  = b.user_agent;

  if (typeof endpoint !== "string" || !endpoint)
    return NextResponse.json({ error: "endpoint requerido" }, { status: 400 });
  if (typeof p256dh !== "string" || !p256dh)
    return NextResponse.json({ error: "p256dh requerido" }, { status: 400 });
  if (typeof auth !== "string" || !auth)
    return NextResponse.json({ error: "auth requerido" }, { status: 400 });

  // upsert: si ya existe (user_id, endpoint) actualiza last_seen; si no, inserta.
  const { error } = await supabaseAdmin
    .from("push_subscriptions")
    .upsert(
      {
        user_id: userId,
        endpoint,
        p256dh,
        auth,
        user_agent: typeof userAgent === "string" ? userAgent.slice(0, 500) : null,
        last_seen: new Date().toISOString(),
      },
      { onConflict: "user_id,endpoint" }
    );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
