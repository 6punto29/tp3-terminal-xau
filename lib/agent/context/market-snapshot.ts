// ─────────────────────────────────────────────────────────────────────────────
// lib/agent/context/market-snapshot.ts
// Serializes live market state into a compact snapshot for the AI agent.
// The agent receives this as part of its system prompt context.
// ─────────────────────────────────────────────────────────────────────────────

import { MarketSnapshot, SignalDirection, BacktestResult } from "@/lib/engine/types";

type Session = "LDN" | "NY" | "CLOSED";

interface ChecklistState {
  sessionActive:    boolean;
  ema200Clear:      boolean;
  htfMtfAligned:   boolean;
  rsiClean:        boolean;
  noNews:          boolean;
  scoreOk:         boolean;
}

interface BuildSnapshotInput {
  price:       number;
  htfSignal:   SignalDirection;
  mtfSignal:   SignalDirection;
  session:     Session;
  checklist:   ChecklistState;
  lastBacktest?: BacktestResult;
}

export function buildMarketSnapshot(input: BuildSnapshotInput): MarketSnapshot {
  const passed = Object.values(input.checklist).filter(Boolean).length;
  return {
    timestamp:    Date.now(),
    symbol:       "XAUUSDT",
    price:        input.price,
    htfSignal:    input.htfSignal,
    mtfSignal:    input.mtfSignal,
    session:      input.session,
    checklist:    {
      "1_sesion_ldnny":          input.checklist.sessionActive,
      "2_ema200_sesgo":          input.checklist.ema200Clear,
      "3_htf_mtf_alineados":     input.checklist.htfMtfAligned,
      "4_rsi_ok":                input.checklist.rsiClean,
      "5_sin_noticias":          input.checklist.noNews,
      "6_score_min6":            input.checklist.scoreOk,
      // "resultado": passed === 6 ? "OPERAR" : `ESPERAR (${passed}/6)`,
    },
    lastBacktest: input.lastBacktest,
  };
}

/** Compact text representation for injection into LLM context window */
export function snapshotToText(snap: MarketSnapshot): string {
  const checks = Object.entries(snap.checklist)
    .filter(([k]) => k !== "resultado")
    .map(([k, v]) => `  ${v ? "✓" : "✗"} ${k}`)
    .join("\n");

  const btLine = snap.lastBacktest
    ? `Último backtest: ${snap.lastBacktest.label} · WR ${snap.lastBacktest.summary.wr}% · EV +${snap.lastBacktest.summary.ev?.toFixed(2)}R`
    : "Sin backtest previo";

  return `
=== MARKET SNAPSHOT ${new Date(snap.timestamp).toLocaleString("es-CO")} ===
Símbolo : ${snap.symbol}
Precio  : $${snap.price.toFixed(2)}
Sesión  : ${snap.session}
HTF     : ${snap.htfSignal}
MTF     : ${snap.mtfSignal}
Veredicto: ${snap.checklist["resultado"] ?? "—"}

Checklist:
${checks}

${btLine}
`.trim();
}
