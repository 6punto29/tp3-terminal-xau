// ─────────────────────────────────────────────────────────────────────────────
// lib/engine/types.ts
// Shared types for the entire TP3 system.
// Import these in UI, API routes, and AI agent tools alike.
// ─────────────────────────────────────────────────────────────────────────────

export interface Candle {
  t: number;  // open time (ms timestamp)
  o: number;  // open
  h: number;  // high
  l: number;  // low
  c: number;  // close
  v: number;  // volume
}

export interface PrecomputedIndicators {
  closes:  number[];
  ema12:   (number | null)[];
  ema26:   (number | null)[];
  ema50:   (number | null)[];
  ema200:  (number | null)[];
  rsi14:   (number | null)[];          // HTF + MTF — período 14, estándar gold
  rsi9:    (number | null)[];          // LTF (15M/5M) — período 9, más reactivo
  boll:    (BollingerBand | null)[];
  atr:     (number | null)[];          // ATR 14 — volatilidad real por vela
  swingH:  (number | null)[];          // Swing high confirmado (pivot 3 barras)
  swingL:  (number | null)[];          // Swing low confirmado (pivot 3 barras)
}

export interface BollingerBand {
  u: number;  // upper band
  l: number;  // lower band
}

// Estructura de precio — HH/HL = alcista, LH/LL = bajista
export type PriceStructure = "BULLISH" | "BEARISH" | "NEUTRAL";

export type SignalDirection = "UP" | "DOWN" | "WAIT";

// Niveles exactos para MT5 calculados desde estructura de precio
export interface StructureLevels {
  structure:  PriceStructure;
  entryPrice: number;          // Precio de entrada sugerido (market = precio live)
  slPrice:    number;          // Stop Loss exacto en $ (desde último swing)
  tpPrice:    number;          // Take Profit exacto en $ (hacia siguiente swing)
  atrValue:   number | null;   // ATR actual — cuánto mueve el gold por vela
  slPct:      number;          // SL en % respecto al entry (referencia)
  tpPct:      number;          // TP en % respecto al entry (referencia)
}

export interface RawSignal {
  sig:       SignalDirection;
  entry:     number;
  date:      string;          // "DD/MM" formatted
  htfFuture: Candle[];        // forward candles for SL/TP simulation
}

export interface SimulatedTrade extends RawSignal {
  won:    boolean;
  pct:    number;    // % P&L
  hitTP:  boolean;
  hitSL:  boolean;
}

export interface BacktestSummary {
  total:  number;
  wins:   number;
  wr:     number;    // 0-100 integer
  pnl:    number;    // cumulative %
  avgW:   number;    // avg winner %
  avgL:   number;    // avg loser % (negative)
  rr?:    number;    // TP/SL ratio
  ev?:    number;    // expected value in R
}

export interface BacktestConfig {
  htf:              string;   // "1h" | "4h"
  mtf:              string;   // "15m" | "1h"
  hold:             number;   // candles to hold max
  slPct:            number;   // e.g. 0.015
  tpPct:            number;   // e.g. 0.04
  sessionFilter:    boolean;
  ema200Filter:     boolean;
  structureFilter:  boolean;  // NUEVO — exige HH/HL o LH/LL alineado con señal
  spread:           number;   // NUEVO — spread simulado en $ (ej: 0.35)
}

export interface BacktestResult {
  config:   BacktestConfig;
  summary:  BacktestSummary;
  trades:   SimulatedTrade[];
  htfLen:   number;        // total candles loaded
  label:    string;
}

// ── AI Agent types (ready for future connection) ──────────────────────────────

export interface AgentTool<TInput = unknown, TOutput = unknown> {
  name:        string;
  description: string;
  inputSchema: Record<string, unknown>;   // Zod or JSON Schema
  run:         (input: TInput) => Promise<TOutput>;
}

export interface MarketSnapshot {
  timestamp:  number;
  symbol:     string;
  price:      number;
  htfSignal:  SignalDirection;
  mtfSignal:  SignalDirection;
  session:    "LDN" | "NY" | "CLOSED";
  checklist:  Record<string, boolean>;
  lastBacktest?: BacktestResult;
}
