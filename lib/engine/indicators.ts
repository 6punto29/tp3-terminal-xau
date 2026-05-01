// ─────────────────────────────────────────────────────────────────────────────
// lib/engine/indicators.ts
// Pure math functions. Zero side effects, zero I/O, zero framework deps.
// Faithful port of original index.html lines 1306-1309.
// ─────────────────────────────────────────────────────────────────────────────

import { Candle, PrecomputedIndicators, BollingerBand } from "./types";

// ── Point-in-time calculators (used for live signal calculation) ──────────────

/** Exponential Moving Average — exact port from original */
export function emaCalc(arr: number[], p: number): number | null {
  if (arr.length < p) return null;
  const k = 2 / (p + 1);
  let v = arr.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < arr.length; i++) v = arr[i] * k + v * (1 - k);
  return v;
}

/** RSI — simple avg gain/loss, exact port from original */
export function rsiCalc(arr: number[], p: number): number | null {
  if (arr.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = arr.length - p; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    d >= 0 ? (g += d) : (l -= d);
  }
  const ag = g / p, al = l / p;
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

/** Bollinger Bands — exact port from original */
export function bollCalc(arr: number[], p = 20, m = 2): BollingerBand | null {
  if (arr.length < p) return null;
  const sl = arr.slice(-p);
  const mid = sl.reduce((a, b) => a + b, 0) / p;
  const std = Math.sqrt(sl.reduce((a, b) => a + (b - mid) ** 2, 0) / p);
  return { u: mid + m * std, l: mid - m * std };
}

/** Average True Range — for SL reference */
export function atrCalc(candles: Candle[], p = 14): number | null {
  if (candles.length < p + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const hl = candles[i].h - candles[i].l;
    const hc = Math.abs(candles[i].h - candles[i - 1].c);
    const lc = Math.abs(candles[i].l - candles[i - 1].c);
    trs.push(Math.max(hl, hc, lc));
  }
  return trs.slice(-p).reduce((a, b) => a + b, 0) / p;
}

// ── Precomputed arrays (O(N) vs O(N²)) ────────────────────────────────────────
// Use these in the backtest engine to avoid recalculating on every bar.
// Use point-in-time calculators above for live signals.

export function precompute(candles: Candle[]): PrecomputedIndicators {
  const closes = candles.map((c) => c.c);
  const N = closes.length;

  function runEMA(p: number): (number | null)[] {
    const out: (number | null)[] = new Array(N).fill(null);
    if (N < p) return out;
    const k = 2 / (p + 1);
    let v = closes.slice(0, p).reduce((a, b) => a + b, 0) / p;
    out[p - 1] = v;
    for (let i = p; i < N; i++) {
      v = closes[i] * k + v * (1 - k);
      out[i] = v;
    }
    return out;
  }

  function runRSI(p: number): (number | null)[] {
    const out: (number | null)[] = new Array(N).fill(null);
    for (let i = p; i < N; i++) {
      let g = 0, l = 0;
      for (let j = i - p + 1; j <= i; j++) {
        const d = closes[j] - closes[j - 1];
        d >= 0 ? (g += d) : (l -= d);
      }
      const ag = g / p, al = l / p;
      out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }
    return out;
  }

  function runBoll(p = 20, m = 2): (BollingerBand | null)[] {
    const out: (BollingerBand | null)[] = new Array(N).fill(null);
    for (let i = p - 1; i < N; i++) {
      const sl = closes.slice(i - p + 1, i + 1);
      const mid = sl.reduce((a, b) => a + b, 0) / p;
      const std = Math.sqrt(sl.reduce((a, b) => a + (b - mid) ** 2, 0) / p);
      out[i] = { u: mid + m * std, l: mid - m * std };
    }
    return out;
  }

  return {
    closes,
    ema12:  runEMA(12),
    ema26:  runEMA(26),
    ema50:  runEMA(50),
    ema200: runEMA(200),
    rsi6:   runRSI(6),
    rsi12:  runRSI(12),
    boll:   runBoll(20, 2),
  };
}
