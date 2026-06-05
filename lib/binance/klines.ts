// lib/binance/klines.ts
// Binance Futures REST — XAU/USD klines (velas históricas) para el motor de señales MTF.
//
// IMPORTANTE: el WebSocket de Binance está bloqueado desde IPs colombianas
// server-side. Acá usamos solo el endpoint REST (fapi.binance.com), que también
// tiene restricciones regionales pero funciona desde el navegador del usuario
// (client-side) cuando el usuario tiene IP de un país permitido. Las rutas
// server-side que necesitan Binance corren en Frankfurt (fra1) por la misma razón.
//
// Esta función `fetchLiveCandles` es CLIENT-SIDE: corre en el navegador, no en
// Vercel. Devuelve velas para los 6 timeframes que consume LiveTerminal (4h, 1h,
// 15m, 5m, 1d, y el htfTf/ltfTf seleccionado por el usuario).
//
// Extraído de components/LiveTerminal.tsx el 04/06/2026 para separar la fuente
// Binance (REST) de la fuente TwelveData (WS) que vive en lib/ws/twelvedata-ws.ts.
// Antes ambas fuentes estaban mezcladas: el código de WS de TwelveData en un
// archivo llamado `binance-ws.ts` (engañoso) y el REST de Binance dentro del
// componente UI. Ahora cada fuente tiene su archivo y su carpeta:
//   · lib/ws/twelvedata-ws.ts  → TwelveData WebSocket (precio tick a tick)
//   · lib/binance/klines.ts    → Binance Futures REST  (velas para señales)

import type { Candle } from "@/lib/engine/types";

const BINANCE_FUTURES  = "https://fapi.binance.com/fapi/v1/klines";
const FETCH_TIMEOUT_MS = 10_000;

// Fix #3 (v4): aborta la request si Binance tarda más de 10s.
// Antes una request colgada congelaba el motor de señales hasta el próximo
// ciclo de 5min.
export async function fetchWithTimeout(url:string,timeoutMs=FETCH_TIMEOUT_MS):Promise<Response>{
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{return await fetch(url,{signal:controller.signal});}
  finally{clearTimeout(timer);}
}

// Trae las velas históricas del timeframe `tf` (formato Binance: "5m", "15m",
// "1h", "4h", "1d") con el límite indicado. Descarta la última vela porque
// puede estar abierta (in-progress) y daría señales corruptas.
export async function fetchLiveCandles(tf:string,limit=250):Promise<Candle[]>{
  const r=await fetchWithTimeout(`${BINANCE_FUTURES}?symbol=XAUUSDT&interval=${tf}&limit=${limit}`);
  if(!r.ok)throw new Error(`Binance ${r.status} (${tf})`);
  const d=await r.json() as number[][];
  if(!Array.isArray(d)||!d.length)return[];
  return d.slice(0,-1).map(k=>({t:+k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]}));
}
