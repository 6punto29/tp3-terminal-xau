"use client";

// ─────────────────────────────────────────────────────────────────────────────
// app/page.tsx
// ─────────────────────────────────────────────────────────────────────────────
import dynamic from "next/dynamic";

const LiveTerminal = dynamic(
  () => import("@/components/LiveTerminal"),
  {
    ssr: false,
    loading: () => (
      <div style={{
        background: "#0B0D11",
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "'JetBrains Mono','Fira Code',monospace",
        fontSize: 13,
        color: "#5A6478",
        letterSpacing: 2,
      }}>
        CARGANDO TERMINAL...
      </div>
    ),
  }
);

export default function HomePage() {
  const userId = "dev-user-001";
  return <LiveTerminal userId={userId} />;
}
