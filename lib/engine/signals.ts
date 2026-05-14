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
  SessionLevels,
} from "./types";

interface HTFResult {
  sig:   SignalDirection;
  em200: number | null;
}

// ── Estructura de precio ───────────────────────────────────────────────────────

export function getStructureAt(
  ind: PrecomputedIndicators,
  i:   number
): PriceStructure {
  const { swingH, swingL } = ind;
  const recentH: number[] = [];
  const recentL: number[] = [];

  for (let j = i - 1; j >= 0 && (recentH.length < 2 || recentL.length < 2); j--) {
    if (swingH[j] != null && recentH.length < 2) recentH.push(swingH[j]!);
    if (swingL[j] != null && recentL.length < 2) recentL.push(swingL[j]!);
  }

  if (recentH.length < 2 || recentL.length < 2) return "NEUTRAL";

  const hh = recentH[0] > recentH[1];
  const hl = recentL[0] > recentL[1];
  const lh = recentH[0] < recentH[1];
  const ll = recentL[0] < recentL[1];

  if (hh && hl) return "BULLISH";
  if (lh && ll) return "BEARISH";
  return "NEUTRAL";
}

/**
 * Calcula SL/TP exactos para MT5.
 *
 * TP prioridad:
 * 1. Previous Day High/Low (PDH/PDL) — liquidez institucional real
 * 2. Último swing en el lado correcto del precio
 * 3. Fallback porcentual
 *
 * SL: siempre desde estructura — swing en el lado opuesto al precio.
 */
export function getStructureLevels(
  ind:       PrecomputedIndicators,
  i:         number,
  direction: "UP" | "DOWN",
  price:     number,
  session:   SessionLevels = { pdh: null, pdl: null },
  maxSlPct:  number = 0.75,  // tope máximo de SL en % (del selector)
  minTpPct:  number = 2.5    // TP mínimo en % si la estructura no alcanza el R:R
): StructureLevels {
  const { swingH, swingL, atr } = ind;
  const structure = getStructureAt(ind, i);
  const atrValue  = atr[i];
  const buffer    = price * 0.0005;
  const slCap     = price * (maxSlPct / 100); // distancia máxima permitida en $

  let slPrice:  number;
  let tpPrice:  number;
  let tpSource: StructureLevels["tpSource"] = "fallback";

  if (direction === "UP") {
    // SL: último swing low POR DEBAJO del precio — capado en maxSlPct
    let swingLowBelow: number | null = null;
    for (let j = i - 1; j >= 0; j--) {
      if (swingL[j] != null && swingL[j]! < price) { swingLowBelow = swingL[j]!; break; }
    }
    const structuralSL = swingLowBelow != null ? swingLowBelow - buffer : price * (1 - maxSlPct / 100);
    // Si el swing está demasiado lejos, usar el % configurado
    slPrice = (price - structuralSL) > slCap ? price * (1 - maxSlPct / 100) : structuralSL;

    // TP: PDH si está por encima del precio → liquidez institucional real
    if (session.pdh != null && session.pdh > price) {
      tpPrice  = session.pdh - buffer;
      tpSource = "session";
    } else {
      // Fallback: último swing high por encima del precio
      let swingHighAbove: number | null = null;
      for (let j = i - 1; j >= 0; j--) {
        if (swingH[j] != null && swingH[j]! > price) { swingHighAbove = swingH[j]!; break; }
      }
      if (swingHighAbove != null) {
        tpPrice  = swingHighAbove + buffer;
        tpSource = "structure";
      } else {
        tpPrice  = price * (1 + minTpPct / 100);
        tpSource = "fallback";
      }
    }
    // Si el TP estructural/session no alcanza el R:R mínimo → usar % configurado
    const slDist = price - slPrice;
    const tpDist = tpPrice - price;
    if (tpDist < slDist * 1.5) {
      // Aquí minTpPct/maxSlPct se usa como ratio R:R (ej: 2.5/0.75 = 3.33:1)
      tpPrice  = price + slDist * (minTpPct / maxSlPct);
      tpSource = "fallback";
    }
  } else {
    // SL: último swing high POR ENCIMA del precio — capado en maxSlPct
    let swingHighAbove: number | null = null;
    for (let j = i - 1; j >= 0; j--) {
      if (swingH[j] != null && swingH[j]! > price) { swingHighAbove = swingH[j]!; break; }
    }
    const structuralSLShort = swingHighAbove != null ? swingHighAbove + buffer : price * (1 + maxSlPct / 100);
    slPrice = (structuralSLShort - price) > slCap ? price * (1 + maxSlPct / 100) : structuralSLShort;

    // TP: PDL si está por debajo del precio
    if (session.pdl != null && session.pdl < price) {
      tpPrice  = session.pdl + buffer;
      tpSource = "session";
    } else {
      let swingLowBelow: number | null = null;
      for (let j = i - 1; j >= 0; j--) {
        if (swingL[j] != null && swingL[j]! < price) { swingLowBelow = swingL[j]!; break; }
      }
      if (swingLowBelow != null) {
        tpPrice  = swingLowBelow - buffer;
        tpSource = "structure";
      } else {
        tpPrice  = price * (1 - minTpPct / 100);
        tpSource = "fallback";
      }
    }
    // Si el TP estructural/session no alcanza el R:R mínimo → usar % configurado
    const slDistShort = slPrice - price;
    const tpDistShort = price - tpPrice;
    if (tpDistShort < slDistShort * 1.5) {
      tpPrice  = price - slDistShort * (minTpPct / maxSlPct);
      tpSource = "fallback";
    }
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
    tpSource,
  };
}

