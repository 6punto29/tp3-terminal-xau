// lib/ws/twelvedata-ws.ts
// Precio en vivo: TwelveData WebSocket — XAU/USD tick a tick
//
// Antes este archivo se llamaba `binance-ws.ts` por legado histórico (era un WS
// de Binance antes de migrar a Colombia). Renombrado el 04/06/2026 para reflejar
// la realidad: este archivo SOLO maneja TwelveData. Las señales MTF de Binance
// Futures REST viven en otro lado (en LiveTerminal.tsx y app/api/*).
//
// La API key de TwelveData va en Vercel → Settings → Environment Variables:
//   NEXT_PUBLIC_TWELVEDATA_API_KEY = tu_key
//
// Notas:
// · changeSession: cambio % desde el primer tick que recibió ESTE navegador en
//   esta sesión (resetea al recargar), NO cambio real de 24h.
//
// Auditoría 04/06/2026 — "se cae full la señal" (fixes #1 → #4):
// · FIX #1 — Heartbeat cada 10s. TwelveData cierra conexiones por inactividad.
//   La doc oficial requiere actividad cliente periódica para mantener viva la
//   conexión. Sin esto, el server cerraba el WS cada ~10-30s y la app reconectaba
//   en loop, dando sensación de "caídas constantes".
// · FIX #2 — Watchdog de stale connection. Si pasan >30s sin recibir un precio,
//   se fuerza reconexión. Cubre el caso "WS técnicamente abierto pero el servidor
//   dejó de mandar mensajes" (común con WebSockets en mercados quietos).
// · FIX #3 — Logging en onerror/onclose con código y razón. Antes onerror era
//   función vacía; ahora hay diagnóstico mínimo en consola del navegador.
// · FIX #4 — Backoff exponencial en reconexión: 3s → 6s → 12s → 24s → 48s → 60s
//   (cap). Evita martillar el servidor si está caído. Se resetea al primer
//   onopen exitoso.

"use client";

import { useEffect, useRef, useState, useCallback } from "react";

export interface LivePrice {
  price:         number;
  changeSession: number;  // % desde apertura de sesión del navegador (no 24h reales)
  connected:     boolean;
  lastUpdate:    number;
}

// API key inyectada desde variable de entorno de Next.js (público — solo lectura de precios)
const TD_KEY = process.env.NEXT_PUBLIC_TWELVEDATA_API_KEY ?? "";
const WS_URL = `wss://ws.twelvedata.com/v1/quotes/price?apikey=${TD_KEY}`;

// Configuración de robustez (auditoría 04/06/2026)
const HEARTBEAT_INTERVAL_MS = 10_000;  // FIX #1: heartbeat cada 10s
const WATCHDOG_INTERVAL_MS  = 10_000;  // FIX #2: chequear stale cada 10s
const STALE_TIMEOUT_MS      = 30_000;  // FIX #2: >30s sin precios = muerto
const RECONNECT_BASE_MS     = 3_000;   // FIX #4: backoff inicial 3s
const RECONNECT_MAX_MS      = 60_000;  // FIX #4: backoff máximo 60s

