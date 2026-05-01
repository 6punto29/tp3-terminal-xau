// ─────────────────────────────────────────────────────────────────────────────
// lib/engine/simulator.ts
// SL/TP simulation and result aggregation.
// Pure functions — no I/O, no framework, fully testable.
// ─────────────────────────────────────────────────────────────────────────────

import { RawSignal, SimulatedTrade, BacktestSummary } from "./types";

/** Simulate each signal against SL/TP levels — port of original lines 2003-2035 */
export function simulateSignals(
  signals:      RawSignal[],
  slPct:        number,
  tpPct:        number,
  holdCandles:  number
): SimulatedTrade[] {
  return signals.map((s) => {
    const slP = s.sig === "UP" ? s.entry * (1 - slPct) : s.entry * (1 + slPct);
    const tpP = s.sig === "UP" ? s.entry * (1 + tpPct) : s.entry * (1 - tpPct);

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
  return { total: trades.length, wins: wins.length, wr, pnl, avgW, avgL };
}

/**
 * Expected Value in R-multiples.
 * EV = WR × R:R − (1 − WR) × 1
 * Positive EV = edge exists over large sample.
 */
export function calcEV(wr: number, rr: number): number {
  return (wr / 100) * rr - (1 - wr / 100) * 1;
}

/** Build the op calculator defaults — SL 1.5%, TP 4.0% from entry */
export function calcOpLevels(
  entry:   number,
  dir:     "LONG" | "SHORT",
  slPct  = 0.015,
  tpPct  = 0.04
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
