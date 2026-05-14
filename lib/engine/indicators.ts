// ─────────────────────────────────────────────────────────────────────────────
// lib/engine/indicators.ts
// Pure math functions. Zero side effects, zero I/O, zero framework deps.
// ─────────────────────────────────────────────────────────────────────────────

import { Candle, PrecomputedIndicators, BollingerBand, FVGZone } from "./types";

export function emaCalc(arr: number[], p: number): number | null {
  if (arr.length < p) return null;
  const k = 2 / (p + 1);
  let v = arr.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < arr.length; i++) v = arr[i] * k + v * (1 - k);
  return v;
}

export function rsiCalc(arr: number[], p: number): number | null {
  if (arr.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = arr.length - p; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    d >= 0 ? (g += d) : (l -= d);
  }
  const ag = g / p, al = l / p;
  // Precio plano (sin ganancias ni pérdidas) → RSI neutral 50
  if (ag === 0 && al === 0) return 50;
  // Solo ganancias sin pérdidas → RSI máximo 100
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

export function bollCalc(arr: number[], p = 20, m = 2): BollingerBand | null {
  if (arr.length < p) return null;
  const sl = arr.slice(-p);
  const mid = sl.reduce((a, b) => a + b, 0) / p;
  const std = Math.sqrt(sl.reduce((a, b) => a + (b - mid) ** 2, 0) / p);
  return { u: mid + m * std, l: mid - m * std };
}

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

// ── Previous Day High/Low ─────────────────────────────────────────────────────
// Extrae PDH y PDL de un array de velas D1.
// Son los niveles de liquidez más importantes — targets institucionales reales.
//
// Fix #2 (v4): los fetchers ya aplican .slice(0,-1) eliminando la vela abierta
// de hoy, por lo que el último elemento del array ya es "ayer cerrado".
// Antes leíamos length-2 (anteayer) por error.
export function getPDHL(d1Candles: Candle[]): { pdh: number | null; pdl: number | null } {
  if (d1Candles.length < 1) return { pdh: null, pdl: null };
  const prev = d1Candles[d1Candles.length - 1];
  return { pdh: prev.h, pdl: prev.l };
}

// ── Precomputed arrays ────────────────────────────────────────────────────────

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

  function runSwings(p = 3): { highs: (number | null)[]; lows: (number | null)[] } {
    const highs: (number | null)[] = new Array(N).fill(null);
    const lows:  (number | null)[] = new Array(N).fill(null);
    for (let i = p; i < N - p; i++) {
      let isH = true, isL = true;
      for (let d = 1; d <= p; d++) {
        if (candles[i].h < candles[i - d].h || candles[i].h < candles[i + d].h) isH = false;
        if (candles[i].l > candles[i - d].l || candles[i].l > candles[i + d].l) isL = false;
      }
      if (isH) highs[i] = candles[i].h;
      if (isL) lows[i]  = candles[i].l;
    }
    return { highs, lows };
  }

  /**
   * Fair Value Gaps — desequilibrios institucionales.
   *
   * Bullish FVG: la vela de hace 2 no alcanza a la vela actual por arriba.
   *   candles[i-2].high < candles[i].low → gap alcista entre esos dos niveles.
   *
   * Bearish FVG: la vela de hace 2 no alcanza a la vela actual por abajo.
   *   candles[i-2].low > candles[i].high → gap bajista.
   *
   * Tracking de estado (Fix #6 v4 — invalidación por MECHA, no cierre):
   * - Una FVG alcista se invalida (null) cuando la MECHA inferior (low) penetra su bot.
   * - Una FVG bajista se invalida cuando la MECHA superior (high) penetra su top.
   * - Regla conservadora: cualquier toque al bot/top mata la zona, aunque el precio
   *   se recupere y cierre adentro. Más seguro contra falsos positivos en oro 1H.
   * - Mientras el precio está DENTRO de la zona sin tocar bot/top, la FVG sigue activa.
   *
   * Solo guardamos la FVG más reciente de cada tipo. Para gold 1H esto es suficiente.
   */
  function runFVG(): { bull: FVGZone | null; bear: FVGZone | null }[] {
    const out: { bull: FVGZone | null; bear: FVGZone | null }[] =
      new Array(N).fill(null).map(() => ({ bull: null, bear: null }));

    let activeBull: FVGZone | null = null;
    let activeBear: FVGZone | null = null;

    for (let i = 2; i < N; i++) {
      // Detectar nueva FVG alcista (solo si no hay una activa)
      if (!activeBull && candles[i].l > candles[i - 2].h) {
        activeBull = { top: candles[i].l, bot: candles[i - 2].h, index: i };
      }
      // Detectar nueva FVG bajista (solo si no hay una activa)
      if (!activeBear && candles[i].h < candles[i - 2].l) {
        activeBear = { top: candles[i - 2].l, bot: candles[i].h, index: i };
      }

      // Invalidar FVG alcista si la mecha (low) penetra su base — regla conservadora
      if (activeBull && candles[i].l < activeBull.bot) {
        activeBull = null;
      }
      // Invalidar FVG bajista si la mecha (high) penetra su techo — regla conservadora
      if (activeBear && candles[i].h > activeBear.top) {
        activeBear = null;
      }

      out[i] = { bull: activeBull, bear: activeBear };
    }

    return out;
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
    fvg:    runFVG(),
  };
}
