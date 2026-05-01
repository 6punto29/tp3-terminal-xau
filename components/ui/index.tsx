// ─────────────────────────────────────────────────────────────────────────────
// components/ui/index.tsx
// Shared design-system primitives.
// Import from here in both LiveTerminal and BacktestLaboratory.
// ─────────────────────────────────────────────────────────────────────────────

"use client";

import React from "react";

// ── Design tokens (single source of truth) ───────────────────────────────────
export const T = {
  bg:     "#0B0D11", s1: "#131620", s2: "#1A1E2E", s3: "#232840", s4: "#2A3050",
  border: "rgba(255,255,255,0.06)", border2: "rgba(255,255,255,0.12)",
  up:     "#00C896", down: "#FF3B5C", wait: "#FFB340",
  accent: "#3D8EFF", gold: "#D4AF37",
  text:   "#E2E8F4", muted: "#5A6478", dim: "#3A4260",
  upBg:     "rgba(0,200,150,0.08)",
  dnBg:     "rgba(255,59,92,0.08)",
  upBorder: "rgba(0,200,150,0.20)",
  dnBorder: "rgba(255,59,92,0.18)",
  warnBg:     "rgba(255,179,64,0.08)",
  warnBorder: "rgba(255,179,64,0.20)",
} as const;

export const MONO = "'JetBrains Mono','Fira Code',monospace";
export const SANS = "'Inter',-apple-system,sans-serif";

// ── Color helpers ─────────────────────────────────────────────────────────────
export const evColor  = (ev:  number) => ev  >= 1.2 ? T.up   : ev  >= 0.5 ? T.wait : T.down;
export const wrColor  = (wr:  number) => wr  >= 55  ? T.up   : wr  >= 50  ? T.wait : T.muted;
export const pnlColor = (pnl: number) => pnl >= 0   ? T.up   : T.down;
export const fmtPct   = (v: number, decimals = 2) =>
  `${v >= 0 ? "+" : ""}${v.toFixed(decimals)}%`;

// ── Card ──────────────────────────────────────────────────────────────────────
export const BtCard = ({
  children, style,
}: { children: React.ReactNode; style?: React.CSSProperties }) => (
  <div style={{
    background: T.s1, borderRadius: 8, border: `1px solid ${T.border}`,
    padding: "12px 14px", marginBottom: 6, ...style,
  }}>{children}</div>
);

// ── Section title ─────────────────────────────────────────────────────────────
export const SecTitle = ({ children }: { children: React.ReactNode }) => (
  <div style={{
    fontFamily: SANS, fontSize: 9, fontWeight: 700,
    letterSpacing: "0.1em", textTransform: "uppercase",
    color: T.muted, marginBottom: 7,
  }}>{children}</div>
);

// ── Pill selector button ──────────────────────────────────────────────────────
export const SelBtn = ({
  active, onClick, children, accentColor, style,
}: {
  active:       boolean;
  onClick:      () => void;
  children:     React.ReactNode;
  accentColor?: string;
  style?:       React.CSSProperties;
}) => {
  const ac = accentColor ?? T.accent;
  return (
    <button onClick={onClick} style={{
      fontFamily: SANS, fontSize: 9, fontWeight: 700,
      padding: "3px 10px", borderRadius: 20, cursor: "pointer",
      border: `1px solid ${active ? ac : T.border2}`,
      background: active ? (accentColor ? `${ac}22` : ac) : T.s2,
      color:  active ? ac : T.muted,
      transition: "all .15s",
      ...style,
    }}>{children}</button>
  );
};

// ── SL/TP colour-tinted selector button ──────────────────────────────────────
export const SlTpBtn = ({
  active, onClick, children, color,
}: {
  active:   boolean;
  onClick:  () => void;
  children: React.ReactNode;
  color:    string;
}) => (
  <button onClick={onClick} style={{
    fontFamily: SANS, fontSize: 9, fontWeight: 700,
    padding: "3px 10px", borderRadius: 20, cursor: "pointer",
    border: `1px solid ${active ? color : T.border}`,
    background: active ? `${color}22` : T.s2,
    color: active ? color : T.muted,
    transition: "all .15s",
  }}>{children}</button>
);

// ── Gold run button ───────────────────────────────────────────────────────────
export const RunBtn = ({
  onClick, disabled, children,
}: {
  onClick:  () => void;
  disabled: boolean;
  children: React.ReactNode;
}) => (
  <button onClick={onClick} disabled={disabled} style={{
    fontFamily: SANS, fontSize: 10, fontWeight: 700,
    padding: "5px 16px", borderRadius: 20, border: "none",
    background: `linear-gradient(135deg, ${T.gold}, #E8C84B)`,
    color: "#1D1D1F",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.4 : 1,
    whiteSpace: "nowrap", transition: "opacity .15s",
  }}>{children}</button>
);

