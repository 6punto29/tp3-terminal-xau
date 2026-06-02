// ─────────────────────────────────────────────────────────────────────────────
// lib/engine/validity.ts
// Validez de entrada — semáforo adaptativo. Pure function — no I/O, no state,
// no framework. El terminal solo lee este resultado y lo renderiza.
//
// Origen del refactor: este código vivía en components/LiveTerminal.tsx
// dentro del componente EntryValidityIndicator (líneas 385-492). Estaba
// recalculando lógica de decisión en la capa UI, contradiciendo el principio
// del knowledge: "el terminal LEE el veredicto del engine — no recalcula".
//
// Cambio 02/06/26 v7: migración a lib/engine/. Comportamiento idéntico
// byte por byte al anterior — sólo cambia de lugar. Funcionalidad probada
// y validada en producción 01/06/26 (override + estructura confirmada).
// ─────────────────────────────────────────────────────────────────────────────

import type { PriceStructure } from "./types";

// Tipos espejados de los del terminal — duplicados a propósito para mantener
// el engine 100% desacoplado del componente UI.
export type MTFSig    = "UP" | "DOWN" | "WAIT";
export type Verdict   = "ENTRAR LONG" | "ENTRAR SHORT" | "ESPERAR";
export type HtfTf     = "1h" | "4h";
export type ValidityState = "green" | "yellow" | "red";

// Subconjunto de LiveSignal que necesita la función. Mantenemos el contrato
// mínimo para que sea fácil de testear sin tener que armar un LiveSignal entero.
export interface ValiditySignalInput {
  verdict:   Verdict;
  htf:       MTFSig;
  mtf:       MTFSig;
  structure: PriceStructure;
}

// Subconjunto de MT5Snapshot que necesita la función. Solo SL y TP — los
// niveles de referencia para el cálculo de R:R live.
export interface ValiditySnapInput {
  sl: string;
  tp: string;
}

export interface EntryValidityInput {
  signal: ValiditySignalInput;
  price:  number;
  htfTf:  HtfTf;
  d1Bias: MTFSig;
  h4Bias: MTFSig;
  snap:   ValiditySnapInput;
  // Inyectable para testing. Si no se pasa, usa Date.now().
  now?:   number;
}

