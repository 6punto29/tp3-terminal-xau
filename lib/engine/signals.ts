// ─────────────────────────────────────────────────────────────────────────────
// lib/engine/signals.ts
// Signal detection logic. Pure functions — no I/O, no state, no framework.
//
// Cambios v4:
// · Fix #4 — mapeo MTF realineado en detectSignals. Antes mapeaba HTF[i] a la
//   primera MTF con open >= HTF[i].open, lo que dejaba MTF stale 45min (HTF 1H)
//   o 3h (HTF 4H). Ahora mapea HTF[i] a la última MTF ya cerrada al momento
//   en que entraríamos (open de HTF[i+1]) — coincide con lo que se ve en live.
//
// Cambios v3:
// · Bug 3.2 — filtro diferencia mínima 2 puntos en htfSignalAt/mtfSignalAt
//   evita señales mixtas frágiles (ej: up=3, dn=2 ya no emite UP)
// · Bug 4.4 — renombre de params para claridad:
//     maxSlPct  → slCapPct    (tope de SL en %)
//     minTpPct  → tpTargetPct (objetivo de TP en %, doble uso documentado)
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
import { precompute } from "./indicators";

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
 *
 * Parámetros:
 * - slCapPct:    tope máximo de SL en % desde entry. Si la estructura
 *                exige un SL más amplio, se recorta a este valor.
 *
 * - tpTargetPct: objetivo de TP en %. Tiene DOBLE USO:
 *     a) Cuando no hay estructura ni PDH/PDL útiles, TP = entry × (1 ± tpTargetPct/100).
 *     b) Cuando la estructura encuentra un TP pero el R:R < 1.5, se recalcula
 *        TP = entry ± slDist × (tpTargetPct / slCapPct).
 *        En ese caso (tpTargetPct / slCapPct) actúa como ratio R:R forzado
 *        (ej: 2.5 / 0.75 = 3.33:1 → TP a 3.33× la distancia SL real).
 *     El nombre "Target" refleja que es un porcentaje objetivo, no un mínimo absoluto.
 */
