// ─────────────────────────────────────────────────────────────────────────────
// lib/engine/simulator.ts
// SL/TP simulation and result aggregation.
// Pure functions — no I/O, no framework, fully testable.
//
// Cambios v5 (Paso 1 — alineación con engine en vivo):
// · simulateSignals ahora usa los slPrice/tpPrice ESTRUCTURALES pre-calculados
//   en detectSignals (mediante getStructureLevels). Antes calculaba con
//   entry × (1 ± %), lo cual NO reflejaba la lógica real del sistema en vivo
//   (que usa swings, PDH/PDL y caps). Ahora backtest = realidad operativa.
// ─────────────────────────────────────────────────────────────────────────────

import { RawSignal, SimulatedTrade, BacktestSummary } from "./types";

/**
 * Simulate each signal against its STRUCTURAL SL/TP (pre-calculated in
 * detectSignals via getStructureLevels). Aligns backtest with live engine.
 * 
 * Los parámetros slPct y tpPct quedan en la firma por compatibilidad pero
 * NO se usan para calcular niveles (ya vienen en cada señal). Sí se usan
 * para etiquetas/reportes en BacktestLaboratory.
 */
export function simulateSignals(
  signals:      RawSignal[],
  _slPct:       number,
  _tpPct:       number,
  holdCandles:  number
): SimulatedTrade[] {
  return signals.map((s) => {
    const slP = s.slPrice;
    const tpP = s.tpPrice;

    let won = false;
    let exitP = s.entry;
    let hitTP = false;
    let hitSL = false;

    const limit = Math.min(s.htfFuture.length, holdCandles + 1);
    for (let k = 0; k < limit; k++) {
      const ck = s.htfFuture[k];
      if (s.sig === "UP") {
        if (ck.l <= slP) { exitP = slP; hitSL = true; break; }
        if (ck.h >= tpP) { exitP = tpP; hitTP = true; won = true; break; }
      } else {
        if (ck.h >= slP) { exitP = slP; hitSL = true; break; }
        if (ck.l <= tpP) { exitP = tpP; hitTP = true; won = true; break; }
      }
    }

    if (!hitTP && !hitSL) {
      exitP = s.htfFuture.length > 0
        ? s.htfFuture[s.htfFuture.length - 1].c
        : s.entry;
      won =
        (s.sig === "UP"   && exitP > s.entry) ||
        (s.sig === "DOWN" && exitP < s.entry);
    }

    const pct =
      ((exitP - s.entry) / s.entry) * 100 * (s.sig === "DOWN" ? -1 : 1);

    return { ...s, won, pct, hitTP, hitSL };
  });
}

/** Aggregate trades into summary statistics */
export function summarize(trades: SimulatedTrade[]): BacktestSummary | null {
  if (!trades.length) return null;
  const wins  = trades.filter((t) => t.won);
  const loss  = trades.filter((t) => !t.won);
  const wr    = Math.round((wins.length / trades.length) * 100);
  const pnl   = trades.reduce((a, t) => a + t.pct, 0);
  const avgW  = wins.length
    ? wins.reduce((a, t) => a + t.pct, 0) / wins.length
    : 0;
  const avgL  = loss.length
    ? loss.reduce((a, t) => a + t.pct, 0) / loss.length
    : 0;
  // Breakdown del origen del TP — diagnóstico de la lógica estructural
  const tpSession   = trades.filter((t) => t.tpSource === "session").length;
  const tpStructure = trades.filter((t) => t.tpSource === "structure").length;
  const tpFallback  = trades.filter((t) => t.tpSource === "fallback").length;

  // Desglose por fuerza de señal (24/05/26) — FUERTES vs MODERADAS por separado.
  // Helper: calcula total/wins/wr/pnl de un subconjunto de trades.
  const groupStats = (subset: SimulatedTrade[]) => {
    const gWins = subset.filter((t) => t.won).length;
    const gPnl  = subset.reduce((a, t) => a + t.pct, 0);
    return {
      total: subset.length,
      wins:  gWins,
      wr:    subset.length ? Math.round((gWins / subset.length) * 100) : 0,
      pnl:   gPnl,
    };
  };
  const fuertes   = groupStats(trades.filter((t) => t.fuerza === "FUERTE"));
  const moderadas = groupStats(trades.filter((t) => t.fuerza === "MODERADA"));

  // EV correcto (24/05/26) — promedio de R reales, no R:R nominal.
  // Profit Factor — robustez del edge.
  const ev           = calcEVfromTrades(trades);
  const profitFactor = calcProfitFactor(trades);

  return { total: trades.length, wins: wins.length, wr, pnl, avgW, avgL,
    tpSession, tpStructure, tpFallback,
    fuertes, moderadas,
    ev, profitFactor };
}

