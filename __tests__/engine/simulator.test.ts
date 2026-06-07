// ─────────────────────────────────────────────────────────────────────────────
// __tests__/engine/simulator.test.ts
// Unit tests for engine functions used by the LIVE terminal.
// Run with: npm test  (or `vitest run`)
// Zero network calls. Zero framework. Pure math.
//
// Scope (decidido 07/06/2026 noche, Opción C2):
// Este archivo solo testea funciones del MOTOR que el terminal en vivo usa.
// Los tests de simulateSignals / summarize / calcEV / calcOpLevels fueron
// eliminados porque pertenecen al backtest legacy (o a código muerto en el
// caso de calcOpLevels). El backtest se rehará en lib/backtest/ aparte
// según filosofía cerrada el 03/06/2026 y se testeará en su proyecto.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { calcLotSize } from "@/lib/engine/simulator";

// ── calcLotSize ───────────────────────────────────────────────────────────────
// Usada por LiveTerminal.tsx para calcular el lotaje sugerido en órdenes MT5.
// Fórmula: capital × riskPct ÷ (slPoints × 100). XAU: 1 std lot = 100 oz.

describe("calcLotSize", () => {
  it("risking 1% of $10,000 with $15 SL distance = 0.067 lots", () => {
    const lots = calcLotSize(10_000, 1, 15);
    expect(lots).toBeCloseTo(100 / (15 * 100), 3);
  });

  it("returns 0 when SL distance is 0", () => {
    expect(calcLotSize(10_000, 1, 0)).toBe(0);
  });
});