// ── Progress bar ──────────────────────────────────────────────────────────────
export const Progress = ({
  pct, show,
}: { pct: number; show: boolean }) =>
  show ? (
    <div style={{
      height: 3, background: T.s3, borderRadius: 3,
      marginBottom: 6, overflow: "hidden",
    }}>
      <div style={{
        height: "100%", width: `${Math.min(pct, 100)}%`,
        background: T.accent, borderRadius: 3, transition: "width .25s",
      }} />
    </div>
  ) : null;

// ── Status line ───────────────────────────────────────────────────────────────
export const StatusLine = ({ msg }: { msg: string }) =>
  msg ? (
    <div style={{
      fontFamily: SANS, fontSize: 9, color: T.muted,
      marginBottom: 6, lineHeight: 1.4,
    }}>{msg}</div>
  ) : null;

// ── Table header cell ─────────────────────────────────────────────────────────
export const Th = ({
  children, left,
}: { children: React.ReactNode; left?: boolean }) => (
  <th style={{
    padding: "3px 5px", textAlign: left ? "left" : "center",
    fontFamily: SANS, fontSize: 7, fontWeight: 700,
    color: T.muted, letterSpacing: ".06em", textTransform: "uppercase",
  }}>{children}</th>
);

// ── Vertical separator ────────────────────────────────────────────────────────
export const VSep = () => (
  <span style={{
    width: 1, background: T.border, margin: "0 4px",
    alignSelf: "stretch", display: "inline-block",
  }} />
);

// ── Inline badge ──────────────────────────────────────────────────────────────
export const Badge = ({
  children, color,
}: { children: React.ReactNode; color: string }) => (
  <span style={{
    fontFamily: MONO, fontSize: 9, fontWeight: 700,
    padding: "2px 8px", borderRadius: 20,
    background: `${color}18`, color,
    border: `1px solid ${color}30`,
  }}>{children}</span>
);

// ── Metric stat card ──────────────────────────────────────────────────────────
export const StatCard = ({
  label, value, color,
}: { label: string; value: React.ReactNode; color?: string }) => (
  <div style={{
    background: T.s2, borderRadius: 6, padding: "8px 10px", textAlign: "center",
  }}>
    <div style={{
      fontFamily: SANS, fontSize: 8, fontWeight: 700,
      letterSpacing: "0.06em", textTransform: "uppercase",
      color: T.muted, marginBottom: 4,
    }}>{label}</div>
    <div style={{
      fontFamily: MONO, fontSize: 18, fontWeight: 700,
      color: color ?? T.text,
    }}>{value}</div>
  </div>
);

// ── Canvas equity curve ───────────────────────────────────────────────────────
interface Trade { pct: number; won: boolean }

export function EquityCurve({ trades }: { trades: Trade[] }) {
  const ref = React.useRef<HTMLCanvasElement>(null);

  React.useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !trades.length) return;
    const ctx = canvas.getContext("2d")!;
    const W = canvas.offsetWidth || 500;
    const H = canvas.offsetHeight || 80;
    canvas.width = W; canvas.height = H;
    ctx.clearRect(0, 0, W, H);

    let eq = 0;
    const pts = [{ x: 0, eq: 0 }];
    trades.forEach((t, i) => {
      eq += t.pct;
      pts.push({ x: ((i + 1) / trades.length) * W, eq });
    });

    const maxEq  = Math.max(...pts.map((p) => p.eq)) || 1;
    const minEq  = Math.min(...pts.map((p) => p.eq));
    const range  = (maxEq - minEq) || 1;
    const toY    = (v: number) => H - ((v - minEq) / range * (H - 10) + 5);
    const lastEq = pts[pts.length - 1].eq;
    const line   = lastEq >= 0 ? T.up : T.down;

    // Grid
    ctx.strokeStyle = "rgba(255,255,255,0.04)"; ctx.lineWidth = 1;
    [0, 0.25, 0.5, 0.75, 1].forEach((r) => {
      ctx.beginPath(); ctx.moveTo(0, r * H); ctx.lineTo(W, r * H); ctx.stroke();
    });

    // Zero line
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(0, toY(0)); ctx.lineTo(W, toY(0)); ctx.stroke();
    ctx.setLineDash([]);

    // Fill
    ctx.fillStyle = lastEq >= 0
      ? "rgba(0,200,150,0.10)"
      : "rgba(255,59,92,0.10)";
    ctx.beginPath();
    pts.forEach((p, i) =>
      i === 0 ? ctx.moveTo(p.x, toY(p.eq)) : ctx.lineTo(p.x, toY(p.eq))
    );
    ctx.lineTo(W, toY(0)); ctx.lineTo(0, toY(0));
    ctx.closePath(); ctx.fill();

    // Line
    ctx.strokeStyle = line; ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach((p, i) =>
      i === 0 ? ctx.moveTo(p.x, toY(p.eq)) : ctx.lineTo(p.x, toY(p.eq))
    );
    ctx.stroke();
  }, [trades]);

  return (
    <canvas ref={ref} style={{ width: "100%", height: "100%", display: "block" }} />
  );
}
