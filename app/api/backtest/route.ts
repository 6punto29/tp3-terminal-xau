// ─────────────────────────────────────────────────────────────────────────────
// app/api/backtest/route.ts
// POST /api/backtest
// Body: BacktestConfig
// Response: BacktestResult
//
// The engine runs server-side. The UI never calls Binance directly in prod.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { precompute }      from "@/lib/engine/indicators";
import { detectSignals }   from "@/lib/engine/signals";
import { simulateSignals, summarize, calcEV } from "@/lib/engine/simulator";
import { BacktestConfig, BacktestResult, Candle } from "@/lib/engine/types";


const BINANCE = "https://fapi.binance.com/fapi/v1/klines";
const SYMBOL  = "XAUUSDT";

async function fetchCandles(tf: string): Promise<Candle[]> {
  let all: number[][] = [];

  const r = await fetch(
    `${BINANCE}?symbol=${SYMBOL}&interval=${tf}&limit=1500`,
    { next: { revalidate: 60 } }   // cache 60s in Next.js
  );
  const d = await r.json() as number[][];
  if (!Array.isArray(d) || !d.length) return [];
  all = d;

  for (let p = 0; p < 4; p++) {
    const oldest = all[0][0];
    const rp = await fetch(
      `${BINANCE}?symbol=${SYMBOL}&interval=${tf}&limit=1500&endTime=${oldest - 1}`,
      { next: { revalidate: 60 } }
    );
    const dp = await rp.json() as number[][];
    if (!Array.isArray(dp) || !dp.length) break;
    all = [...dp, ...all];
    if (dp.length < 100) break;
  }

  return all
    .map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }))
    .slice(0, -1); // drop open candle
}

export async function POST(req: NextRequest) {
  try {
    const cfg = (await req.json()) as BacktestConfig;

    const [htfCandles, mtfCandles] = await Promise.all([
      fetchCandles(cfg.htf),
      fetchCandles(cfg.mtf),
    ]);

    if (!htfCandles.length)
      return NextResponse.json({ error: "No data from Binance" }, { status: 502 });

    const htfInd = precompute(htfCandles);
    const mtfInd = precompute(mtfCandles);

    const signals = detectSignals(htfCandles, mtfCandles, htfInd, mtfInd, {
      holdCandles:    cfg.hold,
      sessionFilter:  cfg.sessionFilter,
      ema200Filter:   cfg.ema200Filter,
    });

    const trades  = simulateSignals(signals, cfg.slPct, cfg.tpPct, cfg.hold);
    const summary = summarize(trades);
    const rr      = cfg.tpPct / cfg.slPct;
    const ev      = summary ? calcEV(summary.wr, rr) : 0;

    const result: BacktestResult = {
      config:  cfg,
      summary: { ...summary!, rr, ev },
      trades:  trades.slice(-50),   // last 50 for the log
      htfLen:  htfCandles.length,
      label:   `${cfg.htf.toUpperCase()}+${cfg.mtf.toUpperCase()} H${cfg.hold}`,
    };

    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