export function getStructureLevels(
  ind:         PrecomputedIndicators,
  i:           number,
  direction:   "UP" | "DOWN",
  price:       number,
  session:     SessionLevels = { pdh: null, pdl: null },
  slCapPct:    number = 0.75,
  // CAMBIO Fix #3 (Auditoría 20/05/26): default 3 (antes 2.5).
  // Alinea con detectSignals (3) y con la config validada del backtest
  // (HTF 1H + SL 0.75% + TP 3% + Hold 6 + minRatio 0.5).
  tpTargetPct: number = 3,
  // CAMBIO v6 (Fase A — validado por backtest 19/05/26):
  // Default 0.5 (antes 1.5). Acepta TPs estructurales más cercanos.
  // Backtest comparativo 12 configs: 0.5×/ATR OFF = +2.60R · WR 72% · 39 señales
  // vs default anterior 1.5×/ATR OFF = +2.35R · WR 67% · 39 señales (+10.6% EV)
  minRatio:    number = 0.5
): StructureLevels {
  const { swingH, swingL, atr } = ind;
  const structure = getStructureAt(ind, i);
  const atrValue  = atr[i];
  const buffer    = price * 0.0005;
  const slCap     = price * (slCapPct / 100); // distancia máxima permitida en $

  let slPrice:  number;
  let tpPrice:  number;
  let tpSource: StructureLevels["tpSource"] = "fallback";

  if (direction === "UP") {
    // SL: último swing low POR DEBAJO del precio — capado en slCapPct
    let swingLowBelow: number | null = null;
    for (let j = i - 1; j >= 0; j--) {
      if (swingL[j] != null && swingL[j]! < price) { swingLowBelow = swingL[j]!; break; }
    }
    const structuralSL = swingLowBelow != null ? swingLowBelow - buffer : price * (1 - slCapPct / 100);
    // Si el swing está demasiado lejos, usar el % configurado
    slPrice = (price - structuralSL) > slCap ? price * (1 - slCapPct / 100) : structuralSL;

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
        tpPrice  = price * (1 + tpTargetPct / 100);
        tpSource = "fallback";
      }
    }
    // Si el TP estructural/session no alcanza el R:R mínimo → forzar ratio (tpTargetPct/slCapPct):1
    const slDist = price - slPrice;
    const tpDist = tpPrice - price;
    if (tpDist < slDist * minRatio) {
      tpPrice  = price + slDist * (tpTargetPct / slCapPct);
      tpSource = "fallback";
    }
  } else {
    // SL: último swing high POR ENCIMA del precio — capado en slCapPct
    let swingHighAbove: number | null = null;
    for (let j = i - 1; j >= 0; j--) {
      if (swingH[j] != null && swingH[j]! > price) { swingHighAbove = swingH[j]!; break; }
    }
    const structuralSLShort = swingHighAbove != null ? swingHighAbove + buffer : price * (1 + slCapPct / 100);
    slPrice = (structuralSLShort - price) > slCap ? price * (1 + slCapPct / 100) : structuralSLShort;

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
        tpPrice  = price * (1 - tpTargetPct / 100);
        tpSource = "fallback";
      }
    }
    // Si el TP estructural/session no alcanza el R:R mínimo → forzar ratio (tpTargetPct/slCapPct):1
    const slDistShort = slPrice - price;
    const tpDistShort = price - tpPrice;
    if (tpDistShort < slDistShort * minRatio) {
      tpPrice  = price - slDistShort * (tpTargetPct / slCapPct);
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
  // ── CAPA 1 — DIRECCIÓN PURA (25/05/26) ──────────────────────────────────────
  // Reescrito según el sistema Triple Screen de Alexander Elder: la Capa 1
  // (dirección) usa SOLO indicadores de tendencia. RSI y Bollinger son
  // osciladores de REVERSIÓN — no detectan dirección, y en tendencias fuertes
  // votan en contra de la tendencia real (RSI sobrecompra en una subida sana).
  // Estaban metidos acá con peso +2, capaces de anular la tendencia y forzar
  // un WAIT falso. Se RETIRAN de la Capa 1.
  //   · El RSI NO se pierde: ya trabaja en calcSignalScore (Capa 3 = timing).
  //   · La Capa 1 queda con 4 votos de TENDENCIA, peso parejo +1:
  //     MACD (cruce de EMAs), EMA200, EMA50, estructura HH/HL.
  //   · FVG se mantiene como estaba — un solo cambio a la vez (se evalúa aparte).
  //   · Umbral ≥2 sin cambios — sigue exigiendo mayoría clara de tendencia.
  // Pendiente de validación: backtest Capa 1 actual vs limpia, lado a lado.
  const { closes, ema12, ema26, ema50, ema200 } = ind;
  const price = closes[i];
  const macd  = ema12[i] != null && ema26[i] != null ? ema12[i]! - ema26[i]! : null;
  const em200 = ema200[i];
  const em50  = ema50[i];

  let up = 0, dn = 0;

  // MACD — cruce de EMAs, lectura de tendencia
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

  // REVERSIÓN (21/05/26): diferencia mínima de vuelta a 2 (valor validado original).
  // El experimento de bajarla a 1 generó MÁS ruido → HTF y MTF dejaron de
  // coincidir → MENOS señales ENTRAR (el sistema requiere HTF==MTF).
  // 2 = umbral validado por auditoría 16/05 ("Bug 3.2 v3, correcto").
  const sig: SignalDirection =
    up - dn >= 2 ? "UP" : dn - up >= 2 ? "DOWN" : "WAIT";
  return { sig, em200 };
}

// ── MTF/LTF signal ────────────────────────────────────────────────────────────

export function mtfSignalAt(ind: PrecomputedIndicators, i: number): SignalDirection {
  // ── CAPA 1 — DIRECCIÓN PURA · reloj chico (25/05/26) ────────────────────────
  // Limpieza Elder COMPLETADA en el MTF. Antes esta función decidía la dirección
  // con RSI9 + Bollinger — osciladores de REVERSIÓN, con peso de hasta +2. Era el
  // mismo error que ya se corrigió en htfSignalAt: en una tendencia fuerte esos
  // osciladores votan CONTRA la tendencia real y desalinean HTF/MTF (el RSI alto
  // de una subida sana metía dn += 2 y tumbaba la señal a WAIT).
  //   · Ahora usa la MISMA lógica de tendencia que htfSignalAt: MACD, EMA200,
  //     EMA50, estructura HH/HL, FVG — votos de tendencia, peso parejo +1.
  //   · RSI y Bollinger SALEN de la detección de dirección. El RSI no se pierde:
  //     sigue trabajando en calcSignalScore (Capa 3 = timing).
  //   · Umbral ≥2 sin cambios — misma exigencia de mayoría clara de tendencia.
  //   · Los dos relojes (HTF y MTF) quedan hablando el mismo idioma.
  const { closes, ema12, ema26, ema50, ema200 } = ind;
  const price = closes[i];
  const macd  = ema12[i] != null && ema26[i] != null ? ema12[i]! - ema26[i]! : null;
  const em200 = ema200[i];
  const em50  = ema50[i];

  let up = 0, dn = 0;

  // MACD — cruce de EMAs, lectura de tendencia
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

  // Umbral ≥2 — idéntico a htfSignalAt.
  return up - dn >= 2 ? "UP" : dn - up >= 2 ? "DOWN" : "WAIT";
}

