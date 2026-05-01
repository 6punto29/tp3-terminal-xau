// ─────────────────────────────────────────────────────────────────────────────
// lib/agent/tools/run_backtest.ts
// AI agent tool: runs a backtest and returns results.
// Used by the AI agent in app/api/agent/route.ts.
// ─────────────────────────────────────────────────────────────────────────────

import { precompute }    from "@/lib/engine/indicators";
import { detectSignals } from "@/lib/engine/signals";
import { simulateSignals, summarize, calcEV } from "@/lib/engine/simulator";
import { BacktestConfig, BacktestResult, Candle, AgentTool } from "@/lib/engine/types";

// Fetch candles — reused from API route logic
async function fetchCandles(tf: string): Promise<Candle[]> {
  const BINANCE = "https://fapi.binance.com/fapi/v1/klines";
  let all: number[][] = [];
  const r = await fetch(`${BINANCE}?symbol=XAUUSDT&interval=${tf}&limit=1500`);
  const d = await r.json() as number[][];
  if (!Array.isArray(d)) return [];
  all = d;
  for (let p = 0; p < 3; p++) {
    const oldest = all[0][0];
    const rp = await fetch(`${BINANCE}?symbol=XAUUSDT&interval=${tf}&limit=1500&endTime=${oldest - 1}`);
    const dp = await rp.json() as number[][];
    if (!Array.isArray(dp) || !dp.length) break;
    all = [...dp, ...all];
    if (dp.length < 100) break;
  }
  return all.map((k) => ({ t:+k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5] })).slice(0,-1);
}

export const runBacktestTool: AgentTool<BacktestConfig, BacktestResult | { error: string }> = {
  name:        "run_backtest",
  description: "Run a backtestson XAU/USD with given HTF/MTF config and SL/TP parameters. Returns WR, EV, P&L and trade log.",
  inputSchema: {
    type: "object",
    properties: {
      htf:          { type: "string", enum: ["1h","4h"]     },
      mtf:          { type: "string", enum: ["15m","1h"]    },
      hold:         { type: "number", enum: [3, 6, 12]      },
      slPct:        { type: "number", minimum: 0.003, maximum: 0.03 },
      tpPct:        { type: "number", minimum: 0.01,  maximum: 0.06 },
      sessionFilter: { type: "boolean" },
      ema200Filter:  { type: "boolean" },
    },
    required: ["htf","mtf","hold","slPct","tpPct"],
  },
  run: async (cfg: BacktestConfig) => {
    try {
      const [htfC, mtfC] = await Promise.all([
        fetchCandles(cfg.htf), fetchCandles(cfg.mtf),
      ]);
      const htfInd = precompute(htfC);
      const mtfInd = precompute(mtfC);
      const signals = detectSignals(htfC, mtfC, htfInd, mtfInd, {
        holdCandles: cfg.hold,
        sessionFilter: cfg.sessionFilter ?? false,
        ema200Filter:  cfg.ema200Filter  ?? false,
      });
      const trades  = simulateSignals(signals, cfg.slPct, cfg.tpPct, cfg.hold);
      const summary = summarize(trades);
      const rr      = cfg.tpPct / cfg.slPct;
      const ev      = summary ? calcEV(summary.wr, rr) : 0;
      return {
        config: cfg,
        summary: { ...summary!, rr, ev },
        trades: trades.slice(-20),
        htfLen: htfC.length,
        label: `${cfg.htf.toUpperCase()}+${cfg.mtf.toUpperCase()} H${cfg.hold}`,
      } as BacktestResult;
    } catch (e) {
      return { error: e instanceof Error ? e.message : "Unknown error" };
    }
  },
};