/**
 * Expected Value en R-multiples — VERSIÓN NOMINAL (legacy).
 *
 * ⚠️ NO USAR PARA EL BACKTEST. Asume un R:R FIJO igual para todos los trades.
 * El simulador cierra trades con SL/TP ESTRUCTURALES (swings, PDH/PDL), así que
 * el R:R real varía trade por trade. Esta fórmula da un EV que no corresponde
 * a los trades simulados.
 *
 * Se mantiene solo por compatibilidad. Para el EV real usar calcEVfromTrades.
 */
export function calcEV(wr: number, rr: number): number {
  return (wr / 100) * rr - (1 - wr / 100) * 1;
}

/**
 * Expected Value en R-multiples — VERSIÓN CORRECTA (24/05/26).
 *
 * Calcula el R REAL de cada trade y los promedia. El R real de un trade es
 * cuánto ganó/perdió medido en múltiplos de SU PROPIO riesgo:
 *
 *   riesgo% del trade = |entry − slPrice| / entry × 100
 *   R real del trade  = pct del trade ÷ riesgo% del trade
 *
 * Un trade que tocó SL da −1R. Uno que ganó 4× su riesgo da +4R. Uno que cerró
 * a mitad de camino da su fracción real. El EV es el promedio de todos esos R.
 *
 * Esto refleja los SL/TP estructurales reales — no un R:R nominal inventado.
 * Fórmula respaldada por práctica estándar de backtesting (R-multiple promedio).
 */
export function calcEVfromTrades(trades: SimulatedTrade[]): number {
  if (!trades.length) return 0;
  let sumR = 0;
  let validos = 0;
  for (const t of trades) {
    // Riesgo del trade en % — distancia entry→SL
    const riesgoPct = Math.abs(t.entry - t.slPrice) / t.entry * 100;
    if (riesgoPct <= 0) continue;          // trade sin riesgo válido, se omite
    sumR += t.pct / riesgoPct;             // R real de este trade
    validos++;
  }
  return validos > 0 ? sumR / validos : 0;
}

/**
 * Profit Factor — ganancia bruta ÷ pérdida bruta (24/05/26).
 *
 * Métrica estándar de robustez. >1.5 sólido · >2.0 excelente · <1.2 frágil
 * (el edge no sobrevive a slippage + ejecución real).
 */
export function calcProfitFactor(trades: SimulatedTrade[]): number {
  let grossWin = 0;
  let grossLoss = 0;
  for (const t of trades) {
    if (t.pct >= 0) grossWin += t.pct;
    else            grossLoss += Math.abs(t.pct);
  }
  if (grossLoss === 0) return grossWin > 0 ? 99 : 0;  // sin pérdidas → PF "infinito" (cap 99)
  return grossWin / grossLoss;
}

/** Build the op calculator defaults — SL 0.75%, TP 3% (estrategia validada) */
export function calcOpLevels(
  entry:   number,
  dir:     "LONG" | "SHORT",
  // CAMBIO Fix #3 (Auditoría 20/05/26):
  // Defaults alineados a la config validada del backtest (HTF 1H + SL 0.75% + TP 3%).
  // Antes: SL 0.5% / TP 2.5% — incoherente con engine y backtest.
  slPct  = 0.0075, // 0.75%
  tpPct  = 0.03    // 3%
): { sl: number; tp: number; rr: number; riskPts: number; gainPts: number } {
  const sl    = dir === "LONG" ? entry * (1 - slPct) : entry * (1 + slPct);
  const tp    = dir === "LONG" ? entry * (1 + tpPct) : entry * (1 - tpPct);
  const riskPts = Math.abs(entry - sl);
  const gainPts = Math.abs(tp - entry);
  const rr    = riskPts > 0 ? gainPts / riskPts : 0;
  return { sl, tp, rr, riskPts, gainPts };
}

/** Lot size calculator for XAU (1 std lot = 100 oz) */
export function calcLotSize(
  capitalUSD:  number,
  riskPct:     number,     // e.g. 1 = 1%
  slPoints:    number      // $ distance to SL per oz
): number {
  if (slPoints <= 0) return 0;
  const dollarRisk = capitalUSD * (riskPct / 100);
  return dollarRisk / (slPoints * 100);
}