// ── Sesiones operativas DST-aware ─────────────────────────────────────────────
//
// Calcula la hora local (en minutos desde medianoche) de un timestamp en una
// timezone IANA específica. Resuelve DST automáticamente vía Intl.DateTimeFormat.
//
// Ejemplo: ts = 2025-07-15 12:30 UTC, tz = "Europe/London"
//   → BST activo (UTC+1) → retorna 13*60 + 30 = 810 (13:30 hora Londres)
function getLocalMinutes(ts: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false, hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(ts));
  const h = parseInt(parts.find((p) => p.type === "hour")!.value);
  const m = parseInt(parts.find((p) => p.type === "minute")!.value);
  // "24" puede aparecer en algunas localizaciones para medianoche
  return (h === 24 ? 0 : h) * 60 + m;
}

// Ventana operativa: 08:00-13:00 hora local de cada ciudad (5h).
// Idéntica a LiveTerminal.getSession() — mantiene backtest == live.
const SESSION_OPEN_MIN  = 8 * 60;   // 08:00
const SESSION_CLOSE_MIN = 13 * 60;  // 13:00

export function isInOperativeSession(ts: number): boolean {
  const ldn = getLocalMinutes(ts, "Europe/London");
  const ny  = getLocalMinutes(ts, "America/New_York");
  const inLDN = ldn >= SESSION_OPEN_MIN && ldn < SESSION_CLOSE_MIN;
  const inNY  = ny  >= SESSION_OPEN_MIN && ny  < SESSION_CLOSE_MIN;
  return inLDN || inNY;
}

// Devuelve la sesión activa para un timestamp dado (idéntica al live).
// Útil para alimentar calcSignalScore desde el backtest.
export type SessionTag = "LDN" | "NY" | "CLOSED";
export function getSessionAt(ts: number): SessionTag {
  const ldn = getLocalMinutes(ts, "Europe/London");
  const ny  = getLocalMinutes(ts, "America/New_York");
  if (ldn >= SESSION_OPEN_MIN && ldn < SESSION_CLOSE_MIN) return "LDN";
  if (ny  >= SESSION_OPEN_MIN && ny  < SESSION_CLOSE_MIN) return "NY";
  return "CLOSED";
}

// ── Score de convicción 1-10 ──────────────────────────────────────────────────
//
// CAMBIO Fix #2 (Auditoría 20/05/26): movido desde LiveTerminal al engine.
// Antes vivía solo en el frontend → el backtest no aplicaba el filtro de score
// y aceptaba señales que en live serían rechazadas. Esta es la fuente única
// de verdad: live y backtest usan la misma función.
//
// Score máximo posible:
//   +2 HTF != WAIT
//   +2 HTF == MTF
//   +1 HTF == M15
//   +1 HTF == LTF
//   +2 EMA200 alineada (con buffer 0.2%)
//   +1 RSI en zona neutra (30-70)
//   +1 estructura alineada
//   +1 FVG activa
//   -2 4H en contra del trade
//
// Cap inferior 0, superior 10.
//
// CAMBIO (27/05/26): se quitó el +1 por sesión LDN/NY. El score ahora es
// PURO — solo calidad del setup. La hora se aplica aparte, como ajuste de
// liquidez (ver getLiquidityLevel / liquidityAdjustment). El parámetro
// session se conserva solo para el corte de WEEKEND.
export function calcSignalScore(
  htf: SignalDirection,
  mtf: SignalDirection,
  m15: SignalDirection,
  ltf: SignalDirection,
  rsi: number | null,
  ema200: number | null,
  price: number,
  session: "LDN" | "NY" | "CLOSED" | "WEEKEND",
  structure: PriceStructure,
  fvgActive: boolean,
  h4Bias: SignalDirection = "WAIT"
): number {
  if (session === "WEEKEND") return 0;
  let s = 0;
  if (htf !== "WAIT") s += 2;
  if (htf !== "WAIT" && mtf === htf) s += 2;
  if (htf !== "WAIT" && m15 === htf) s += 1;
  if (htf !== "WAIT" && ltf === htf) s += 1;
  // EMA200 con buffer 0.2% — evita falsos positivos cuando precio == EMA200
  if (ema200 != null && price > 0 && Math.abs(price - ema200) / ema200 > 0.002) {
    if ((htf === "UP" && price > ema200) || (htf === "DOWN" && price < ema200)) s += 2;
  }
  if (rsi != null && rsi >= 30 && rsi <= 70) s += 1;
  if ((htf === "UP" && structure === "BULLISH") || (htf === "DOWN" && structure === "BEARISH")) s += 1;
  if (fvgActive) s += 1;
  // CAMBIO (27/05/26): el +1 por sesión LDN/NY se quitó del score.
  // La hora ya no entra en el score puro — se maneja como ajuste de
  // liquidez fuera de esta función (ver getLiquidityLevel / liquidityAdjustment).
  // 4H restrictivo — penaliza señales contra tendencia 4H
  if (htf === "UP"   && h4Bias === "DOWN") s -= 2;
  if (htf === "DOWN" && h4Bias === "UP")   s -= 2;
  return Math.max(0, Math.min(s, 10));
}

