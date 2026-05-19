// ─────────────────────────────────────────────────────────────────────────────
// lib/engine/types.ts
// Shared types for the entire TP3 system.
// ─────────────────────────────────────────────────────────────────────────────

export interface Candle {
  t: number;  // open time (ms timestamp)
  o: number;  // open
  h: number;  // high
  l: number;  // low
  c: number;  // close
  v: number;  // volume
}

// ── Fair Value Gap ────────────────────────────────────────────────────────────
// Desequilibrio institucional: precio se movió tan rápido que dejó
// órdenes sin emparejar. Se llena ~70% de las veces cuando el precio
// regresa a la zona. Es la señal de entrada de alta probabilidad.
export interface FVGZone {
  top:   number;  // límite superior de la zona
  bot:   number;  // límite inferior de la zona
  index: number;  // vela donde se formó
}

// ── Session Levels ────────────────────────────────────────────────────────────
// Niveles donde vive la liquidez real: máximo/mínimo del día anterior.
// Son los TP más precisos — las instituciones los usan como objetivos.
export interface SessionLevels {
  pdh: number | null;  // Previous Day High
  pdl: number | null;  // Previous Day Low
}

export interface PrecomputedIndicators {
  closes:  number[];
  ema12:   (number | null)[];
  ema26:   (number | null)[];
  ema50:   (number | null)[];
  ema200:  (number | null)[];
  rsi14:   (number | null)[];
  rsi9:    (number | null)[];
  boll:    (BollingerBand | null)[];
  atr:     (number | null)[];
  swingH:  (number | null)[];
  swingL:  (number | null)[];
  // Fair Value Gaps — desequilibrios institucionales activos en cada vela
  fvg:     { bull: FVGZone | null; bear: FVGZone | null }[];
}

export interface BollingerBand {
  u: number;
  l: number;
}

export type PriceStructure = "BULLISH" | "BEARISH" | "NEUTRAL";

export type SignalDirection = "UP" | "DOWN" | "WAIT";

export interface StructureLevels {
  structure:  PriceStructure;
  entryPrice: number;
  slPrice:    number;
  tpPrice:    number;
  atrValue:   number | null;
  slPct:      number;
  tpPct:      number;
  tpSource:   "session" | "structure" | "fallback"; // NEW — origen del TP
}

export interface RawSignal {
  sig:       SignalDirection;
  entry:     number;
  date:      string;
  htfFuture: Candle[];
  // Niveles estructurales pre-calculados — alinean backtest con engine en vivo
  slPrice:   number;
  tpPrice:   number;
  tpSource:  "session" | "structure" | "fallback";
}

export interface SimulatedTrade extends RawSignal {
  won:    boolean;
  pct:    number;
  hitTP:  boolean;
  hitSL:  boolean;
}

export interface BacktestSummary {
  total:  number;
  wins:   number;
  wr:     number;
  pnl:    number;
  avgW:   number;
  avgL:   number;
  rr?:    number;
  ev?:    number;
}

export interface BacktestConfig {
  htf:              string;
  mtf:              string;
  hold:             number;
  slPct:            number;
  tpPct:            number;
  sessionFilter:    boolean;
  ema200Filter:     boolean;
  structureFilter:  boolean;
  spread:           number;
}

export interface BacktestResult {
  config:   BacktestConfig;
  summary:  BacktestSummary;
  trades:   SimulatedTrade[];
  htfLen:   number;
  label:    string;
}

export interface AgentTool<TInput = unknown, TOutput = unknown> {
  name:        string;
  description: string;
  inputSchema: Record<string, unknown>;
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
