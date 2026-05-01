// ─────────────────────────────────────────────────────────────────────────────
// app/backtest/page.tsx
// Backtest Laboratory route.
// Server component shell — BacktestLaboratory is a Client Component.
// ─────────────────────────────────────────────────────────────────────────────

import BacktestLaboratory from "@/components/BacktestLaboratory";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "TP3 · Backtest Laboratory",
};

export default function BacktestPage() {
  return <BacktestLaboratory />;
}