// CAMBIO (21/05/26): umbral fijo en 6 (antes dinámico 6/7).
// El umbral 7 bloqueaba casi todas las señales. Con 6 fijo el sistema
// vuelve a generar señales como cuando funcionaba correctamente.
export function getScoreThreshold(htf: SignalDirection, mtf: SignalDirection): number {
  return 6;
}

// ── Ajuste de liquidez por horario (CAMBIO 27/05/26) ──────────────────────────
//
// La sesión dejó de ser una llave que bloquea. Ahora la hora es un AJUSTE
// sobre el score, según la liquidez del momento:
//   LDN / NY → liquidez ALTA → +1   (la ventana operativa de siempre)
//   CLOSED   → liquidez BAJA → -2   (mercado abierto, pero fuera de sesión)
//
// WEEKEND no aplica acá: el gate de "mercado abierto" lo bloquea antes.
// Decisión final del terminal: scorePuro + este ajuste >= umbral (6).
export type LiquidityLevel = "alta" | "baja";

export function getLiquidityLevel(
  sessionTag: "LDN" | "NY" | "CLOSED" | "WEEKEND"
): LiquidityLevel {
  return sessionTag === "LDN" || sessionTag === "NY" ? "alta" : "baja";
}

export function liquidityAdjustment(level: LiquidityLevel): number {
  return level === "alta" ? 1 : -2;
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
    // Caps estructurales — replican engine en vivo. Si no se pasan, defaults seguros.
    slCapPct?:        number;   // % cap del SL (default 0.75)
    tpTargetPct?:     number;   // % target del TP (default 3)
    // Umbral mínimo TP/SL para aceptar TP estructural. <minRatio → fallback forzado.
    // Default 1.5 mantiene comportamiento histórico. Bajarlo (1.0, 0.5) acepta más estructura.
    minRatio?:        number;
    // Filtro de volatilidad: si el ATR de la vela de señal es menor a este valor → descartar.
    // 0 o undefined = sin filtro. Util para evitar mercados muertos.
    atrMin?:          number;
    // SEPARACIÓN BACKTEST/TERMINAL (21/05/26): default FALSE.
    // El backtest es laboratorio: prueba la fórmula HTF+MTF cruda en el historial.
    // Si true: el backtest replica el filtro de score del terminal (A/B testing).
    // Default false = backtest independiente del terminal.
    applyScoreFilter?: boolean;
  },
  // CAMBIO Fix #2 (Auditoría 20/05/26): timeframes opcionales para score completo.
  // Si se pasan los 3 (m15, ltf, h4), aplica el filtro de score igual al live.
  // Si no se pasan, mantiene comportamiento legacy (sin filtro de score).
  // El backtest validado debe pasarlos siempre para máxima fidelidad con live.
  extraTfs?: {
    m15Candles?: Candle[];   // velas 15m (timeframe M15 del score)
    ltfCandles?: Candle[];   // velas 5m (timeframe LTF del score)
    h4Candles?:  Candle[];   // velas 4h (h4Bias del score, penalty -2)
  }
): RawSignal[] {
  const { holdCandles, sessionFilter, ema200Filter, structureFilter, spread } = cfg;
  const slCapPct    = cfg.slCapPct    ?? 0.75;
  const tpTargetPct = cfg.tpTargetPct ?? 3;
  // CAMBIO v6 — default 0.5 valida por backtest comparativo
  const minRatio    = cfg.minRatio    ?? 0.5;
  const atrMin      = cfg.atrMin      ?? 0;

  // ── Pre-cómputo de timeframes adicionales para score (opcional) ────────────
  const m15Candles  = extraTfs?.m15Candles ?? [];
  const ltfCandles  = extraTfs?.ltfCandles ?? [];
  const h4Candles   = extraTfs?.h4Candles  ?? [];
  // SEPARACIÓN BACKTEST/TERMINAL (21/05/26): default FALSE.
  // El backtest es un LABORATORIO — debe probar la fórmula HTF+MTF cruda
  // en el historial, NO replicar el filtro de score del terminal.
  // El terminal opera con todos sus filtros; el backtest los prueba por separado.
  // Si se quiere ver "qué pasaría con score filter", se pasa applyScoreFilter:true.
  const applyScoreFilter = cfg.applyScoreFilter === true;  // default false
  const scoreEnabled = applyScoreFilter
    && m15Candles.length >= 50
    && ltfCandles.length >= 50
    && h4Candles.length >= 50;
  const m15Ind = scoreEnabled ? precompute(m15Candles) : null;
  const ltfInd = scoreEnabled ? precompute(ltfCandles) : null;
  const h4Ind  = scoreEnabled ? precompute(h4Candles)  : null;

  // Helper: buscar el índice del candle ya cerrado al momento entryT.
  // Misma lógica que el mapeo MTF estándar (última vela cuya siguiente todavía
  // no había abierto al momento de la entrada).
  function findIdxAt(candles: Candle[], entryT: number): number {
    let j = 0;
    while (j < candles.length - 1 && candles[j + 1].t < entryT) j++;
    return j;
  }

  // Fix #4 (v4): mapear HTF[i] a la última MTF YA CERRADA al momento en que
  // entraríamos (open de HTF[i+1]). Antes mapeaba al primer MTF con open ≥
  // HTF[i].open, dejando datos stale 45min (HTF 1H/MTF 15M) o 3h (HTF 4H/MTF 1H).
  // El "+1" en el chequeo (mtfCandles[mj+1].t) garantiza que mj es la última
  // MTF cuya siguiente vela todavía no había abierto al momento del entry.
  // ── PDH/PDL desde HTF — replica engine en vivo (que usa D1).
  // Agrupamos velas HTF por día calendario UTC para construir D1 sintético.
  // Para cada índice i, queremos el PDH/PDL del día ANTERIOR al timestamp de la señal.
  const dayKey = (ts: number) => {
    const d = new Date(ts);
    return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
  };
  const dailyHL = new Map<string, { h: number; l: number }>();
  const orderedDays: string[] = [];
  for (const c of htfCandles) {
    const k = dayKey(c.t);
    const cur = dailyHL.get(k);
    if (!cur) {
      dailyHL.set(k, { h: c.h, l: c.l });
      orderedDays.push(k);
    } else {
      if (c.h > cur.h) cur.h = c.h;
      if (c.l < cur.l) cur.l = c.l;
    }
  }
  // Para cada día, guardar referencia al día anterior (el "PDH/PDL" de ese día)
  const prevDayHL = new Map<string, { pdh: number; pdl: number } | null>();
  for (let d = 0; d < orderedDays.length; d++) {
    if (d === 0) prevDayHL.set(orderedDays[d], null);
    else {
      const prev = dailyHL.get(orderedDays[d - 1])!;
      prevDayHL.set(orderedDays[d], { pdh: prev.h, pdl: prev.l });
    }
  }

  const mtfMap = new Map<number, number>();
  let mj = 0;
  for (let i = 0; i < htfCandles.length; i++) {
    // Punto de entry = open de la siguiente vela HTF (o el último candle si no hay)
    const entryT = i + 1 < htfCandles.length
      ? htfCandles[i + 1].t
      : htfCandles[i].t + 1;
    while (mj < mtfCandles.length - 1 && mtfCandles[mj + 1].t < entryT) mj++;
    mtfMap.set(i, mj);
  }

  const signals: RawSignal[] = [];

  for (let i = 50; i < htfCandles.length - holdCandles; i++) {
    if (sessionFilter) {
      // CAMBIO Fix #1 (Auditoría 20/05/26): sesiones DST-aware idénticas al live.
      //
      // ANTES: ventana UTC fija 07:00-12:00 (LDN) y 13:00-18:00 (NY) — todo el año.
      // PROBLEMA: en verano (BST/EDT) las sesiones reales se corren 1h vs invierno.
      //   El backtest aceptaba señales fuera de la ventana operativa real del live
      //   y rechazaba señales que el live sí acepta. Resultado divergía vs realidad.
      //
      // AHORA: misma lógica que LiveTerminal.getSession() — convertimos el timestamp
      // del candle a hora local de Londres y NY usando Intl.DateTimeFormat
      // (resuelve DST automáticamente). Ventana operativa: 08:00-13:00 hora local
      // de cada ciudad, 5h, idéntica al live.
      if (!isInOperativeSession(htfCandles[i].t)) continue;
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
    // REVERSIÓN (24/05/26): vuelve a SOLO señales FUERTES (HTF == MTF).
    // El backtest del 24/05 demostró que aceptar "MTF en WAIT" como MODERADA
    // genera ruido masivo (1128+ señales, WR ~47%) — no es una señal válida.
    // "MTF en WAIT" significa ausencia de confirmación, no señal moderada.
    // Se descarta todo lo que no sea HTF == MTF.
    //
    // El campo `fuerza` se MANTIENE (toda señal es FUERTE por ahora) — deja la
    // infraestructura lista para sumar, en el futuro, señales adicionales de
    // alta probabilidad definidas y validadas por backtest. NO reactivar el
    // caso "MTF WAIT" sin un criterio nuevo y un backtest que lo respalde.
    if (hSig !== mSig) continue;
    const fuerza: "FUERTE" | "MODERADA" = "FUERTE";

    // Filtro ATR mínimo: descartar señales en mercado muerto.
    // Sin filtro (atrMin = 0) → no aplica. Con filtro → ATR de la vela debe ser >= atrMin.
    if (atrMin > 0) {
      const atrAt = htfInd.atr[i];
      if (atrAt == null || atrAt < atrMin) continue;
    }

    // ── Filtro de SCORE (Fix #2 — Auditoría 20/05/26) ─────────────────────────
    // Solo activo si se pasaron m15/ltf/h4 candles al detector.
    // Aplica el MISMO score y umbral que el LiveTerminal — backtest 1:1 con live.
    //
    // En el backtest HTF siempre == MTF (filtro previo), por lo que el umbral
    // dinámico siempre es 6. Las señales con score < 6 son las que el live
    // habría rechazado.
    if (scoreEnabled && m15Ind && ltfInd && h4Ind) {
      const entryT = i + 1 < htfCandles.length ? htfCandles[i + 1].t : htfCandles[i].t + 1;
      const m15Idx = findIdxAt(m15Candles, entryT);
      const ltfIdx = findIdxAt(ltfCandles, entryT);
      const h4Idx  = findIdxAt(h4Candles,  entryT);

      // Si alguno no tiene suficientes datos, mejor descartar (evita score sesgado)
      if (m15Idx < 30 || ltfIdx < 30 || h4Idx < 30) continue;

      const m15Sig = mtfSignalAt(m15Ind, m15Idx);
      const ltfSig = mtfSignalAt(ltfInd, ltfIdx);
      const { sig: h4Sig } = htfSignalAt(h4Ind, h4Idx);

      const priceAtSignal = htfInd.closes[i];
      const rsiAtSignal   = htfInd.rsi14[i];
      const structureSig  = getStructureAt(htfInd, i);
      // FVG activa para la dirección del trade
      const fvgZone = hSig === "UP" ? htfInd.fvg[i]?.bull : htfInd.fvg[i]?.bear;
      const tolerance = priceAtSignal * 0.0015;
      const fvgActive = !!fvgZone &&
        priceAtSignal >= fvgZone.bot - tolerance &&
        priceAtSignal <= fvgZone.top + tolerance;
      // Sesión activa para sumar +1 al score (LDN o NY)
      const sessionTag = getSessionAt(htfCandles[i].t);

      const score = calcSignalScore(
        hSig, mSig, m15Sig, ltfSig,
        rsiAtSignal, em200, priceAtSignal,
        sessionTag, structureSig, fvgActive, h4Sig
      );
      const threshold = getScoreThreshold(hSig, mSig);
      if (score < threshold) continue;
    }

    const rawEntry = i + 1 < htfCandles.length ? htfCandles[i + 1].o : htfCandles[i].c;
    const entryP   = hSig === "UP" ? rawEntry + spread : rawEntry - spread;

    // Calcular SL/TP estructurales usando la MISMA función que el engine en vivo.
    // Se pasa PDH/PDL del día anterior como SessionLevels — alinea backtest con live.
    const sigDayKey = dayKey(htfCandles[i].t);
    const sessionPrev = prevDayHL.get(sigDayKey) ?? null;
    const session: SessionLevels = sessionPrev
      ? { pdh: sessionPrev.pdh, pdl: sessionPrev.pdl }
      : { pdh: null, pdl: null };
    const levels = getStructureLevels(
      htfInd, i, hSig as "UP" | "DOWN", entryP, session, slCapPct, tpTargetPct, minRatio
    );

    signals.push({
      sig:       hSig,
      entry:     entryP,
      htfFuture: htfCandles.slice(i + 1, Math.min(i + 1 + holdCandles + 2, htfCandles.length)),
      date:      new Date(htfCandles[i].t).toLocaleDateString("es-CO", {
        month: "2-digit", day: "2-digit",
      }),
      slPrice:   levels.slPrice,
      tpPrice:   levels.tpPrice,
      tpSource:  levels.tpSource,
      fuerza,
    });
  }

  return signals;
}

// ── Live verdict ───────────────────────────────────────────────────────────────

export interface LiveVerdict {
  // ── Campos originales — se mantienen IGUAL (retrocompatibilidad) ──
  // El terminal actual los lee. No cambian de significado.
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

  // ── Arquitectura de 3 capas (22/05/26) — campos nuevos ──
  // Salida única del motor. Capa 1 = Ancla, Capa 2 = Gates, Capa 3 = Score.
  direccion:      "LONG" | "SHORT" | null;   // Capa 1 — dirección detectada
  fuerza:         "FUERTE" | "MODERADA" | null; // Capa 1 — FUERTE=HTF==MTF, MODERADA=MTF en WAIT
  gates: {                                   // Capa 2 — los 4 gates, cada uno true=pasa
    sesion:  boolean;
    d1:      boolean;
    rr:      boolean;
    noticia: boolean;
  };
  gatesPasan:     boolean;                   // Capa 2 — true si los 4 gates pasan
  score:          number;                    // Capa 3 — score de calidad 0-10
  scoreUmbral:    number;                    // Capa 3 — umbral que debe superar
  veredictoFinal: "ESPERAR" | "ENTRAR";      // salida única de las 3 capas
  detenidoEn:     "capa1" | "capa2" | "capa3" | null; // dónde se detuvo (el "por qué")

  // ── Liquidez (CAMBIO 27/05/26) — campos nuevos ──
  liquidez:       LiquidityLevel;   // "alta" (LDN/NY) o "baja" (resto de horas)
  liquidezAdj:    number;           // ajuste al score: +1 si alta, -2 si baja
  scoreAjustado:  number;           // score + liquidezAdj — valor que se compara vs umbral
                                    // (uso interno; NO mostrar como "X/10")
}

export function getLiveVerdict(
  htfInd:      PrecomputedIndicators,
  mtfInd:      PrecomputedIndicators,
  htfIdx:      number,
  mtfIdx:      number,
  livePrice:   number = 0,
  d1Bias:      SignalDirection = "WAIT",
  session:     SessionLevels = { pdh: null, pdl: null },
  slCapPct:    number = 0.75,
  // CAMBIO Fix #3 (Auditoría 20/05/26): default 3 (antes 2.5).
  tpTargetPct: number = 3,
  // ── Parámetros de la arquitectura de 3 capas (22/05/26) ──
  // Opcionales con default neutro: si el llamador no los pasa, el build no
  // se rompe y los campos viejos (verdict/strength) siguen funcionando igual.
  // El terminal los pasará de verdad en el Paso 2.
  m15Sig:      SignalDirection = "WAIT",
  ltfSig:      SignalDirection = "WAIT",
  h4Bias:      SignalDirection = "WAIT",
  sessionTag:  "LDN" | "NY" | "CLOSED" | "WEEKEND" = "CLOSED",
  hasNews:     boolean = false,
  // R:R mínimo del gate. PROVISIONAL en 1.5 (valor actual del sistema).
  // El backtest decidirá si sube a 2.0 — ver handoff.
  minRR:       number = 1.5
): LiveVerdict {
  const { sig: hSig, em200 } = htfSignalAt(htfInd, htfIdx);
  const mSig      = mtfSignalAt(mtfInd, mtfIdx);
  const rsi       = htfInd.rsi14[htfIdx];
  const structure = getStructureAt(htfInd, htfIdx);
  const fvgActive = livePrice > 0 && (
    isInFVG(htfInd, htfIdx, "UP", livePrice) ||
    isInFVG(htfInd, htfIdx, "DOWN", livePrice)
  );

  // ── Campos originales — se calculan IGUAL que antes (retrocompatibilidad) ──
  // El terminal actual lee verdict/strength/d1Blocked. No cambian.
  let verdict:   LiveVerdict["verdict"]  = "ESPERAR";
  let strength:  LiveVerdict["strength"] = "DÉBIL";
  let d1Blocked  = false;

  if      (hSig === "UP"   && mSig === "UP")   { verdict = "ENTRAR LONG";  strength = "FUERTE";   }
  else if (hSig === "DOWN" && mSig === "DOWN") { verdict = "ENTRAR SHORT"; strength = "FUERTE";   }
  else if (hSig === "UP"   && mSig === "WAIT") { verdict = "ENTRAR LONG";  strength = "MODERADO"; }
  else if (hSig === "DOWN" && mSig === "WAIT") { verdict = "ENTRAR SHORT"; strength = "MODERADO"; }

  if (d1Bias === "UP"   && verdict === "ENTRAR SHORT") { verdict = "ESPERAR"; d1Blocked = true; }
  if (d1Bias === "DOWN" && verdict === "ENTRAR LONG")  { verdict = "ESPERAR"; d1Blocked = true; }

  const levels: StructureLevels | null =
    verdict !== "ESPERAR" && livePrice > 0
      ? getStructureLevels(htfInd, htfIdx, hSig as "UP" | "DOWN", livePrice, session, slCapPct, tpTargetPct)
      : null;

  // ════════════════════════════════════════════════════════════════════════
  // ARQUITECTURA DE 3 CAPAS (22/05/26)
  // Ancla → Gates → Score. Una sola salida: veredictoFinal.
  // ════════════════════════════════════════════════════════════════════════

  // ── CAPA 1 — ANCLA: ¿hay dirección? ──
  // FUERTE = HTF y MTF coinciden. MODERADA = HTF activo, MTF en WAIT.
  let direccion: "LONG" | "SHORT" | null = null;
  let fuerza:    "FUERTE" | "MODERADA" | null = null;
  if      (hSig === "UP"   && mSig === "UP")   { direccion = "LONG";  fuerza = "FUERTE";   }
  else if (hSig === "DOWN" && mSig === "DOWN") { direccion = "SHORT"; fuerza = "FUERTE";   }
  else if (hSig === "UP"   && mSig === "WAIT") { direccion = "LONG";  fuerza = "MODERADA"; }
  else if (hSig === "DOWN" && mSig === "WAIT") { direccion = "SHORT"; fuerza = "MODERADA"; }

  // ── CAPA 2 — GATES: ¿se puede operar? (4 llaves binarias) ──
  const rrLive = levels && levels.slPct > 0 ? levels.tpPct / levels.slPct : 0;
  const gates = {
    // CAMBIO (27/05/26): la 1ª llave pasó de "¿es LDN o NY?" a "¿mercado abierto?".
    // Antes bloqueaba todo fuera de la ventana LDN/NY. Ahora solo el fin de
    // semana la cierra — la hora ya no bloquea, se maneja como liquidez (Capa 3).
    sesion:  sessionTag !== "WEEKEND",
    d1:      !(d1Bias === "UP"   && direccion === "SHORT") &&
             !(d1Bias === "DOWN" && direccion === "LONG"),
    rr:      rrLive >= minRR,
    noticia: !hasNews,
  };
  const gatesPasan = gates.sesion && gates.d1 && gates.rr && gates.noticia;

  // ── CAPA 3 — SCORE PURO + AJUSTE DE LIQUIDEZ ──
  // El score es PURO (solo calidad del setup; sin el +1 de sesión).
  // La hora se aplica como ajuste de liquidez: alta +1 / baja -2.
  // Decisión: scorePuro + ajuste >= umbral (6).
  const score        = calcSignalScore(
    hSig, mSig, m15Sig, ltfSig, rsi, em200, livePrice,
    sessionTag, structure, fvgActive, h4Bias
  );
  const scoreUmbral  = getScoreThreshold(hSig, mSig);
  const liquidez     = getLiquidityLevel(sessionTag);
  const liquidezAdj  = liquidityAdjustment(liquidez);
  const scoreAjustado = score + liquidezAdj;

  // ── SALIDA ÚNICA: recorre las capas en orden, se detiene en la primera que falla ──
  let veredictoFinal: "ESPERAR" | "ENTRAR" = "ESPERAR";
  let detenidoEn: "capa1" | "capa2" | "capa3" | null = null;
  if      (direccion === null)              detenidoEn = "capa1";
  else if (!gatesPasan)                     detenidoEn = "capa2";
  else if (scoreAjustado < scoreUmbral)     detenidoEn = "capa3";
  else { veredictoFinal = "ENTRAR"; detenidoEn = null; }

  return {
    htf: hSig, mtf: mSig, verdict, strength,
    ema200: em200, rsi,
    structure, levels, fvgActive, d1Blocked,
    direccion, fuerza, gates, gatesPasan,
    score, scoreUmbral, veredictoFinal, detenidoEn,
    // ── Liquidez (CAMBIO 27/05/26) ──
    liquidez, liquidezAdj, scoreAjustado,
  };
}