export function useTwelveDataWS(): LivePrice {
  const [data, setData] = useState<LivePrice>({
    price: 0, changeSession: 0, connected: false, lastUpdate: 0,
  });

  const wsRef        = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout>  | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const watchdogRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastMsgAtRef = useRef<number>(0);
  const attemptsRef  = useRef<number>(0);
  const mountedRef   = useRef(true);
  const openPrice    = useRef<number>(0);

  // Limpia todos los timers/intervals sin desmontar el hook (uso interno)
  const clearAllTimers = useCallback(() => {
    if (reconnectRef.current) { clearTimeout(reconnectRef.current); reconnectRef.current = null; }
    if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null; }
    if (watchdogRef.current)  { clearInterval(watchdogRef.current);  watchdogRef.current  = null; }
  }, []);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    // Si no hay API key, no intentar conectar — evita loop infinito
    if (!TD_KEY || TD_KEY.trim() === "") {
      console.warn("[TwelveData] API key no configurada — WS desactivado");
      setData((prev) => ({ ...prev, connected: false }));
      return;
    }

    // Cerrar conexión previa si quedó abierta (evita sockets superpuestos)
    if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
      wsRef.current.onclose = null;  // suprimir el handler para no disparar reconexión doble
      try { wsRef.current.close(); } catch {}
    }
    clearAllTimers();

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;
    lastMsgAtRef.current = Date.now();  // inicializar marca para el watchdog

    ws.onopen = () => {
      if (!mountedRef.current) return;
      console.info("[TwelveData] WS conectado");

      // Suscribirse a XAU/USD
      try {
        ws.send(JSON.stringify({
          action: "subscribe",
          params: { symbols: "XAU/USD" },
        }));
      } catch (e) {
        console.warn("[TwelveData] error en subscribe:", e);
      }

      // FIX #4: reset del contador de reintentos al conectar exitosamente
      attemptsRef.current = 0;

      // FIX #1: Heartbeat cada 10s para mantener viva la conexión.
      // TwelveData cierra conexiones inactivas; este ping evita el cierre.
      heartbeatRef.current = setInterval(() => {
        if (!mountedRef.current) return;
        if (ws.readyState !== WebSocket.OPEN) return;
        try {
          ws.send(JSON.stringify({ action: "heartbeat" }));
        } catch (e) {
          console.warn("[TwelveData] error enviando heartbeat:", e);
        }
      }, HEARTBEAT_INTERVAL_MS);

      // FIX #2: Watchdog de stale.
      // Si pasaron >30s sin recibir un precio (no solo heartbeat ack), forzar reconexión.
      watchdogRef.current = setInterval(() => {
        if (!mountedRef.current) return;
        const elapsed = Date.now() - lastMsgAtRef.current;
        if (elapsed > STALE_TIMEOUT_MS) {
          console.warn(`[TwelveData] conexión stale (${elapsed}ms sin precios) — forzando reconexión`);
          try { ws.close(); } catch {}  // dispara onclose → reconnect con backoff
        }
      }, WATCHDOG_INTERVAL_MS);

      setData((prev) => ({ ...prev, connected: true }));
    };

    ws.onmessage = (event: MessageEvent) => {
      if (!mountedRef.current) return;

      try {
        const msg = JSON.parse(event.data as string);

        // Ignorar eventos que no son precio (heartbeat ack, status, etc.)
        if (msg.event !== "price") return;
        if (!msg.price) return;

        const price = parseFloat(msg.price);
        if (!price || price <= 0) return;

        // FIX #2: actualizar marca de tiempo SOLO al recibir un precio real.
        // Si solo actualizamos al recibir cualquier mensaje (incluyendo
        // heartbeat ack), el watchdog nunca detectaría una conexión muerta
        // que sigue respondiendo heartbeats pero ya no manda precios.
        lastMsgAtRef.current = Date.now();

        // Primer precio como referencia de sesión (openPrice se resetea al recargar)
        if (openPrice.current === 0) openPrice.current = price;

        // changeSession: % desde apertura de la sesión del navegador
        const chg = openPrice.current > 0
          ? ((price - openPrice.current) / openPrice.current) * 100
          : 0;

        setData({
          price,
          changeSession: chg,
          connected:     true,
          lastUpdate:    Date.now(),
        });
      } catch {
        // skip malformed
      }
    };

    // FIX #3: logging de errores (antes era función vacía, ocultaba todo)
    ws.onerror = (event) => {
      console.warn("[TwelveData] WS error:", event);
    };

    ws.onclose = (event) => {
      if (!mountedRef.current) return;

      // Limpiar heartbeat + watchdog antes de programar reconexión
      if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null; }
      if (watchdogRef.current)  { clearInterval(watchdogRef.current);  watchdogRef.current  = null; }

      setData((prev) => ({ ...prev, connected: false }));

      // FIX #3: log con código y razón del cierre
      console.warn(`[TwelveData] WS cerrado (code=${event.code}, reason="${event.reason || "-"}", clean=${event.wasClean})`);

      // Si no hay API key, no reintentar
      if (!TD_KEY || TD_KEY.trim() === "") return;

      // FIX #4: backoff exponencial — 3s → 6s → 12s → 24s → 48s → 60s (cap).
      // Se resetea a 1 cuando onopen tiene éxito.
      attemptsRef.current += 1;
      const attempt = attemptsRef.current;
      const delay   = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt - 1), RECONNECT_MAX_MS);

      console.info(`[TwelveData] reconectando en ${delay}ms (intento #${attempt})`);
      reconnectRef.current = setTimeout(() => {
        if (mountedRef.current) connect();
      }, delay);
    };
  }, [clearAllTimers]);

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      clearAllTimers();
      if (wsRef.current) {
        wsRef.current.onclose = null;
        try { wsRef.current.close(); } catch {}
      }
    };
  }, [connect, clearAllTimers]);

  return data;
}
