// ─────────────────────────────────────────────────────────────────────────────
// __tests__/engine/simulator.test.ts
// Unit tests for the engine. Run with: bun test  (or vitest / jest)
// Zero network calls. Zero framework. Pure math.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { simulateSignals, summarize, calcEV, calcOpLevels, calcLotSize } from "@/lib/engine/simulator";
import type { RawSignal } from "@/lib/engine/types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSignal(
  sig: "UP" | "DOWN",
  entry: number,
  futurePcts: number[]   // future candle moves as % of entry
): RawSignal {
  return {
    sig, entry, date: "01/01",
    htfFuture: futurePcts.map((pct) => {
      const c = entry * (1 + pct / 100);
      return { t: 0, o: c, h: c * 1.001, l: c * 0.999, c, v: 1000 };
    }),
  };
}

// ── calcEV ────────────────────────────────────────────────────────────────────

describe("calcEV", () => {
  it("returns positive EV for 57% WR and 4:1 R:R", () => {
    const ev = calcEV(57, 4);
    expect(ev).toBeGreaterThan(1);
  });

  it("returns near-zero EV at break-even point (50% WR, 1:1 R:R)", () => {
    const ev = calcEV(50, 1);
    expect(Math.abs(ev)).toBeLessThan(0.01);
  });

  it("returns negative EV for 40% WR and 1:1 R:R", () => {
    expect(calcEV(40, 1)).toBeLessThan(0);
  });
});

// ── simulateSignals ───────────────────────────────────────────────────────────

describe("simulateSignals", () => {
  it("hits TP when price reaches TP level", () => {
    const sig = makeSignal("UP", 3000, [2.0]); // price goes +2% → hits TP at +1.5%
    const [trade] = simulateSignals([sig], 0.01, 0.015, 3);
    expect(trade.hitTP).toBe(true);
    expect(trade.won).toBe(true);
  });

  it("hits SL when price drops to SL level", () => {
    const sig = makeSignal("UP", 3000, [-1.5]); // price drops to SL
    const [trade] = simulateSignals([sig], 0.01, 0.04, 3);
    expect(trade.hitSL).toBe(true);
    expect(trade.won).toBe(false);
  });

  it("closes by time when neither SL nor TP is hit", () => {
    const sig = makeSignal("UP", 3000, [0.1, 0.2, 0.3]); // small moves, hold expires
    const [trade] = simulateSignals([sig], 0.02, 0.06, 3);
    expect(trade.hitTP).toBe(false);
    expect(trade.hitSL).toBe(false);
    expect(typeof trade.pct).toBe("number");
  });
});

// ── summarize ─────────────────────────────────────────────────────────────────

describe("summarize", () => {
  it("computes WR correctly from 3 wins, 2 losses", () => {
    const trades = [
      { ...makeSignal("UP", 3000, []), won: true,  pct:  4, hitTP: true,  hitSL: false },
      { ...makeSignal("UP", 3000, []), won: true,  pct:  4, hitTP: true,  hitSL: false },
      { ...makeSignal("UP", 3000, []), won: true,  pct:  4, hitTP: true,  hitSL: false },
      { ...makeSignal("UP", 3000, []), won: false, pct: -1.5, hitTP: false, hitSL: true },
      { ...makeSignal("UP", 3000, []), won: false, pct: -1.5, hitTP: false, hitSL: true },
    ];
    const s = summarize(trades);
    expect(s?.wr).toBe(60);
    expect(s?.total).toBe(5);
    expect(s?.wins).toBe(3);
    expect(s?.pnl).toBeCloseTo(4 * 3 + (-1.5) * 2, 5);
  });

  it("returns null for empty trade array", () => {
    expect(summarize([])).toBeNull();
  });
});

// ── calcOpLevels ──────────────────────────────────────────────────────────────

describe("calcOpLevels", () => {
  it("LONG: SL below entry, TP above entry", () => {
    const { sl, tp } = calcOpLevels(3000, "LONG", 0.015, 0.04);
    expect(sl).toBeLessThan(3000);
    expect(tp).toBeGreaterThan(3000);
  });

  it("SHORT: SL above entry, TP below entry", () => {
    const { sl, tp } = calcOpLevels(3000, "SHORT", 0.015, 0.04);
    expect(sl).toBeGreaterThan(3000);
    expect(tp).toBeLessThan(3000);
  });

  it("R:R equals TP% / SL% for default params", () => {
    const { rr } = calcOpLevels(3000, "LONG", 0.015, 0.04);
    expect(rr).toBeCloseTo(0.04 / 0.015, 2);
  });
});

// ── calcLotSize ───────────────────────────────────────────────────────────────

describe("calcLotSize", () => {
  it("risking 1% of $10,000 with $15 SL distance = 0.067 lots", () => {
    const lots = calcLotSize(10_000, 1, 15);
    expect(lots).toBeCloseTo(100 / (15 * 100), 3);
  });

  it("returns 0 when SL distance is 0", () => {
    expect(calcLotSize(10_000, 1, 0)).toBe(0);
  });
});
