// ─────────────────────────────────────────────────────────────────────────────
// app/api/klines/route.ts
// GET /api/klines?symbol=XAUUSDT&interval=1h&limit=1500&endTime=...
//
// Proxy for Binance SPOT klines. XAUUSDT only exists on Spot, not Futures.
// Region set to Frankfurt (fra1) to avoid Binance 451 block from US servers.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";

// Force this function to run in Frankfurt (EU) — Binance blocks US IPs (451)
export const preferredRegion = "fra1";
export const runtime = "edge";

const BINANCE = "https://api.binance.com/api/v3/klines";
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
    const upstream = await fetch(`${BINANCE}?${params}`);

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
