// ─────────────────────────────────────────────────────────────────────────────
// app/api/klines/route.ts
// GET /api/klines?symbol=XAUUSDT&interval=1h&limit=1500&endTime=...
//
// Proxy for Binance Futures klines. Avoids CORS issues in production.
// The BacktestLaboratory client calls /api/klines instead of Binance directly.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";

const BINANCE = "https://fapi.binance.com/fapi/v1/klines";
const ALLOWED_SYMBOLS = new Set(["XAUUSDT", "BTCUSDT", "ETHUSDT"]);

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const symbol   = (searchParams.get("symbol")   ?? "XAUUSDT").toUpperCase();
  const interval = searchParams.get("interval")  ?? "1h";
  const limit    = searchParams.get("limit")     ?? "1500";
  const endTime  = searchParams.get("endTime");

  if (!ALLOWED_SYMBOLS.has(symbol))
    return NextResponse.json({ error: "Symbol not allowed" }, { status: 400 });

  const params = new URLSearchParams({ symbol, interval, limit });
  if (endTime) params.set("endTime", endTime);

  try {
    const upstream = await fetch(`${BINANCE}?${params}`, {
      next: { revalidate: 30 },
    });

    if (!upstream.ok)
      return NextResponse.json(
        { error: `Binance error ${upstream.status}` },
        { status: upstream.status }
      );

    const data = await upstream.json();
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Upstream error";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
