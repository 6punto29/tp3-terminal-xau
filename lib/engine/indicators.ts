// ─────────────────────────────────────────────────────────────────────────────
// lib/engine/indicators.ts
// Pure math functions. Zero side effects, zero I/O, zero framework deps.
// ─────────────────────────────────────────────────────────────────────────────

import { Candle, PrecomputedIndicators, BollingerBand } from "./types";

// ── Point-in-time calculators (used for live signal calculation) ──────────────

/** Exponential Moving Average */
export function emaCalc(arr: number[], p: number): number | null {
  if (arr.length < p) return null;
  const k = 2 / (p + 1);
  let v = arr.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < arr.length; i++) v = arr[i] * k + v * (1 - k);
  return v;
}

/** RSI — simple avg gain/loss */
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

/** Bollinger Bands */
export function bollCalc(arr: number[], p = 20, m = 2): BollingerBand | null {
  if (arr.length < p) return null;
  const sl = arr.slice(-p);
  const mid = sl.reduce((a, b) => a + b, 0) / p;
  const std = Math.sqrt(sl.reduce((a, b) => a + (b - mid) ** 2, 0) / p);
  return { u: mid + m * std, l: mid - m * std };
}

/** Average True Range — volatilidad real del mercado */
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

// ── Precomputed arrays (O(N)) ─────────────────────────────────────────────────

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

  /** ATR 14 precomputado — cuánto mueve el gold por vela */
  function runATR(p = 14): (number | null)[] {
    const out: (number | null)[] = new Array(N).fill(null);
    if (N < p + 1) return out;
    for (let i = p; i < N; i++) {
      let sum = 0;
      for (let j = i - p + 1; j <= i; j++) {
        const hl = candles[j].h - candles[j].l;
        const hc = Math.abs(candles[j].h - candles[j - 1].c);
        const lc = Math.abs(candles[j].l - candles[j - 1].c);
        sum += Math.max(hl, hc, lc);
      }
      out[i] = sum / p;
    }
    return out;
  }

  /**
   * Swing pivots — detección de 3 barras sin lookahead bias.
   *
   * Un swing HIGH en i si: candles[i].h es el máximo de la ventana
   * [i-p .. i+p]. Marcamos el pivot en i pero solo lo consideramos
   * confirmado cuando estamos en i+p (p barras después) — sin lookahead
   * para trading en vivo porque getLiveVerdict usa i = N-1-p como último
   * pivot seguro.
   *
   * p = 3: ventana de 3 barras cada lado — balance entre sensibilidad y ruido.
   * En 1H esto equivale a pivots confirmados cada ~3-6 horas.
   */
  function runSwings(p = 3): { highs: (number | null)[]; lows: (number | null)[] } {
    const highs: (number | null)[] = new Array(N).fill(null);
    const lows:  (number | null)[] = new Array(N).fill(null);
    for (let i = p; i < N - p; i++) {
      let isH = true, isL = true;
      for (let d = 1; d <= p; d++) {
        if (candles[i].h <= candles[i - d].h || candles[i].h <= candles[i + d].h) isH = false;
        if (candles[i].l >= candles[i - d].l || candles[i].l >= candles[i + d].l) isL = false;
      }
      if (isH) highs[i] = candles[i].h;
      if (isL) lows[i]  = candles[i].l;
    }
    return { highs, lows };
  }

  const { highs: swingH, lows: swingL } = runSwings(3);

  return {
    closes,
    ema12:  runEMA(12),
    ema26:  runEMA(26),
    ema50:  runEMA(50),
    ema200: runEMA(200),
    rsi14:  runRSI(14),
    rsi9:   runRSI(9),
    boll:   runBoll(20, 2),
    atr:    runATR(14),
    swingH,
    swingL,
  };
}
