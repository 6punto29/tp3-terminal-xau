// ─────────────────────────────────────────────────────────────────────────────
// lib/ws/binance-ws.ts
// React hook for the Binance Futures WebSocket kline stream.
// Connects once, reconnects on drop, tears down cleanly on unmount.
// ─────────────────────────────────────────────────────────────────────────────

"use client";

import { useEffect, useRef, useState, useCallback } from "react";

export interface LiveKline {
  t:      number;   // open time
  o:      number;
  h:      number;
  l:      number;
  c:      number;   // current close
  v:      number;
  closed: boolean;  // true when candle is final
}

export interface LivePrice {
  price:     number;
  change24h: number;   // % change from 24h open
  kline:     LiveKline | null;
  connected: boolean;
  lastUpdate: number;
}

const WS_BASE = "wss://fstream.binance.com/ws";
const RECONNECT_DELAY_MS = 3_000;

/**
 * Subscribe to a Binance Futures kline stream.
 * @param symbol  e.g. "xauusdt"
 * @param interval  e.g. "1m"
 */
export function useBinanceWS(
  symbol:   string = "xauusdt",
  interval: string = "1m"
): LivePrice {
  const [data, setData] = useState<LivePrice>({
    price:     0,
    change24h: 0,
    kline:     null,
    connected: false,
    lastUpdate: 0,
  });

  const wsRef       = useRef<WebSocket | null>(null);
  const timerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef  = useRef(true);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    const url = `${WS_BASE}/${symbol}@kline_${interval}`;
    const ws  = new WebSocket(url);
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
          t:      k.t,
          o:      parseFloat(k.o),
          h:      parseFloat(k.h),
          l:      parseFloat(k.l),
          c:      parseFloat(k.c),
          v:      parseFloat(k.v),
          closed: k.x,
        };

        setData((prev) => ({
          ...prev,
          price:      kline.c,
          change24h:  kline.o > 0
            ? ((kline.c - kline.o) / kline.o) * 100
            : prev.change24h,
          kline,
          lastUpdate: Date.now(),
        }));
      } catch {
        // malformed message — skip
      }
    };

    ws.onerror = () => {
      // onclose will fire next and handle reconnect
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setData((prev) => ({ ...prev, connected: false }));
      // Reconnect after delay
      timerRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
    };
  }, [symbol, interval]);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent reconnect on intentional unmount
        wsRef.current.close();
      }
    };
  }, [connect]);

  return data;
}