export interface EntryValidity {
  state:          ValidityState;
  label:          string;
  reason:         string;
  // Telemetría — útil para debug y para futura UI si se quisiera mostrar
  rrLive:         number;
  elapsedPct:     number;
  trendOverride:  boolean;
  levelCrossed:   boolean;
  tpCrossed:      boolean;
  slCrossed:      boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// getEntryValidity — calcula el estado del semáforo de validez de entrada.
//
// Evalúa 3 factores:
//   1. Tiempo transcurrido desde apertura de vela HTF (% sobre duración total)
//   2. R:R actual recalculado con el precio live (no el del setup original)
//   3. Alineación multi-timeframe: D1 + 4H + HTF + MTF a favor del trade
//      + estructura confirmada (BULLISH para LONG, BEARISH para SHORT)
//
// Lógica:
//   · sin niveles válidos / precio ≤0          → 🔴 NO ENTRAR
//   · precio ya cruzó SL o TP del snapshot     → 🔴 PASAR
//   · R:R < 1.0                                → 🔴 NO ENTRAR (degradado)
//   · R:R 1.0-1.5                              → 🟡 TARDÍA (ratio degradado)
//   · 0-15% tiempo + R:R OK                    → 🟢 ENTRADA VÁLIDA (setup fresco)
//   · 15-35% tiempo + R:R OK                   → 🟢 ENTRADA VÁLIDA (vela avanzada X%)
//   · 35%+ tiempo + R:R OK + override tendencia → 🟢 ENTRADA VÁLIDA (tendencia ultra fuerte)
//   · 35%+ tiempo + R:R OK sin override        → 🟡 TARDÍA (vela avanzada X%)
//
// El override "tendencia ultra fuerte" requiere 5 condiciones simultáneas:
// D1 + 4H + HTF + MTF todos en dirección del trade + estructura confirmada
// (LH/LL para SHORT = BEARISH, HH/HL para LONG = BULLISH). Si la estructura
// se rompe a NEUTRAL, el override se desactiva.
// ─────────────────────────────────────────────────────────────────────────────
export function getEntryValidity(input: EntryValidityInput): EntryValidity {
  const { signal, price, htfTf, d1Bias, h4Bias, snap } = input;

  const isLong = signal.verdict === "ENTRAR LONG";
  const tradeDir: MTFSig = isLong ? "UP" : "DOWN";

  // ── R:R LIVE: calcular con el precio actual y los niveles del SNAPSHOT ──
  // Usamos snap.sl / snap.tp (congelados al momento de detectar la señal) y
  // NO los levels del engine en vivo. Razón: el engine puede dejar de retornar
  // levels válidos si el precio se aleja del setup, lo que rompía el semáforo
  // (rrLive=0 → rojo) aunque el snapshot tuviera SL/TP válidos.
  // Esto unifica el cálculo con el del MT5Block (precio congelado de referencia)
  // y elimina contradicciones entre indicadores.
  const snapSL = parseFloat(snap.sl);
  const snapTP = parseFloat(snap.tp);
  const snapValid = !isNaN(snapSL) && !isNaN(snapTP);

  // ¿El precio ya cruzó SL o TP del snapshot? Si sí, la entrada está vencida.
  const tpCrossed = snapValid && (isLong ? price >= snapTP : price <= snapTP);
  const slCrossed = snapValid && (isLong ? price <= snapSL : price >= snapSL);
  const levelCrossed = tpCrossed || slCrossed;

  let rrLive = 0;
  if (snapValid && price > 0 && !levelCrossed) {
    const slDist = isLong ? price - snapSL : snapSL - price;
    const tpDist = isLong ? snapTP - price : price - snapTP;
    rrLive = slDist > 0 ? tpDist / slDist : 0;
  }

  // ── TIEMPO TRANSCURRIDO (%) en la vela HTF actual ───────────────────────
  const now = input.now ?? Date.now();
  const d = new Date(now);
  let elapsedMs = 0, totalMs = 0;
  if (htfTf === "1h") {
    // Vela 1H: arranca a los :00 de la hora UTC actual
    const opened = new Date(d);
    opened.setUTCMinutes(0, 0, 0);
    elapsedMs = now - opened.getTime();
    totalMs = 60 * 60 * 1000;
  } else {
    // Vela 4H: arranca en el bloque de 4h actual (0,4,8,12,16,20 UTC)
    const opened = new Date(d);
    opened.setUTCMinutes(0, 0, 0);
    const currH = d.getUTCHours();
    opened.setUTCHours(Math.floor(currH / 4) * 4);
    elapsedMs = now - opened.getTime();
    totalMs = 4 * 60 * 60 * 1000;
  }
  const elapsedPct = totalMs > 0 ? elapsedMs / totalMs : 0;

  // ── OVERRIDE TENDENCIA ULTRA FUERTE ─────────────────────────────────────
  // Requiere 5 condiciones simultáneas a favor del trade:
  //   1. D1 (sesgo diario) en la misma dirección
  //   2. 4H en la misma dirección
  //   3. HTF (1H o 4H según preferencia del usuario) en la misma dirección
  //   4. MTF (15M o 5M) en la misma dirección
  //   5. Estructura confirmada: BULLISH (HH/HL) para LONG, BEARISH (LH/LL) para SHORT
  //
  // Si las 5 coinciden → ignora el filtro de "vela avanzada ≥35%" y
  // mantiene 🟢 ENTRADA VÁLIDA mientras R:R siga siendo válido.
  // Si la estructura se rompe a NEUTRAL → cae a 🟡 TARDÍA pasado el 35%.
  //
  // Cambio 01/06/26: se agregó structureConfirmed para evitar que el override
  // siguiera activo cuando la estructura intradía se rompía (caso real
  // observado 31/05-01/06 con persistencia 6h+ a pesar de estructura NEUTRAL).
  // Texto del cartel también ajustado: "(override)" removido por ser engañoso.
  // (Si htfTf==="4h", el 4H ya está implícito en signal.htf, pero igual
  // chequeamos h4Bias para consistencia.)
  const structureConfirmed =
    (isLong && signal.structure === "BULLISH") ||
    (!isLong && signal.structure === "BEARISH");

  const trendOverride =
    d1Bias === tradeDir &&
    h4Bias === tradeDir &&
    signal.htf === tradeDir &&
    signal.mtf === tradeDir &&
    structureConfirmed;

  // ── DECISIÓN DEL SEMÁFORO ───────────────────────────────────────────────
  let state: ValidityState = "green";
  let label = "ENTRADA VÁLIDA";
  let reason = "Setup fresco";

  if (!snapValid || price <= 0) {
    state = "red"; label = "NO ENTRAR";
    reason = `Sin niveles válidos`;
  } else if (levelCrossed) {
    state = "red"; label = "PASAR";
    reason = tpCrossed
      ? `Precio ya alcanzó el TP del snapshot`
      : `Precio ya cruzó el SL del snapshot`;
  } else if (rrLive < 1.0) {
    state = "red"; label = "NO ENTRAR";
    reason = `R:R ${rrLive.toFixed(1)} · setup degradado`;
  } else if (rrLive < 1.5) {
    state = "yellow"; label = "TARDÍA";
    reason = `R:R ${rrLive.toFixed(1)} · ratio degradado`;
  } else if (elapsedPct < 0.15) {
    state = "green"; label = "ENTRADA VÁLIDA";
    reason = `R:R ${rrLive.toFixed(1)} · setup fresco`;
  } else if (elapsedPct < 0.35) {
    state = "green"; label = "ENTRADA VÁLIDA";
    reason = `R:R ${rrLive.toFixed(1)} · vela avanzada ${Math.round(elapsedPct * 100)}%`;
  } else if (trendOverride) {
    state = "green"; label = "ENTRADA VÁLIDA";
    reason = `R:R ${rrLive.toFixed(1)} · tendencia ultra fuerte`;
  } else {
    state = "yellow"; label = "TARDÍA";
    reason = `R:R ${rrLive.toFixed(1)} · vela avanzada ${Math.round(elapsedPct * 100)}%`;
  }

  return {
    state,
    label,
    reason,
    rrLive,
    elapsedPct,
    trendOverride,
    levelCrossed,
    tpCrossed,
    slCrossed,
  };
}
