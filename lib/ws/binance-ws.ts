// lib/ws/binance-ws.ts
// Precio en vivo: Binance SPOT WebSocket (stream.binance.com:9443)
// Señales MTF:    Binance FUTURES REST (fapi.binance.com) — en LiveTerminal.tsx

"use client";

import { useEffect, useRef, useState, useCallback } from "react";

export interface LivePrice {
  price:      number;
  change24h:  number;
  connected:  boolean;
  lastUpdate: number;
}

const WS_URL = "wss://stream.binance.com:9443/ws/xauusdt@kline_1m";
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
      setData((prev) => ({ ...prev, connected: true }));
    };

    ws.onmessage = (event: MessageEvent) => {
      if (!mountedRef.current) return;
      try {
        const msg = JSON.parse(event.data as string);
        const k = msg.k;
        if (!k) return;

        const close = parseFloat(k.c);
        const open  = parseFloat(k.o);

        if (openPrice.current === 0) openPrice.current = open;

        const chg = openPrice.current > 0
          ? ((close - openPrice.current) / openPrice.current) * 100
          : 0;

        setData((prev) => ({
          ...prev,
          price:      close,
          change24h:  chg,
          connected:  true,
          lastUpdate: Date.now(),
        }));
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
