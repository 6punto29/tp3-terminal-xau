// ─────────────────────────────────────────────────────────────────────────────
// lib/engine/signals.ts
// Signal detection logic. Pure functions — no I/O, no state, no framework.
// ─────────────────────────────────────────────────────────────────────────────

import {
  Candle,
  PrecomputedIndicators,
  RawSignal,
  SignalDirection,
  PriceStructure,
  StructureLevels,
} from "./types";

interface HTFResult {
  sig:   SignalDirection;
  em200: number | null;
}

// ── Estructura de precio ───────────────────────────────────────────────────────

/**
 * Lee los últimos 2 swing highs y 2 swing lows antes del índice i
 * y determina si el precio forma estructura alcista (HH+HL) o bajista (LH+LL).
 * Sin lookahead — solo mira swings confirmados anteriores a i.
 */
export function getStructureAt(
  ind: PrecomputedIndicators,
  i:   number
): PriceStructure {
  const { swingH, swingL } = ind;
  const recentH: number[] = [];
  const recentL: number[] = [];

  // Recorre hacia atrás buscando los últimos 2 pivots confirmados
  for (let j = i - 1; j >= 0 && (recentH.length < 2 || recentL.length < 2); j--) {
    if (swingH[j] != null && recentH.length < 2) recentH.push(swingH[j]!);
    if (swingL[j] != null && recentL.length < 2) recentL.push(swingL[j]!);
  }

  if (recentH.length < 2 || recentL.length < 2) return "NEUTRAL";

  // recentH[0] = más reciente, recentH[1] = anterior
  const hh = recentH[0] > recentH[1];  // Higher High
  const hl = recentL[0] > recentL[1];  // Higher Low
  const lh = recentH[0] < recentH[1];  // Lower High
  const ll = recentL[0] < recentL[1];  // Lower Low

  if (hh && hl) return "BULLISH";
  if (lh && ll) return "BEARISH";
  return "NEUTRAL";
}

/**
 * Calcula los niveles exactos de entrada, SL y TP para MT5
 * basados en la estructura de precio (swing highs/lows).
 *
 * LONG:  SL debajo del último swing low · TP en el último swing high
 * SHORT: SL encima del último swing high · TP en el último swing low
 *
 * Buffer: 0.05% del precio para evitar SL en el nivel exacto del pivot.
 */
export function getStructureLevels(
  ind:       PrecomputedIndicators,
  i:         number,
  direction: "UP" | "DOWN",
  price:     number
): StructureLevels {
  const { swingH, swingL, atr } = ind;
  const structure = getStructureAt(ind, i);
  const atrValue  = atr[i];
  const buffer    = price * 0.0005; // 0.05% buffer sobre el pivot

  // Busca el último swing high y swing low confirmados
  let lastSwingH: number | null = null;
  let lastSwingL: number | null = null;
  for (let j = i - 1; j >= 0; j--) {
    if (lastSwingH === null && swingH[j] != null) lastSwingH = swingH[j]!;
    if (lastSwingL === null && swingL[j] != null) lastSwingL = swingL[j]!;
    if (lastSwingH !== null && lastSwingL !== null) break;
  }

  let slPrice: number;
  let tpPrice: number;

  if (direction === "UP") {
    // LONG: SL debajo del último swing low, TP en el último swing high
    slPrice = lastSwingL != null ? lastSwingL - buffer : price * (1 - 0.0075);
    tpPrice = lastSwingH != null ? lastSwingH + buffer : price * (1 + 0.03);
  } else {
    // SHORT: SL encima del último swing high, TP en el último swing low
    slPrice = lastSwingH != null ? lastSwingH + buffer : price * (1 + 0.0075);
    tpPrice = lastSwingL != null ? lastSwingL - buffer : price * (1 - 0.03);
  }

  const slPct = Math.abs(price - slPrice) / price * 100;
  const tpPct = Math.abs(tpPrice - price) / price * 100;

  return {
    structure,
    entryPrice: price,
    slPrice:    Math.round(slPrice * 100) / 100,
    tpPrice:    Math.round(tpPrice * 100) / 100,
    atrValue,
    slPct:      Math.round(slPct * 100) / 100,
    tpPct:      Math.round(tpPct * 100) / 100,
  };
}

