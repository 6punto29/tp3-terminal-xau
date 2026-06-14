// app/api/push/test/route.ts
// ─────────────────────────────────────────────────────────────────────────────
// Manda un push de PRUEBA a todas las suscripciones del usuario. Sirve para
// validar end-to-end que el Web Push funciona en el dispositivo (objetivo de la
// Fase 1 de #8). Las fases siguientes mandarán pushes reales (señal nueva /
// señal por vencer) reusando el mismo web-push.setVapidDetails + sendNotification.
//
// Auth idéntico a /api/signals-emitted (user_id desde el JWT, supabaseAdmin).
// Si una suscripción está muerta (404/410), la borra de la tabla.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import webpush from "web-push";
import { supabaseAdmin } from "@/lib/db/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VAPID_PUBLIC  = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails("mailto:6punto29@gmail.com", VAPID_PUBLIC, VAPID_PRIVATE);
}

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
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    return NextResponse.json(
      { error: "VAPID keys no configuradas en el servidor" },
      { status: 500 }
    );
  }

  const userId = await getUserIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const { data: subs, error } = await supabaseAdmin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("user_id", userId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!subs || subs.length === 0) {
    return NextResponse.json(
      { error: "No hay dispositivos suscritos. Activá las notificaciones primero." },
      { status: 404 }
    );
  }

  const payload = JSON.stringify({
    title: "✅ TP3 · Push de prueba",
    body: "Si ves esto, las notificaciones funcionan.",
    tag: "tp3-test",
    url: "/",
  });

  let sent = 0;
  const deadIds: string[] = [];

  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload
      );
      sent++;
    } catch (err) {
      const code = (err as { statusCode?: number })?.statusCode;
      if (code === 404 || code === 410) deadIds.push(s.id); // suscripción muerta
    }
  }

  if (deadIds.length > 0) {
    await supabaseAdmin.from("push_subscriptions").delete().in("id", deadIds);
  }

  return NextResponse.json({ ok: true, sent, removed: deadIds.length });
}