// ── FVG helpers ───────────────────────────────────────────────────────────────

/**
 * ¿Está el precio dentro o tocando una FVG activa que confirma la dirección?
 * - LONG en FVG alcista: precio entre bot y top de la zona
 * - SHORT en FVG bajista: precio entre bot y top de la zona
 * Tolerancia: 0.15% para detectar precio "aproximándose" a la zona.
 */
function isInFVG(ind: PrecomputedIndicators, i: number, direction: "UP" | "DOWN", price: number): boolean {
  const { fvg } = ind;
  const zone = direction === "UP" ? fvg[i]?.bull : fvg[i]?.bear;
  if (!zone) return false;
  const tolerance = price * 0.0015;
  return price >= zone.bot - tolerance && price <= zone.top + tolerance;
}

// ── HTF signal ────────────────────────────────────────────────────────────────

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

  // Estructura fractal +1
  const structure = getStructureAt(ind, i);
  if (structure === "BULLISH") up++;
  if (structure === "BEARISH") dn++;

  // FVG +1 — precio en zona de desequilibrio institucional
  if (isInFVG(ind, i, "UP", price))   up++;
  if (isInFVG(ind, i, "DOWN", price)) dn++;

  // NOTA: señales mixtas (up≈dn) pueden ser frágiles — considerar filtro de diferencia mínima
  const sig: SignalDirection =
    up > dn && up >= 2 ? "UP" : dn > up && dn >= 2 ? "DOWN" : "WAIT";
  return { sig, em200 };
}

// ── MTF/LTF signal ────────────────────────────────────────────────────────────

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