// ── Señales HTF y MTF ─────────────────────────────────────────────────────────

/**
 * HTF signal — RSI14 con umbrales 25/75 (gold tiende a mantenerse en extremos).
 * +1 extra si la estructura de precio confirma la dirección.
 */
export function htfSignalAt(ind: PrecomputedIndicators, i: number): HTFResult {
  const { closes, rsi14, ema12, ema26, ema50, ema200, boll } = ind;
  const price = closes[i];
  const r     = rsi14[i];
  const b     = boll[i];
  const macd  = ema12[i] != null && ema26[i] != null ? ema12[i]! - ema26[i]! : null;
  const em200 = ema200[i];
  const em50  = ema50[i];

  let up = 0, dn = 0;

  // RSI + Bollinger
  if (r != null && b) {
    if      (r < 25 && price < b.l) up += 2;
    else if (r > 75 && price > b.u) dn += 2;
    else if (r < 30) up++;
    else if (r > 70) dn++;
  } else if (r != null) {
    r < 30 ? up++ : r > 70 ? dn++ : null;
  }

  // MACD
  if (macd != null) macd > 0 ? up++ : dn++;

  // EMAs
  if (em200 != null) price > em200 ? up++ : dn++;
  if (em50  != null) price > em50  ? up++ : dn++;

  // Estructura fractal — +1 si confirma dirección
  const structure = getStructureAt(ind, i);
  if (structure === "BULLISH") up++;
  if (structure === "BEARISH") dn++;

  const sig: SignalDirection =
    up > dn && up >= 2 ? "UP" : dn > up && dn >= 2 ? "DOWN" : "WAIT";
  return { sig, em200 };
}

/** MTF/LTF — RSI9 con umbrales 30/70 estándar */
export function mtfSignalAt(ind: PrecomputedIndicators, i: number): SignalDirection {
  const { closes, rsi9, ema50, boll } = ind;
  const price = closes[i];
  const r     = rsi9[i];
  const b     = boll[i];
  const em50  = ema50[i];

  let up = 0, dn = 0;
  if (r != null && b) {
    if      (r < 25 && price < b.l) up += 2;
    else if (r > 75 && price > b.u) dn += 2;
    else if (r < 30) up++;
    else if (r > 70) dn++;
  } else if (r != null) {
    r < 30 ? up++ : r > 70 ? dn++ : null;
  }
  if (em50 != null) price > em50 ? up++ : dn++;

  return up > dn && up >= 2 ? "UP" : dn > up && dn >= 2 ? "DOWN" : "WAIT";
}

// ── Backtest signal loop ───────────────────────────────────────────────────────

/**
 * Detecta señales históricas para el backtest.
 * Incluye: filtro de sesión, EMA200, estructura fractal y spread simulado.
 */
