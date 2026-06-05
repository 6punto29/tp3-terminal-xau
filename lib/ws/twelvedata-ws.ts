// lib/ws/twelvedata-ws.ts
// Precio en vivo: TwelveData WebSocket — XAU/USD tick a tick
//
// La API key de TwelveData va en Vercel → Settings → Environment Variables:
//   NEXT_PUBLIC_TWELVEDATA_API_KEY = tu_key
//
// Notas:
// · changeSession: cambio % desde el primer tick que recibió ESTE navegador en
//   esta sesión (resetea al recargar), NO cambio real de 24h.
//
// Historia del archivo (04/06/2026):
// · Antes se llamaba `binance-ws.ts` por legado histórico. Renombrado para
//   reflejar lo que realmente maneja: solo TwelveData. Las señales MTF de
//   Binance Futures REST viven en lib/binance/klines.ts.
// · Versión "v2-heartbeat" (04/06/2026 noche) — agregamos heartbeat application
//   level, watchdog stale, backoff exponencial. Resultado: se observó loop de
//   "WS cerrado / reconectando" en consola del navegador en sesión asiática.
//   No podemos confirmar si las caídas son del refactor o si siempre existieron
//   (el archivo viejo no logueaba) — esta versión revierte a la lógica simple
//   del viejo, manteniendo SOLO el logging para diagnóstico. Si las caídas
//   persisten en horario LDN/NY (alta liquidez), sabemos que son del lado del
//   servidor (plan TwelveData, política, network desde Colombia).

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
const RECONNECT_DELAY_MS = 3_000;

export function useTwelveDataWS(): LivePrice {
  const [data, setData] = useState<LivePrice>({
    price: 0, changeSession: 0, connected: false, lastUpdate: 0,
  });

  const wsRef      = useRef<WebSocket | null>(null);
  const timerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const openPrice  = useRef<number>(0);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    // Si no hay API key, no intentar conectar — evita loop infinito
    if (!TD_KEY || TD_KEY.trim() === "") {
      console.warn("[TwelveData] API key no configurada — WS desactivado");
      setData((prev) => ({ ...prev, connected: false }));
      return;
    }

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      console.info("[TwelveData] WS conectado");
      // Suscribirse a XAU/USD
      ws.send(JSON.stringify({
        action: "subscribe",
        params: { symbols: "XAU/USD" },
      }));
      setData((prev) => ({ ...prev, connected: true }));
    };

    ws.onmessage = (event: MessageEvent) => {
      if (!mountedRef.current) return;
      try {
        const msg = JSON.parse(event.data as string);

        // Ignorar eventos que no son precio
        if (msg.event !== "price") return;
        if (!msg.price) return;

        const price = parseFloat(msg.price);
        if (!price || price <= 0) return;

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

    // Logging mínimo de errores (en archivo viejo era función vacía).
    // Sirve para diagnóstico — si todo va bien no aparece nada.
    ws.onerror = (event) => {
      console.warn("[TwelveData] WS error:", event);
    };

    ws.onclose = (event) => {
      if (!mountedRef.current) return;
      setData((prev) => ({ ...prev, connected: false }));

      // Log con código y razón del cierre — diagnóstico clave para mañana
      console.warn(`[TwelveData] WS cerrado (code=${event.code}, reason="${event.reason || "-"}", clean=${event.wasClean})`);

      // Solo reconectar si hay API key configurada
      if (TD_KEY && TD_KEY.trim() !== "") {
        console.info(`[TwelveData] reconectando en ${RECONNECT_DELAY_MS}ms`);
        timerRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
      }
    };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); }
    };
  }, [connect]);

  return data;
}
