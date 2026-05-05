// lib/ws/binance-ws.ts
// Precio en vivo: TwelveData WebSocket — XAU/USD tick a tick
// Señales MTF:    Binance Futures REST — en LiveTerminal.tsx
// La API key de TwelveData va en Vercel → Settings → Environment Variables
// TWELVEDATA_API_KEY = tu_key

"use client";

import { useEffect, useRef, useState, useCallback } from "react";

export interface LivePrice {
  price:      number;
  change24h:  number;
  connected:  boolean;
  lastUpdate: number;
}

// API key inyectada desde variable de entorno de Next.js (público — solo lectura de precios)
const TD_KEY = process.env.NEXT_PUBLIC_TWELVEDATA_API_KEY ?? "";
const WS_URL = `wss://ws.twelvedata.com/v1/quotes/price?apikey=${TD_KEY}`;
const RECONNECT_DELAY_MS = 3_000;

export function useBinanceWS(
  _symbol:   string = "xauusdt",
  _interval: string = "1m"
): LivePrice {
  const [data, setData] = useState<LivePrice>({
    price: 0, change24h: 0, connected: false, lastUpdate: 0,
  });

  const wsRef      = useRef<WebSocket | null>(null);
  const timerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const openPrice  = useRef<number>(0);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
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

        // Primer precio como referencia de sesión
        if (openPrice.current === 0) openPrice.current = price;

        const chg = openPrice.current > 0
          ? ((price - openPrice.current) / openPrice.current) * 100
          : 0;

        setData({
          price,
          change24h:  chg,
          connected:  true,
          lastUpdate: Date.now(),
        });
      } catch {
        // skip malformed
      }
    };

    ws.onerror = () => {};

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setData((prev) => ({ ...prev, connected: false }));
      timerRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
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