export function detectSignals(
  htfCandles: Candle[],
  mtfCandles: Candle[],
  htfInd:     PrecomputedIndicators,
  mtfInd:     PrecomputedIndicators,
  cfg: {
    holdCandles:      number;
    sessionFilter:    boolean;
    ema200Filter:     boolean;
    structureFilter:  boolean;  // NUEVO — exige estructura alineada
    spread:           number;   // NUEVO — spread en $ (ej: 0.35)
  }
): RawSignal[] {
  const { holdCandles, sessionFilter, ema200Filter, structureFilter, spread } = cfg;

  // Alineación HTF→MTF en O(N+M)
  const mtfMap = new Map<number, number>();
  let mj = 0;
  for (let i = 0; i < htfCandles.length; i++) {
    const t = htfCandles[i].t;
    while (mj < mtfCandles.length - 1 && mtfCandles[mj].t < t) mj++;
    mtfMap.set(i, mj);
  }

  const signals: RawSignal[] = [];

  for (let i = 50; i < htfCandles.length - holdCandles; i++) {

    // Filtro de sesión: LDN (UTC 08:00–10:00) y NY (UTC 14:30–16:30)
    if (sessionFilter) {
      const d      = new Date(htfCandles[i].t);
      const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes();
      const inLDN  = utcMin >= 480 && utcMin < 600;
      const inNY   = utcMin >= 870 && utcMin < 990;
      if (!inLDN && !inNY) continue;
    }

    const { sig: hSig, em200 } = htfSignalAt(htfInd, i);
    if (hSig === "WAIT") continue;

    // Filtro EMA200
    if (ema200Filter && em200 != null) {
      if (hSig === "UP"   && htfInd.closes[i] < em200) continue;
      if (hSig === "DOWN" && htfInd.closes[i] > em200) continue;
    }

    // Filtro de estructura fractal
    if (structureFilter) {
      const structure = getStructureAt(htfInd, i);
      if (hSig === "UP"   && structure !== "BULLISH") continue;
      if (hSig === "DOWN" && structure !== "BEARISH") continue;
    }

    const mtfIdx = mtfMap.get(i) ?? -1;
    if (mtfIdx < 30) continue;

    const mSig = mtfSignalAt(mtfInd, mtfIdx);
    if (hSig !== mSig) continue;

    // Precio de entrada + spread simulado
    const rawEntry = i + 1 < htfCandles.length
      ? htfCandles[i + 1].o
      : htfCandles[i].c;
    const entryP = hSig === "UP"
      ? rawEntry + spread   // comprando: pagas el spread
      : rawEntry - spread;  // vendiendo: también pagas el spread

    signals.push({
      sig:       hSig,
      entry:     entryP,
      htfFuture: htfCandles.slice(
        i + 1,
        Math.min(i + 1 + holdCandles + 2, htfCandles.length)
      ),
      date: new Date(htfCandles[i].t).toLocaleDateString("es-CO", {
        month: "2-digit",
        day:   "2-digit",
      }),
    });
  }

  return signals;
}

// ── Live verdict ───────────────────────────────────────────────────────────────

export interface LiveVerdict {
  htf:        SignalDirection;
  mtf:        SignalDirection;
  verdict:    "ENTRAR LONG" | "ENTRAR SHORT" | "ESPERAR";
  strength:   "FUERTE" | "MODERADO" | "DÉBIL";
  ema200:     number | null;
  rsi:        number | null;
  structure:  PriceStructure;        // NUEVO
  levels:     StructureLevels | null; // NUEVO — niveles MT5 (null si ESPERAR)
}

export function getLiveVerdict(
  htfInd:    PrecomputedIndicators,
  mtfInd:    PrecomputedIndicators,
  htfIdx:    number,
  mtfIdx:    number,
  livePrice: number = 0              // NUEVO — precio live para calcular niveles
): LiveVerdict {
  const { sig: hSig, em200 } = htfSignalAt(htfInd, htfIdx);
  const mSig     = mtfSignalAt(mtfInd, mtfIdx);
  const rsi      = htfInd.rsi14[htfIdx];
  const structure = getStructureAt(htfInd, htfIdx);

  let verdict:  LiveVerdict["verdict"]  = "ESPERAR";
  let strength: LiveVerdict["strength"] = "DÉBIL";

  if (hSig === "UP"   && mSig === "UP")   { verdict = "ENTRAR LONG";  strength = "FUERTE";   }
  if (hSig === "DOWN" && mSig === "DOWN") { verdict = "ENTRAR SHORT"; strength = "FUERTE";   }
  if (hSig === "UP"   && mSig === "WAIT") { verdict = "ENTRAR LONG";  strength = "MODERADO"; }
  if (hSig === "DOWN" && mSig === "WAIT") { verdict = "ENTRAR SHORT"; strength = "MODERADO"; }

  // Niveles MT5 solo si hay señal y tenemos precio live
  const levels: StructureLevels | null =
    verdict !== "ESPERAR" && livePrice > 0
      ? getStructureLevels(htfInd, htfIdx, hSig as "UP" | "DOWN", livePrice)
      : null;

  return { htf: hSig, mtf: mSig, verdict, strength, ema200: em200, rsi, structure, levels };
}
