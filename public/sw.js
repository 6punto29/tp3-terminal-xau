// public/sw.js
// ─────────────────────────────────────────────────────────────────────────────
// TP3 — Service Worker (Web Push, #8 Fase 1)
//
// Único propósito por ahora: recibir los push del servidor y mostrar la
// notificación del sistema. NO intercepta fetch (no cachea NADA) — así no
// cambia el comportamiento de carga ni agrega sorpresas de caché.
//
// iOS exige que CADA push muestre una notificación visible (la suscripción usa
// userVisibleOnly: true). Por eso el handler 'push' SIEMPRE llama a
// showNotification.
//
// Fases siguientes (no acá): push en señal nueva (Fase 2) + detector
// server-side con Vercel Cron (Fase 3, el que hace que funcione con todo cerrado).
// ─────────────────────────────────────────────────────────────────────────────

// Activar de inmediato la versión nueva del SW (sin esperar a que cierren pestañas)
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// ── Recibe el push y muestra la notificación ─────────────────────────────────
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    // Si el cuerpo no es JSON, lo tratamos como texto plano
    payload = { title: "TP3", body: event.data ? event.data.text() : "" };
  }

  const title = payload.title || "TP3";
  const options = {
    body: payload.body || "",
    icon: payload.icon || "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: payload.tag || "tp3-push",
    data: { url: payload.url || "/" },
    requireInteraction: false,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// ── Clic en la notificación → enfoca la app abierta o abre una ventana ────────
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ("focus" in client) return client.focus();
        }
        if (self.clients.openWindow) return self.clients.openWindow(url);
      })
  );
});
