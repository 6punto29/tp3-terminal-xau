// ─────────────────────────────────────────────────────────────────────────────
// lib/engine/shadow.ts
// Shadow Trading — detección y cálculo de niveles para señales TEÓRICAS.
//
// Implementa el patrón "Shadow Signals" / "Counterfactual Learning":
// captura decisiones que el motor rechaza (o emite con estructura
// contradictoria) para acumular data real y medir el costo de oportunidad
// de los gates. NO modifica el motor, NO ejecuta órdenes.
// Referencia: dev.to/ronny_nyabuto_bba33987098 (03/06/26).
//
// Pure function — no I/O, no state, no framework. El terminal LEE el
// resultado y decide qué hacer con la captura (POST a Supabase).
//
// Dos condiciones de captura (case_type):
//
//   "d1_blocked"           → score puro 10 + alineación total (HTF/MTF/M15/LTF),
//                            FUERTE, todos los gates pasan EXCEPTO D1.
//                            Pregunta a responder: ¿valió la pena bloquear?
//
//   "structure_contradicts" → motor da ENTRAR FUERTE pero estructura del HTF
//                             contradice la dirección (BULLISH+SHORT o
//                             BEARISH+LONG). NEUTRAL NO cuenta como
//                             contradicción — solo dirección opuesta.
//                             Pregunta: ¿estos llegan a TP completo o parciales?
//
// 4 perfiles de TP en paralelo por evento (mismo SL, distinto TP):
//   - structural    → TP del motor (R:R [2,5])
//   - swing_minor   → primer swing sin filtro R:R
//   - atr_15x       → entry ± ATR × 1.5
//   - rr_15_fixed   → SL × 1.5 (R:R fijo de 1.5)
//
// El SL es el mismo para los 4 perfiles: estructural del motor capado 0.75%.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  PrecomputedIndicators,
  SessionLevels,
  PriceStructure,
  SignalDirection,
} from "./types";
import {
  getStructureLevels,
  type LiveVerdict,
  type LiquidityLevel,
} from "./signals";

// ── Tipos públicos ────────────────────────────────────────────────────────────

export type ShadowCaseType = "d1_blocked" | "structure_contradicts";

export type ShadowTPType =
  | "structural"
  | "swing_minor"
  | "atr_15x"
  | "rr_15_fixed";

export type ShadowDirection = "LONG" | "SHORT";

/**
 * Snapshot completo del contexto en el momento de la decisión.
 * Equivalente al "decision context" exigido por counterfactual learning:
 * sin esto, no son counterfactuals — es storytelling.
 */
export interface ShadowDetection {
  caseType:      ShadowCaseType;
  reason:        string;
  direction:     ShadowDirection;
  // Snapshot del motor (todo lo necesario para reconstruir la decisión)
  scorePuro:     number;            // 0-10, sin liquidezAdj
  scoreAjustado: number;            // score + liquidezAdj
  scoreUmbral:   number;            // umbral que se debía superar
  structure:     PriceStructure;
  htfSig:        SignalDirection;
  mtfSig:        SignalDirection;
  m15Sig:        SignalDirection;
  ltfSig:        SignalDirection;
  d1Bias:        SignalDirection;
  h4Bias:        SignalDirection;
  rsi:           number | null;
  ema200:        number | null;
  atr:           number | null;
  liquidez:      LiquidityLevel;
  htfTf:         "1h" | "4h";
  // ¿Qué gates pasaban en el momento? (telemetría — el motor real)
  gatesPasaban: {
    sesion:  boolean;
    d1:      boolean;
    rr:      boolean;
    noticia: boolean;
  };
}

/**
 * Un perfil de TP con su precio calculado y R:R efectivo.
 * tpPrice puede ser null si la hipótesis no produjo un nivel
 * (ej: structural sin candidato en [2,5], o ATR no disponible).
 */
export interface ShadowTPProfile {
  type:         ShadowTPType;
  tpPrice:      number | null;
  rr:           number;             // tpDist / slDist; 0 si tpPrice null
  sourceDetail: string;             // descripción legible del origen
}

