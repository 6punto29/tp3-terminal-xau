// ─────────────────────────────────────────────────────────────────────────────
// lib/ws/binance-ws.ts
// React hook — Binance FUTURES WebSocket (fstream.binance.com)
// Usa combined stream: kline_1m + miniTicker
//   · kline_1m  → precio en tiempo real (tick a tick)
//   · miniTicker → cambio 24h real (open hace 24h vs precio actual)
// ─────────────────────────────────────────────────────────────────────────────

"use client";

import { useEffect, useRef, useState, useCallback } from "react";

export interface LiveKline {
  t:      number;
  o:      number;
  h:      number;
  l:      number;
  c:      number;
  v:      number;
  closed: boolean;
}

export interface LivePrice {
  price:      number;   // último precio (cierre vela 1m)
  change24h:  number;   // % cambio real últimas 24h (del miniTicker)
  high24h:    number;   // máximo 24h
  low24h:     number;   // mínimo 24h
  kline:      LiveKline | null;
  connected:  boolean;
  lastUpdate: number;
}

// Combined stream: kline_1m + miniTicker en una sola conexión WS
const WS_BASE    = "wss://fstream.binance.com/stream";
const RECONNECT_DELAY_MS = 3_000;

export function useBinanceWS(
  symbol:   string = "xauusdt",
  interval: string = "1m"
): LivePrice {
  const [data, setData] = useState<LivePrice>({
    price:      0,
    change24h:  0,
    high24h:    0,
    low24h:     0,
    kline:      null,
    connected:  false,
    lastUpdate: 0,
  });

  const wsRef      = useRef<WebSocket | null>(null);
  const timerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    const sym = symbol.toLowerCase();
    const url = `${WS_BASE}?streams=${sym}@kline_${interval}/${sym}@miniTicker`;
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
        const streamName: string = msg.stream ?? "";
        const payload            = msg.data ?? msg;

        if (streamName.includes("kline") || payload.k) {
          const k = payload.k ?? payload;
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
            kline,
            lastUpdate: Date.now(),
          }));

        } else if (streamName.includes("miniTicker") || payload.e === "24hrMiniTicker") {
          const last  = parseFloat(payload.c);
          const open  = parseFloat(payload.o);
          const high  = parseFloat(payload.h);
          const low   = parseFloat(payload.l);
          const chg24 = open > 0 ? ((last - open) / open) * 100 : 0;
          setData((prev) => ({
            ...prev,
            change24h:  chg24,
            high24h:    high,
            low24h:     low,
          }));
        }

      } catch {
        // skip malformed messages
      }
    };

    ws.onerror = () => {};

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setData((prev) => ({ ...prev, connected: false }));
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
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
    };
  }, [connect]);

  return data;
}
