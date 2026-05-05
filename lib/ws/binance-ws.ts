// lib/ws/binance-ws.ts
// Precio en vivo via Binance SPOT REST polling cada 2s
// Señales (klines) via Binance FUTURES REST — en LiveTerminal.tsx
// WebSocket no disponible para XAUUSDT desde Colombia (restricción regional Binance)

"use client";

import { useEffect, useRef, useState } from "react";

export interface LivePrice {
  price:      number;
  change24h:  number;
  high24h:    number;
  low24h:     number;
  connected:  boolean;
  lastUpdate: number;
}

const SPOT_TICKER = "https://api.binance.com/api/v3/ticker/24hr?symbol=XAUUSDT";
const POLL_MS     = 2_000;

export function useBinanceWS(
  _symbol:   string = "xauusdt",
  _interval: string = "1m"
): LivePrice {
  const [data, setData] = useState<LivePrice>({
    price: 0, change24h: 0, high24h: 0, low24h: 0,
    connected: false, lastUpdate: 0,
  });

  const timerRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    async function poll() {
      try {
        const r = await fetch(SPOT_TICKER);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();

        if (!mountedRef.current) return;

        const price    = parseFloat(d.lastPrice);
        const change24 = parseFloat(d.priceChangePercent);
        const high24   = parseFloat(d.highPrice);
        const low24    = parseFloat(d.lowPrice);

        setData({
          price, change24h: change24,
          high24h: high24, low24h: low24,
          connected: true, lastUpdate: Date.now(),
        });
      } catch {
        if (!mountedRef.current) return;
        setData((prev) => ({ ...prev, connected: false }));
      }
    }

    poll(); // llamada inmediata
    timerRef.current = setInterval(poll, POLL_MS);

    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  return data;
}