/**
 * Setup completo de la señal teórica: entry + SL común + 4 perfiles de TP.
 * Retorna null si no se pudo calcular SL (caso degenerado: sin swings ni
 * pivotes, función getStructureLevels retorna null incluso con minRatio=0).
 */
export interface ShadowSetup {
  entry:    number;
  sl:       number;
  slPct:    number;
  slDist:   number;
  profiles: ShadowTPProfile[];      // SIEMPRE longitud 4 (uno por ShadowTPType)
}

// ── detectShadowCondition ─────────────────────────────────────────────────────

export interface DetectShadowInput {
  verdict:   LiveVerdict;           // resultado de getLiveVerdict
  m15Sig:    SignalDirection;       // signal del 15m
  ltfSig:    SignalDirection;       // signal del 5m
  d1Bias:    SignalDirection;       // sesgo D1
  h4Bias:    SignalDirection;       // sesgo 4H
  atr:       number | null;         // ATR del HTF actual
  htfTf:     "1h" | "4h";           // timeframe HTF en uso
}

/**
 * Detecta si la señal actual califica para Shadow Trading.
 * Retorna ShadowDetection si califica, null si no.
 *
 * Las 2 condiciones son MUTUAMENTE EXCLUYENTES por diseño: una señal
 * bloqueada por D1 no puede emitir "ENTRAR" (precondición de
 * structure_contradicts). Si alguna vez un caso cumpliera ambas, se
 * prioriza d1_blocked (es la condición más restrictiva y rara).
 */
export function detectShadowCondition(
  input: DetectShadowInput
): ShadowDetection | null {
  const { verdict: v, m15Sig, ltfSig, d1Bias, h4Bias, atr, htfTf } = input;

  // Precondición común: tiene que haber dirección detectable y ser FUERTE.
  // MODERADAS (MTF en WAIT) no entran a Shadow — el motor ya las trata
  // distinto y el operador no las opera por política.
  if (v.direccion === null) return null;
  if (v.fuerza !== "FUERTE") return null;

  const direction: ShadowDirection = v.direccion;
  const tradeDir: SignalDirection = direction === "LONG" ? "UP" : "DOWN";

  // ── CASO 1: d1_blocked ───────────────────────────────────────────────────
  // Score puro 10 + alineación total HTF/MTF/M15/LTF + todos los gates
  // pasan EXCEPTO D1 (que es el que bloquea).
  //
  // Nota sobre gates.rr: cuando D1 bloquea, el motor pone verdict='ESPERAR'
  // y NO calcula levels → rrLive=0 → gates.rr=false. Para shadow eso es un
  // falso negativo: el R:R hipotético habría podido pasar. Por eso NO
  // exigimos gates.rr aquí — el motor real ya nos dijo si había levels
  // válidos vía v.levels (que en este caso será null porque verdict pasó
  // a ESPERAR). Compensamos: confirmamos que D1 efectivamente bloquea, y
  // dejamos el cálculo de levels hipotéticos para calcShadowSetup().
  const d1Blocks =
    (d1Bias === "UP"   && direction === "SHORT") ||
    (d1Bias === "DOWN" && direction === "LONG");

  if (
    v.score === 10 &&
    d1Blocks &&
    v.gates.sesion &&
    v.gates.noticia &&
    m15Sig === tradeDir &&
    ltfSig === tradeDir
  ) {
    return buildDetection({
      caseType:  "d1_blocked",
      reason:    `Score puro 10/10 + HTF/MTF/M15/LTF alineados ${tradeDir}, bloqueado solo por D1 (${d1Bias})`,
      direction, v, m15Sig, ltfSig, d1Bias, h4Bias, atr, htfTf,
    });
  }

  // ── CASO 2: structure_contradicts ────────────────────────────────────────
  // Motor da ENTRAR FUERTE pero estructura del HTF contradice.
  // NEUTRAL no cuenta: solo BULLISH+SHORT o BEARISH+LONG.
  const structureContradicts =
    (direction === "LONG"  && v.structure === "BEARISH") ||
    (direction === "SHORT" && v.structure === "BULLISH");

  if (v.veredictoFinal === "ENTRAR" && structureContradicts) {
    return buildDetection({
      caseType:  "structure_contradicts",
      reason:    `Motor ENTRAR ${direction} FUERTE pero estructura ${v.structure} contradice`,
      direction, v, m15Sig, ltfSig, d1Bias, h4Bias, atr, htfTf,
    });
  }

  return null;
}

