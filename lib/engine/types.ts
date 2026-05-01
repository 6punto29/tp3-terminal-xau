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
  rsi6:    (number | null)[];
  rsi12:   (number | null)[];
  boll:    (BollingerBand | null)[];
}

export interface BollingerBand {
  u: number;  // upper band
  l: number;  // lower band
}

export type SignalDirection = "UP" | "DOWN" | "WAIT";

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
  htf:          string;   // "1h" | "4h"
  mtf:          string;   // "15m" | "1h"
  hold:         number;   // candles to hold max
  slPct:        number;   // e.g. 0.015
  tpPct:        number;   // e.g. 0.04
  sessionFilter:  boolean;
  ema200Filter:   boolean;
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
