// lib/push/client.ts
// ─────────────────────────────────────────────────────────────────────────────
// Helper de CLIENTE para Web Push (#8 Fase 1). Solo se usa desde el navegador.
//
// Hace 3 cosas:
//   1. Registra el service worker (/sw.js).
//   2. Suscribe el navegador al push y manda la suscripción al backend
//      (/api/push/subscribe) para guardarla.
//   3. Dispara un push de prueba (/api/push/test).
//
// El token de auth se saca de la sesión activa de Supabase en el navegador,
// igual que en LiveTerminal (Authorization: Bearer <access_token>).
// ─────────────────────────────────────────────────────────────────────────────

import { supabaseBrowser } from "@/lib/db/supabase-client";

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "";

// Convierte la clave VAPID pública (base64url) al formato (Uint8Array) que pide
// pushManager.subscribe en applicationServerKey.
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabaseBrowser.auth.getSession();
  const token = session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** ¿El navegador soporta el stack completo de Web Push? */
export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** Registra el service worker (idempotente). Útil llamarlo al montar la app. */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js");
  } catch (e) {
    console.error("[push] no se pudo registrar el service worker", e);
    return null;
  }
}

/**
 * Suscribe el navegador al push y guarda la suscripción en el backend.
 * Requiere que el permiso de notificaciones ya esté en "granted".
 * Es idempotente: si ya hay suscripción la reutiliza (y la re-guarda).
 */
export async function subscribeToPush(): Promise<{ ok: boolean; reason?: string }> {
  if (!pushSupported()) return { ok: false, reason: "unsupported" };
  if (!VAPID_PUBLIC_KEY) return { ok: false, reason: "no-vapid-key" };
  if (Notification.permission !== "granted") return { ok: false, reason: "no-permission" };

  try {
    const reg = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
      });
    }

    const json = sub.toJSON();
    const headers = await getAuthHeaders();
    const res = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({
        endpoint: sub.endpoint,
        p256dh: json.keys?.p256dh,
        auth: json.keys?.auth,
        user_agent: navigator.userAgent,
      }),
    });

    if (!res.ok) return { ok: false, reason: `api-${res.status}` };
    return { ok: true };
  } catch (e) {
    console.error("[push] falló la suscripción", e);
    return { ok: false, reason: "exception" };
  }
}

/** Manda un push de prueba a los dispositivos suscritos del usuario. */
export async function sendTestPush(): Promise<{ ok: boolean; reason?: string }> {
  try {
    const headers = await getAuthHeaders();
    const res = await fetch("/api/push/test", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { ok: false, reason: `api-${res.status}${txt ? ":" + txt : ""}` };
    }
    return { ok: true };
  } catch (e) {
    console.error("[push] falló el push de prueba", e);
    return { ok: false, reason: "exception" };
  }
}