// Helper interno para construir el ShadowDetection sin repetir código.
function buildDetection(args: {
  caseType:  ShadowCaseType;
  reason:    string;
  direction: ShadowDirection;
  v:         LiveVerdict;
  m15Sig:    SignalDirection;
  ltfSig:    SignalDirection;
  d1Bias:    SignalDirection;
  h4Bias:    SignalDirection;
  atr:       number | null;
  htfTf:     "1h" | "4h";
}): ShadowDetection {
  const { v } = args;
  return {
    caseType:      args.caseType,
    reason:        args.reason,
    direction:     args.direction,
    scorePuro:     v.score,
    scoreAjustado: v.scoreAjustado,
    scoreUmbral:   v.scoreUmbral,
    structure:     v.structure,
    htfSig:        v.htf,
    mtfSig:        v.mtf,
    m15Sig:        args.m15Sig,
    ltfSig:        args.ltfSig,
    d1Bias:        args.d1Bias,
    h4Bias:        args.h4Bias,
    rsi:           v.rsi,
    ema200:        v.ema200,
    atr:           args.atr,
    liquidez:      v.liquidez,
    htfTf:         args.htfTf,
    gatesPasaban:  { ...v.gates },
  };
}

// ── calcShadowSetup ───────────────────────────────────────────────────────────

/**
 * Calcula entry/SL/4 perfiles de TP para una señal teórica.
 * Funciona aunque el motor haya bloqueado la señal (D1 hard filter):
 * recalcula los niveles HIPOTÉTICOS usando la misma función del motor
 * con la dirección teórica.
 *
 * Retorna null si NI SIQUIERA con minRatio=0 hay un candidato estructural
 * (caso muy raro: sin swings, sin pivotes, sin PDH/PDL en la dirección).
 *
 * @param ind     indicadores precalculados del HTF
 * @param idx     índice de la vela HTF actual (htfC.length - 1)
 * @param direction LONG o SHORT teórica
 * @param entry   precio de entrada (último recálculo del motor — NO live)
 * @param session PDH/PDL/PDC del día anterior
 */
