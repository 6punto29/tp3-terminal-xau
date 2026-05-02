// lib/ws/binance-ws.ts
// React hook — Binance FUTURES WebSocket (fstream.binance.com)
// Stream simple: xauusdt@kline_1m — confirmado funcionando para XAUUSDT

"use client";

import { useEffect, useRef, useState, useCallback } from "react";

export interface LiveKline {
  t: number; o: number; h: number; l: number; c: number; v: number; closed: boolean;
}

export interface LivePrice {
  price:      number;
  change24h:  number;
  kline:      LiveKline | null;
  connected:  boolean;
  lastUpdate: number;
}

const WS_URL = "wss://fstream.binance.com/ws/xauusdt@kline_1m";
const RECONNECT_DELAY_MS = 3_000;

export function useBinanceWS(
  symbol:   string = "xauusdt",
  interval: string = "1m"
): LivePrice {
  const [data, setData] = useState<LivePrice>({
    price: 0, change24h: 0, kline: null, connected: false, lastUpdate: 0,
  });

  const wsRef      = useRef<WebSocket | null>(null);
  const timerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const openRef    = parseFloat("0"); // precio de apertura de sesión para change24h
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
        const k   = msg.k;
        if (!k) return;

        const kline: LiveKline = {
          t: k.t, o: parseFloat(k.o), h: parseFloat(k.h),
          l: parseFloat(k.l), c: parseFloat(k.c), v: parseFloat(k.v), closed: k.x,
        };

        // Guardar primer precio como referencia de apertura de sesión
        if (openPrice.current === 0) openPrice.current = kline.o;

        const chg = openPrice.current > 0
          ? ((kline.c - openPrice.current) / openPrice.current) * 100
          : 0;

        setData((prev) => ({
          ...prev,
          price:      kline.c,
          change24h:  chg,
          kline,
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