export function detectSignals(
  htfCandles: Candle[],
  mtfCandles: Candle[],
  htfInd:     PrecomputedIndicators,
  mtfInd:     PrecomputedIndicators,
  cfg: {
    holdCandles:      number;
    sessionFilter:    boolean;
    ema200Filter:     boolean;
    structureFilter:  boolean;
    spread:           number;
  }
): RawSignal[] {
  const { holdCandles, sessionFilter, ema200Filter, structureFilter, spread } = cfg;

  const mtfMap = new Map<number, number>();
  let mj = 0;
  for (let i = 0; i < htfCandles.length; i++) {
    const t = htfCandles[i].t;
    while (mj < mtfCandles.length - 1 && mtfCandles[mj].t < t) mj++;
    mtfMap.set(i, mj);
  }

  const signals: RawSignal[] = [];

  for (let i = 50; i < htfCandles.length - holdCandles; i++) {
    if (sessionFilter) {
      const d      = new Date(htfCandles[i].t);
      const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes();
      // LDN: 07:00-12:00 UTC · NY: 13:00-18:00 UTC (incluye overlap y datos macro)
      const inLDN  = utcMin >= 420 && utcMin < 720;
      const inNY   = utcMin >= 780 && utcMin < 1080;
      if (!inLDN && !inNY) continue;
    }

    const { sig: hSig, em200 } = htfSignalAt(htfInd, i);
    if (hSig === "WAIT") continue;

    if (ema200Filter && em200 != null) {
      if (hSig === "UP"   && htfInd.closes[i] < em200) continue;
      if (hSig === "DOWN" && htfInd.closes[i] > em200) continue;
    }

    if (structureFilter) {
      const structure = getStructureAt(htfInd, i);
      if (hSig === "UP"   && structure !== "BULLISH") continue;
      if (hSig === "DOWN" && structure !== "BEARISH") continue;
    }

    const mtfIdx = mtfMap.get(i) ?? -1;
    if (mtfIdx < 30) continue;

    const mSig = mtfSignalAt(mtfInd, mtfIdx);
    if (hSig !== mSig) continue;

    const rawEntry = i + 1 < htfCandles.length ? htfCandles[i + 1].o : htfCandles[i].c;
    const entryP   = hSig === "UP" ? rawEntry + spread : rawEntry - spread;

    signals.push({
      sig:       hSig,
      entry:     entryP,
      htfFuture: htfCandles.slice(i + 1, Math.min(i + 1 + holdCandles + 2, htfCandles.length)),
      date:      new Date(htfCandles[i].t).toLocaleDateString("es-CO", {
        month: "2-digit", day: "2-digit",
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
  structure:  PriceStructure;
  levels:     StructureLevels | null;
  fvgActive:  boolean;            // precio está en zona FVG activa
  d1Blocked:  boolean;            // señal bloqueada por D1 contrario
}

export function getLiveVerdict(
  htfInd:    PrecomputedIndicators,
  mtfInd:    PrecomputedIndicators,
  htfIdx:    number,
  mtfIdx:    number,
  livePrice: number = 0,
  d1Bias:    SignalDirection = "WAIT",
  session:   SessionLevels = { pdh: null, pdl: null },
  maxSlPct:  number = 0.75,
  minTpPct:  number = 2.5
): LiveVerdict {
  const { sig: hSig, em200 } = htfSignalAt(htfInd, htfIdx);
  const mSig      = mtfSignalAt(mtfInd, mtfIdx);
  const rsi       = htfInd.rsi14[htfIdx];
  const structure = getStructureAt(htfInd, htfIdx);
  const fvgActive = livePrice > 0 && (
    isInFVG(htfInd, htfIdx, "UP", livePrice) ||
    isInFVG(htfInd, htfIdx, "DOWN", livePrice)
  );

  let verdict:   LiveVerdict["verdict"]  = "ESPERAR";
  let strength:  LiveVerdict["strength"] = "DÉBIL";
  let d1Blocked  = false;

  if (hSig === "UP"   && mSig === "UP")   { verdict = "ENTRAR LONG";  strength = "FUERTE";   }
  else if (hSig === "DOWN" && mSig === "DOWN") { verdict = "ENTRAR SHORT"; strength = "FUERTE";   }
  else if (hSig === "UP"   && mSig === "WAIT") { verdict = "ENTRAR LONG";  strength = "MODERADO"; }
  else if (hSig === "DOWN" && mSig === "WAIT") { verdict = "ENTRAR SHORT"; strength = "MODERADO"; }

  // ── D1 Hard Filter ──
  // Si el D1 tiene sesgo claro y la señal va en contra, la bloqueamos.
  // En gold 2026 con macro alcista, operar SHORT contra D1 alcista = error.
  if (d1Bias === "UP"   && verdict === "ENTRAR SHORT") { verdict = "ESPERAR"; d1Blocked = true; }
  if (d1Bias === "DOWN" && verdict === "ENTRAR LONG")  { verdict = "ESPERAR"; d1Blocked = true; }

  const levels: StructureLevels | null =
    verdict !== "ESPERAR" && livePrice > 0
      ? getStructureLevels(htfInd, htfIdx, hSig as "UP" | "DOWN", livePrice, session, maxSlPct, minTpPct)
      : null;

  return {
    htf: hSig, mtf: mSig, verdict, strength,
    ema200: em200, rsi,
    structure, levels, fvgActive, d1Blocked,
  };
}