export function calcShadowSetup(
  ind:       PrecomputedIndicators,
  idx:       number,
  direction: ShadowDirection,
  entry:     number,
  session:   SessionLevels
): ShadowSetup | null {
  if (entry <= 0 || idx < 0 || idx >= ind.closes.length) return null;

  const isLong = direction === "LONG";
  const dir: "UP" | "DOWN" = isLong ? "UP" : "DOWN";

  // ── Paso 1: obtener SL del motor (capado 0.75%) ─────────────────────────
  // Pedimos a getStructureLevels los niveles con minRatio=0 y maxRR=999 →
  // siempre retorna el primer candidato si existe alguno. Nos quedamos con
  // su SL (idéntico al que usaría el motor real con cualquier minRatio,
  // porque el SL se calcula independientemente del TP).
  //
  // El TP que retorna en este modo (sin filtros) es justamente nuestro
  // perfil "swing_minor" — primer swing/pivote en dirección, sin filtro R:R.
  const swingMinorLevels = getStructureLevels(
    ind, idx, dir, entry, session,
    0.75,    // slCapPct: hardcodeado del motor
    3,       // tpTargetPct: legacy, sin uso
    0,       // minRatio: sin piso → cualquier candidato vale
    999      // maxRR: sin techo → nunca retorna null por R:R alto
  );

  if (!swingMinorLevels) {
    // No hay NINGÚN candidato estructural en la dirección → no podemos
    // siquiera definir un setup teórico. Caso muy raro.
    return null;
  }

  const sl     = swingMinorLevels.slPrice;
  const slPct  = swingMinorLevels.slPct;
  const slDist = Math.abs(entry - sl);
  if (slDist <= 0) return null;

  // ── Paso 2: calcular los 4 perfiles de TP ───────────────────────────────

  // Perfil 1 — structural: TP del motor real (R:R [2, 5])
  const structuralLevels = getStructureLevels(
    ind, idx, dir, entry, session, 0.75, 3, 2, 5
  );
  const structural: ShadowTPProfile = structuralLevels
    ? {
        type:         "structural",
        tpPrice:      structuralLevels.tpPrice,
        rr:           structuralLevels.slPct > 0
                       ? structuralLevels.tpPct / structuralLevels.slPct
                       : 0,
        sourceDetail: `${structuralLevels.tpSource} R:R ${
          (structuralLevels.tpPct / Math.max(structuralLevels.slPct, 1e-9)).toFixed(2)
        }`,
      }
    : {
        type:         "structural",
        tpPrice:      null,
        rr:           0,
        sourceDetail: "sin candidato en R:R [2,5]",
      };

  // Perfil 2 — swing_minor: ya lo tenemos del Paso 1
  const swingMinor: ShadowTPProfile = {
    type:         "swing_minor",
    tpPrice:      swingMinorLevels.tpPrice,
    rr:           swingMinorLevels.slPct > 0
                   ? swingMinorLevels.tpPct / swingMinorLevels.slPct
                   : 0,
    sourceDetail: `${swingMinorLevels.tpSource} R:R ${
      (swingMinorLevels.tpPct / Math.max(swingMinorLevels.slPct, 1e-9)).toFixed(2)
    }`,
  };

  // Perfil 3 — atr_15x: entry ± ATR × 1.5
  const atrVal = ind.atr[idx];
  let atr15x: ShadowTPProfile;
  if (atrVal != null && atrVal > 0) {
    const tpRaw   = isLong ? entry + atrVal * 1.5 : entry - atrVal * 1.5;
    const tpPrice = Math.round(tpRaw * 100) / 100;
    const tpDist  = Math.abs(tpPrice - entry);
    atr15x = {
      type:         "atr_15x",
      tpPrice,
      rr:           tpDist / slDist,
      sourceDetail: `ATR ${atrVal.toFixed(2)} × 1.5 = ${(atrVal * 1.5).toFixed(2)}`,
    };
  } else {
    atr15x = {
      type:         "atr_15x",
      tpPrice:      null,
      rr:           0,
      sourceDetail: "ATR no disponible",
    };
  }

  // Perfil 4 — rr_15_fixed: TP a distancia = slDist × 1.5
  const rrTpRaw   = isLong ? entry + slDist * 1.5 : entry - slDist * 1.5;
  const rrTpPrice = Math.round(rrTpRaw * 100) / 100;
  const rr15Fixed: ShadowTPProfile = {
    type:         "rr_15_fixed",
    tpPrice:      rrTpPrice,
    rr:           1.5,
    sourceDetail: `SL distancia ${slDist.toFixed(2)} × 1.5`,
  };

  return {
    entry:    Math.round(entry * 100) / 100,
    sl,
    slPct,
    slDist:   Math.round(slDist * 100) / 100,
    profiles: [structural, swingMinor, atr15x, rr15Fixed],
  };
}

// ── checkShadowOutcome ────────────────────────────────────────────────────────

export type ShadowStatus = "OPEN" | "WIN" | "LOSS" | "EXPIRED";

export interface ShadowOutcome {
  status:    ShadowStatus;
  closedAt:  number | null;       // timestamp ms si cerró
  hitPrice:  number | null;       // precio al cierre
}

