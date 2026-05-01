"use client";
// ─────────────────────────────────────────────────────────────────────────────
// components/NavTabs.tsx
// Topbar navigation. Shared across all pages.
// Reads the pathname to highlight the active tab.
// ─────────────────────────────────────────────────────────────────────────────

import Link from "next/link";
import { usePathname } from "next/navigation";

const T = {
  s1: "#131620", border: "rgba(255,255,255,0.06)", border2: "rgba(255,255,255,0.12)",
  s2: "#1A1E2E", s4: "#2A3050",
  text: "#E2E8F4", muted: "#5A6478", dim: "#3A4260",
  up: "#00C896", accent: "#3D8EFF", gold: "#D4AF37",
};
const MONO = "'JetBrains Mono','Fira Code',monospace";
const SANS = "'Inter',-apple-system,sans-serif";

const TABS = [
  { href: "/",         label: "Terminal",  key: "terminal"  },
  { href: "/backtest", label: "Backtest",  key: "backtest"  },
];

export default function NavTabs() {
  const pathname = usePathname();

  return (
    <header style={{
      position: "sticky", top: 0, zIndex: 100,
      display: "flex", alignItems: "center", justifyContent: "space-between",
      height: 44, padding: "0 16px",
      background: T.s1,
      borderBottom: `1px solid ${T.border}`,
    }}>
      {/* Brand */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{
          width: 7, height: 7, borderRadius: "50%",
          background: T.up,
          boxShadow: "0 0 0 3px rgba(0,200,150,0.15)",
        }} />
        <span style={{ fontFamily: MONO, fontSize: 14, fontWeight: 700,
          letterSpacing: 3, color: T.text }}>TP3</span>
        <span style={{ color: T.dim }}>·</span>
        <span style={{ fontFamily: SANS, fontSize: 12, color: T.muted }}>XAU/USD</span>
      </div>

      {/* Tabs */}
      <nav style={{
        display: "flex", gap: 1,
        background: T.s2, borderRadius: 6,
        padding: 2, border: `1px solid ${T.border}`,
      }}>
        {TABS.map(({ href, label }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link key={href} href={href} style={{ textDecoration: "none" }}>
              <span style={{
                display: "block",
                fontFamily: SANS, fontSize: 12, fontWeight: active ? 700 : 500,
                padding: "5px 16px", borderRadius: 5,
                background: active ? T.s4 : "transparent",
                color: active ? T.text : T.muted,
                transition: "all .15s",
                cursor: "pointer",
              }}>{label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Right slot — version badge */}
      <div style={{
        fontFamily: MONO, fontSize: 9, color: T.muted,
        border: `1px solid ${T.border2}`, borderRadius: 4,
        padding: "2px 8px", letterSpacing: "0.05em",
      }}>
        v2.0 · QUANT
      </div>
    </header>
  );
}