/**
 * Evalúa el outcome de un trade shadow a partir del precio actual y el
 * tiempo transcurrido desde su captura. Idempotente: dado el mismo input,
 * siempre da el mismo output. El tracker la llama en cada `load()` (5 min)
 * sobre todas las filas OPEN del usuario.
 *
 * Lógica de cierre:
 *   - LONG:  toca TP por arriba → WIN. Toca SL por abajo → LOSS.
 *   - SHORT: toca TP por abajo  → WIN. Toca SL por arriba → LOSS.
 *   - Tiempo > 24h sin tocar    → EXPIRED.
 *
 * IMPORTANTE: la función usa el precio LIVE actual como aproximación.
 * Idealmente debería revisarse contra el high/low de cada vela 5m desde
 * created_at, pero hacerlo lado-cliente implicaría fetchear muchas velas
 * y romper el rate limit. Aproximación práctica para Fase Demo. Si la
 * tasa de "perdidos" es alta podemos migrar a un Vercel Cron server-side
 * más adelante (Fase Push Web 24/7 — comparte infraestructura).
 *
 * @param trade   { tp: number; sl: number; direction; createdAt; expiresAt }
 * @param price   precio actual (TwelveData LIVE)
 * @param now     timestamp actual (ms). Inyectable para testing.
 */
export interface ShadowTradeStateInput {
  tpPrice:   number | null;       // null = perfil sin TP (queda OPEN hasta EXPIRED)
  slPrice:   number;
  direction: ShadowDirection;
  createdAt: number;              // ms
  expiresAt: number;              // ms
}

export function checkShadowOutcome(
  trade: ShadowTradeStateInput,
  price: number,
  now:   number = Date.now()
): ShadowOutcome {
  // Sin precio válido → no podemos evaluar, queda OPEN
  if (price <= 0 || !Number.isFinite(price)) {
    return { status: "OPEN", closedAt: null, hitPrice: null };
  }

  const isLong = trade.direction === "LONG";

  // Chequear SL primero (más conservador: en caso de gap que cruza ambos,
  // contamos LOSS — el broker ejecuta SL antes en la mayoría de escenarios
  // de slippage real).
  const slHit = isLong ? price <= trade.slPrice : price >= trade.slPrice;
  if (slHit) {
    return { status: "LOSS", closedAt: now, hitPrice: price };
  }

  // Chequear TP solo si hay un nivel definido
  if (trade.tpPrice != null) {
    const tpHit = isLong ? price >= trade.tpPrice : price <= trade.tpPrice;
    if (tpHit) {
      return { status: "WIN", closedAt: now, hitPrice: price };
    }
  }

  // ¿Expiró el plazo?
  if (now >= trade.expiresAt) {
    return { status: "EXPIRED", closedAt: now, hitPrice: price };
  }

  return { status: "OPEN", closedAt: null, hitPrice: null };
}

// ── Helpers públicos para el integrador ──────────────────────────────────────

/**
 * Granularidad sugerida del detector: una sola captura por vela HTF y por
 * dirección. Genera una clave determinística que el integrador puede usar
 * para deduplicar antes de hacer el POST a Supabase.
 *
 * Formato: `{caseType}-{direction}-{htfTf}-{htfBucketStartMs}`
 * Donde htfBucketStart es el inicio (UTC) de la vela HTF actual.
 */
export function shadowEventKey(
  caseType:  ShadowCaseType,
  direction: ShadowDirection,
  htfTf:     "1h" | "4h",
  now:       number = Date.now()
): string {
  const d = new Date(now);
  d.setUTCMinutes(0, 0, 0);
  if (htfTf === "4h") {
    d.setUTCHours(Math.floor(d.getUTCHours() / 4) * 4);
  }
  return `${caseType}-${direction}-${htfTf}-${d.getTime()}`;
}

/**
 * Constante de vencimiento — 24h en ms.
 * Centralizada para que tracker y detector usen el mismo valor.
 */
export const SHADOW_EXPIRY_MS = 24 * 60 * 60 * 1000;
