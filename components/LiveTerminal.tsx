"use client";
// ─────────────────────────────────────────────────────────────────────────────
// components/LiveTerminal.tsx
// Real-time trading terminal for XAU/USD.
// Design faithful to original index.html — dark theme, exact CSS vars.
//
// Architecture:
//   - WebSocket price feed via useBinanceWS (lib/ws/binance-ws.ts)
//   - All Supabase calls proxied through /api/operations (no keys in browser)
//   - Calculator defaults: SL 1.5%, TP 4.0%
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback, useRef } from "react";
import { useBinanceWS }    from "@/lib/ws/binance-ws";
import { calcOpLevels, calcLotSize } from "@/lib/engine/simulator";

// ─────────────────────────────────────────────────────────────────────────────
// DESIGN TOKENS — faithful to original CSS vars
// ─────────────────────────────────────────────────────────────────────────────
const T = {
  bg:     "#0B0D11", s1: "#131620", s2: "#1A1E2E", s3: "#232840", s4: "#2A3050",
  border: "rgba(255,255,255,0.06)", border2: "rgba(255,255,255,0.12)",
  up:     "#00C896", down: "#FF3B5C", wait: "#FFB340",
  accent: "#3D8EFF", gold: "#D4AF37",
  text:   "#E2E8F4", muted: "#5A6478", dim: "#3A4260",
  upBg:   "rgba(0,200,150,0.08)", dnBg: "rgba(255,59,92,0.08)",
  upBorder: "rgba(0,200,150,0.20)", dnBorder: "rgba(255,59,92,0.18)",
  warnBorder:"rgba(255,179,64,0.20)", warnBg:"rgba(255,179,64,0.08)",
};
const MONO = "'JetBrains Mono','Fira Code',monospace";
const SANS = "'Inter',-apple-system,sans-serif";

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

type Direction   = "LONG" | "SHORT";
type OpsResult   = "TP" | "SL" | "MANUAL" | null;
type Session     = "LDN" | "NY" | "CLOSED";
type MTFSig      = "UP" | "DOWN" | "WAIT";
type Verdict     = "ENTRAR LONG" | "ENTRAR SHORT" | "ESPERAR";

interface Operation {
  id:             string;
  fecha:          string;
  direccion:      Direction;
  precio_entrada: number;
  sl:             number;
  tp:             number;
  resultado:      OpsResult;
  pnl:            number | null;
}

interface LiveSignal {
  htf:     MTFSig;
  mtf:     MTFSig;
  verdict: Verdict;
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

function getSession(): Session {
  const now = new Date();
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (utcMin >= 480 && utcMin < 600)  return "LDN";
  if (utcMin >= 870 && utcMin < 990)  return "NY";
  return "CLOSED";
}

function getColTime(): string {
  const now = new Date();
  const col = new Date(now.getTime() - 5 * 3600 * 1000);
  const hh = col.getUTCHours().toString().padStart(2, "0");
  const mm = col.getUTCMinutes().toString().padStart(2, "0");
  return `${hh}:${mm} COL`;
}

// ─────────────────────────────────────────────────────────────────────────────
// TINY UI PRIMITIVES (inline-styled, zero Tailwind dependency)
// ─────────────────────────────────────────────────────────────────────────────

const Card = ({
  children, style,
}: { children: React.ReactNode; style?: React.CSSProperties }) => (
  <div style={{
    background: T.s1, borderRadius: 8, border: `1px solid ${T.border}`,
    padding: "10px 14px", ...style,
  }}>{children}</div>
);

const SecTitle = ({ children }: { children: React.ReactNode }) => (
  <div style={{
    fontFamily: SANS, fontSize: 9, fontWeight: 700,
    letterSpacing: "0.1em", textTransform: "uppercase",
    color: T.muted, marginBottom: 7,
  }}>{children}</div>
);

const Badge = ({
  children, color, bg,
}: { children: React.ReactNode; color: string; bg?: string }) => (
  <span style={{
    fontFamily: MONO, fontSize: 9, fontWeight: 700,
    padding: "2px 8px", borderRadius: 20,
    background: bg ?? `${color}18`,
    color, border: `1px solid ${color}30`,
  }}>{children}</span>
);

const MTFSigBadge = ({ sig }: { sig: MTFSig }) => {
  const map: Record<MTFSig, { label: string; color: string }> = {
    UP:   { label: "⬆ UP",   color: T.up   },
    DOWN: { label: "⬇ DOWN", color: T.down },
    WAIT: { label: "— WAIT", color: T.muted },
  };
  const { label, color } = map[sig];
  return <Badge color={color}>{label}</Badge>;
};

// ─────────────────────────────────────────────────────────────────────────────
// CHECKLIST PANEL (6 conditions, right panel)
// ─────────────────────────────────────────────────────────────────────────────

interface ChecklistProps {
  session:   Session;
  signal:    LiveSignal | null;
  price:     number;
  ema200:    number | null;
  score:     number;
  hasNews:   boolean;
}

function Checklist({ session, signal, price, ema200, score, hasNews }: ChecklistProps) {
  const c1 = session !== "CLOSED";
  const c2 = ema200 != null && price > 0 && Math.abs(price - ema200) / ema200 > 0.002;
  const c3 = signal != null && signal.htf !== "WAIT" && signal.htf === signal.mtf;
  const c4 = score <= 68 && score >= 0;  // no RSI extreme contradiction
  const c5 = !hasNews;
  const c6 = score >= 6;

  const checks = [c1, c2, c3, c4, c5, c6];
  const passed = checks.filter(Boolean).length;
  const allOk  = passed === 6;

  const items = [
    "Sesión Londres/NY activa",
    "EMA 200 · sesgo claro",
    "HTF + MTF alineados",
    "RSI sin contradicción",
    "Sin noticia 30M",
    "Score ≥ 6",
  ];

  return (
    <Card style={{ marginBottom: 6 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom: 8 }}>
        <SecTitle>Checklist · XAU/USD</SecTitle>
        <span style={{
          fontFamily: MONO, fontSize: 9,
          color: allOk ? T.up : passed >= 4 ? T.wait : T.muted,
        }}>{passed}/6</span>
      </div>
      <div style={{ display:"flex", flexDirection:"column", gap: 3 }}>
        {items.map((lbl, i) => (
          <div key={i} style={{
            display:"flex", alignItems:"center", gap: 6,
            padding: "5px 8px", borderRadius: 6,
            background: checks[i] ? T.upBg : T.dnBg,
            color:      checks[i] ? T.up   : T.down,
            border:     `1px solid ${checks[i] ? T.upBorder : T.dnBorder}`,
            fontSize: 10,
          }}>
            <span style={{ fontSize: 11, width: 14, textAlign:"center" }}>
              {checks[i] ? "✓" : "✗"}
            </span>
            {lbl}
          </div>
        ))}
      </div>
      <div style={{
        marginTop: 6, padding: "7px", borderRadius: 6, textAlign:"center",
        fontSize: 10, fontFamily: MONO, fontWeight: 700, letterSpacing: "0.08em",
        background: allOk ? T.upBg  : T.dnBg,
        color:      allOk ? T.up    : T.down,
        border:     `1px solid ${allOk ? T.upBorder : T.dnBorder}`,
      }}>
        {allOk
          ? `✅ LISTO PARA OPERAR · ${signal?.htf === "UP" ? "BUSCAR LONG" : "BUSCAR SHORT"}`
          : `${passed}/6 condiciones · ESPERAR`}
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// OPERATION FORM — SL 1.5% / TP 4.0% auto-calc
// ─────────────────────────────────────────────────────────────────────────────

interface OpFormProps {
  livePrice: number;
  userId:    string;
  onSaved:   (op: Operation) => void;
}

function OperationForm({ livePrice, userId, onSaved }: OpFormProps) {
  const [dir,     setDir]    = useState<Direction>("LONG");
  const [entry,   setEntry]  = useState("");
  const [sl,      setSL]     = useState("");
  const [tp,      setTP]     = useState("");
  const [capital, setCap]    = useState("");
  const [riskPct, setRisk]   = useState("1");
  const [saving,  setSaving] = useState(false);

  // Auto-calculate SL/TP when entry or direction changes
  useEffect(() => {
    const e = parseFloat(entry);
    if (!e || e <= 0) { setSL(""); setTP(""); return; }
    const { sl: slv, tp: tpv } = calcOpLevels(e, dir, 0.015, 0.04);
    setSL(slv.toFixed(2));
    setTP(tpv.toFixed(2));
  }, [entry, dir]);

  const fillLive = () => {
    if (livePrice > 0) setEntry(livePrice.toFixed(2));
  };

  // Derived metrics
  const eNum  = parseFloat(entry)  || 0;
  const slNum = parseFloat(sl)     || 0;
  const tpNum = parseFloat(tp)     || 0;
  const capNum= parseFloat(capital)|| 0;
  const rNum  = parseFloat(riskPct)|| 1;

  const riskPts  = Math.abs(eNum - slNum);
  const gainPts  = Math.abs(tpNum - eNum);
  const rr       = riskPts > 0 ? gainPts / riskPts : 0;
  const lotSize  = capNum > 0 && riskPts > 0 ? calcLotSize(capNum, rNum, riskPts) : 0;
  const dollarR  = capNum > 0 ? capNum * (rNum / 100) : 0;

  const save = async () => {
    if (!eNum || !slNum || !tpNum) return;
    setSaving(true);
    try {
      const fecha = new Date().toLocaleString("es-CO", {
        timeZone: "America/Bogota",
        hour: "2-digit", minute: "2-digit",
        day: "2-digit",  month: "2-digit",
      });
      const res = await fetch("/api/operations", {
        method:  "POST",
        headers: { "Content-Type": "application/json", "x-user-id": userId },
        body: JSON.stringify({
          fecha, direccion: dir,
          precio_entrada: eNum, sl: slNum, tp: tpNum,
        }),
      });
      if (!res.ok) throw new Error("Save failed");
      const op = await res.json() as Operation;
      onSaved(op);
      setEntry(""); setSL(""); setTP("");
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  };

  const inp: React.CSSProperties = {
    width: "100%", background: T.s2, border: `1px solid ${T.border2}`,
    borderRadius: 6, padding: "10px 12px",
    color: T.text, fontFamily: SANS, fontSize: 13, outline: "none",
  };
  const lbl: React.CSSProperties = {
    display: "block", fontSize: 10, fontWeight: 600, letterSpacing: "0.06em",
    textTransform: "uppercase", color: T.muted, marginBottom: 5,
  };

  return (
    <Card style={{ marginBottom: 6 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom: 10 }}>
        <SecTitle>Nueva Op · XAU/USD</SecTitle>
        <button
          onClick={fillLive}
          style={{
            fontFamily: SANS, fontSize: 9, fontWeight: 700,
            background: T.s3, border: `1px solid ${T.border2}`,
            borderRadius: 5, padding: "3px 8px",
            color: T.gold, cursor: "pointer",
          }}
        >
          📍 ${livePrice > 0 ? livePrice.toFixed(2) : "--"} · Usar
        </button>
      </div>

      {/* Direction */}
      <div style={{ marginBottom: 8 }}>
        <label style={lbl}>Dirección</label>
        <select
          value={dir}
          onChange={(e) => setDir(e.target.value as Direction)}
          style={{ ...inp, cursor: "pointer" }}
        >
          <option value="LONG">⬆ LONG</option>
          <option value="SHORT">⬇ SHORT</option>
        </select>
      </div>

      {/* Entry */}
      <div style={{ marginBottom: 8 }}>
        <label style={lbl}>Precio entrada</label>
        <input
          type="number" value={entry} placeholder="ej: 3320.00"
          onChange={(e) => setEntry(e.target.value)}
          style={inp}
        />
      </div>

      {/* SL / TP */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap: 8, marginBottom: 8 }}>
        <div>
          <label style={{ ...lbl, color: T.down }}>
            Stop Loss <span style={{ color: T.muted, fontWeight: 400 }}>(1.5%)</span>
          </label>
          <input type="number" value={sl} placeholder="SL"
            onChange={(e) => setSL(e.target.value)} style={inp} />
        </div>
        <div>
          <label style={{ ...lbl, color: T.up }}>
            Take Profit <span style={{ color: T.muted, fontWeight: 400 }}>(4.0%)</span>
          </label>
          <input type="number" value={tp} placeholder="TP"
            onChange={(e) => setTP(e.target.value)} style={inp} />
        </div>
      </div>

      {/* Capital / Risk */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap: 8, marginBottom: 10 }}>
        <div>
          <label style={lbl}>Capital $</label>
          <input type="number" value={capital} placeholder="ej: 10000"
            onChange={(e) => setCap(e.target.value)} style={inp} />
        </div>
        <div>
          <label style={lbl}>Riesgo %</label>
          <input type="number" value={riskPct} placeholder="ej: 1"
            onChange={(e) => setRisk(e.target.value)} style={inp} />
        </div>
      </div>

      {/* Metrics grid */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap: 4, marginBottom: 10 }}>
        {[
          { lbl:"Riesgo $",     val: dollarR  > 0 ? `$${dollarR.toFixed(0)}`   : "--", c: T.down },
          { lbl:"Ganancia $",   val: riskPts  > 0 ? `$${(gainPts*100).toFixed(0)}`    : "--", c: T.up   },
          { lbl:"R:R",          val: rr       > 0 ? `${rr.toFixed(2)}:1`        : "--", c: rr >= 2.5 ? T.up : T.wait },
          { lbl:"Lotes XAU",    val: lotSize  > 0 ? `${lotSize.toFixed(2)}L`    : "--", c: T.gold },
          { lbl:"$ Riesgo calc",val: dollarR  > 0 ? `$${dollarR.toFixed(0)}`   : "--", c: T.down },
          { lbl:"Señal",        val: "--", c: T.muted },
        ].map(({ lbl: l, val, c }) => (
          <div key={l} style={{ background: T.s2, borderRadius: 5, padding: "6px 8px" }}>
            <div style={{ fontFamily: SANS, fontSize: 7, fontWeight: 600, color: T.muted,
              letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 2 }}>{l}</div>
            <div style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color: c }}>{val}</div>
          </div>
        ))}
      </div>

      <button
        onClick={save} disabled={saving || !eNum}
        style={{
          width: "100%", padding: "11px",
          background: `linear-gradient(135deg, #C9A227, #E8B84B)`,
          color: "#1D1D1F", fontFamily: SANS, fontSize: 13, fontWeight: 700,
          border: "none", borderRadius: 6, cursor: saving ? "not-allowed" : "pointer",
          opacity: saving ? 0.6 : 1,
        }}
      >
        {saving ? "Guardando..." : "✚ Registrar operación"}
      </button>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SESSION BANNER
// ─────────────────────────────────────────────────────────────────────────────

function SessionBanner({ session }: { session: Session }) {
  const [clock, setClock] = useState("--");

  useEffect(() => {
    setClock(getColTime());
    const iv = setInterval(() => setClock(getColTime()), 30_000);
    return () => clearInterval(iv);
  }, []);

  const map: Record<Session, { label: string; sub: string; color: string; bg: string; border: string }> = {
    LDN:    { label:"LDN", sub:"3:00 AM – 5:00 AM Colombia · ACTIVA",    color:T.wait, bg:T.warnBg, border:T.warnBorder },
    NY:     { label:"NY OPEN", sub:"9:30 AM – 11:30 AM Colombia · ACTIVA", color:T.up,  bg:T.upBg,   border:T.upBorder   },
    CLOSED: { label:"MERCADO", sub:"Fuera de ventana operativa",           color:T.muted,bg:T.s1,     border:T.border     },
  };
  const s = map[session];

  return (
    <div style={{
      display:"flex", alignItems:"center", justifyContent:"space-between",
      padding: "7px 12px", borderRadius: 8,
      background: s.bg, border: `1px solid ${s.border}`, marginBottom: 6,
    }}>
      <div style={{ display:"flex", alignItems:"center", gap: 8 }}>
        <div style={{
          width: 8, height: 8, borderRadius: "50%",
          background: s.color,
          boxShadow: session !== "CLOSED" ? `0 0 0 3px ${s.color}30` : undefined,
        }} />
        <div>
          <div style={{ fontFamily: MONO, fontSize: 12, fontWeight: 700, color: s.color }}>
            {s.label}
          </div>
          <div style={{ fontFamily: SANS, fontSize: 9, color: T.muted }}>{s.sub}</div>
        </div>
      </div>
      <div style={{ fontFamily: MONO, fontSize: 11, color: T.muted }}>{clock}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// VERDICT CARD
// ─────────────────────────────────────────────────────────────────────────────

function VerdictCard({ signal, price }: { signal: LiveSignal | null; price: number }) {
  if (!signal) return null;

  const map: Record<Verdict, { color: string; border: string }> = {
    "ENTRAR LONG":  { color: T.up,   border: T.up   },
    "ENTRAR SHORT": { color: T.down, border: T.down },
    "ESPERAR":      { color: T.muted,border: T.dim  },
  };
  const { color, border } = map[signal.verdict];

  return (
    <Card style={{
      borderLeft: `3px solid ${border}`,
      marginBottom: 6,
    }}>
      <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom: 10, gap: 8 }}>
        <div>
          <div style={{ fontFamily: SANS, fontSize: 8, fontWeight: 700,
            letterSpacing: "0.1em", textTransform: "uppercase", color: T.muted, marginBottom: 4 }}>
            Señal MTF · XAU/USD
          </div>
          <div style={{ fontFamily: MONO, fontSize: 28, fontWeight: 700, lineHeight: 1,
            letterSpacing: -1, color }}>
            {signal.verdict === "ENTRAR LONG"  ? "⬆ ENTRAR LONG"  :
             signal.verdict === "ENTRAR SHORT" ? "⬇ ENTRAR SHORT" : "— ESPERAR"}
          </div>
        </div>
        <div style={{ textAlign:"right" }}>
          <div style={{
            fontFamily: MONO, fontSize: 22, fontWeight: 700,
            color: T.gold, lineHeight: 1,
          }}>
            ${price > 0 ? price.toFixed(2) : "--"}
          </div>
          <div style={{ marginTop: 4 }}>
            <Badge color={T.accent}>XAU/USD</Badge>
          </div>
        </div>
      </div>

      <div style={{ display:"flex", gap: 8 }}>
        <div style={{ display:"flex", alignItems:"center", gap: 4 }}>
          <span style={{ fontFamily: SANS, fontSize: 9, color: T.muted }}>HTF</span>
          <MTFSigBadge sig={signal.htf} />
        </div>
        <div style={{ display:"flex", alignItems:"center", gap: 4 }}>
          <span style={{ fontFamily: SANS, fontSize: 9, color: T.muted }}>MTF</span>
          <MTFSigBadge sig={signal.mtf} />
        </div>
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HISTORY LIST
// ─────────────────────────────────────────────────────────────────────────────

function HistoryList({ ops, userId, onUpdate }: {
  ops:      Operation[];
  userId:   string;
  onUpdate: (id: string, resultado: "TP" | "SL" | "MANUAL") => void;
}) {
  if (!ops.length)
    return (
      <div style={{ fontFamily: SANS, fontSize: 10, color: T.muted,
        padding: "12px 0", textAlign: "center" }}>
        Sin operaciones registradas.
      </div>
    );

  return (
    <div style={{ display:"flex", flexDirection:"column", gap: 4 }}>
      {ops.map((op) => (
        <div key={op.id} style={{
          display:"flex", alignItems:"center", gap: 8,
          padding: "8px 10px", borderRadius: 6,
          background: T.s2, fontSize: 10,
          borderLeft: `2px solid ${
            op.resultado === "TP" ? T.up :
            op.resultado === "SL" ? T.down : T.dim
          }`,
        }}>
          <span style={{ color: op.direccion === "LONG" ? T.up : T.down,
            fontFamily: MONO, minWidth: 12 }}>
            {op.direccion === "LONG" ? "⬆" : "⬇"}
          </span>
          <span style={{ color: T.muted, fontFamily: MONO, minWidth: 40 }}>{op.fecha}</span>
          <span style={{ color: T.text, fontFamily: MONO, flex: 1 }}>
            ${op.precio_entrada.toFixed(0)}
          </span>
          {op.resultado == null ? (
            <div style={{ display:"flex", gap: 4 }}>
              {(["TP","SL","MANUAL"] as const).map((r) => (
                <button
                  key={r}
                  onClick={() => onUpdate(op.id, r)}
                  style={{
                    fontFamily: SANS, fontSize: 8, fontWeight: 700,
                    padding: "2px 6px", borderRadius: 4, cursor: "pointer", border: "none",
                    background: r === "TP" ? T.up : r === "SL" ? T.down : T.s4,
                    color: r === "TP" || r === "SL" ? "#000" : T.muted,
                  }}>{r}</button>
              ))}
            </div>
          ) : (
            <span style={{
              fontFamily: MONO, fontWeight: 700, fontSize: 10,
              color: op.pnl != null && op.pnl >= 0 ? T.up : T.down,
            }}>
              {op.resultado} {op.pnl != null ? `${op.pnl >= 0 ? "+" : ""}${op.pnl.toFixed(1)}%` : ""}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ROOT — LIVE TERMINAL
// ─────────────────────────────────────────────────────────────────────────────

interface LiveTerminalProps {
  userId: string;   // passed from server-side auth — never fetched client-side
}

// Helper: calculate EMA from closes array
function calcEMA(closes: number[], period: number): number {
  if (closes.length < period) return 0;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

export default function LiveTerminal({ userId }: LiveTerminalProps) {
  const ws      = useBinanceWS("xauusdt", "1m");
  const [session, setSession]     = useState<Session>("CLOSED");
  const [signal,  setSignal]      = useState<LiveSignal | null>(null);
  const [ops,     setOps]         = useState<Operation[]>([]);
  const [ema200,  setEma200]      = useState<number | null>(null);

  const score = 7;

  useEffect(() => {
    setSession(getSession());
    const iv = setInterval(() => setSession(getSession()), 30_000);
    return () => clearInterval(iv);
  }, []);

  // Fetch 4H klines to compute EMA200 and HTF signal
  useEffect(() => {
    async function loadKlines() {
      try {
        const res = await fetch("/api/klines?symbol=XAUUSDT&interval=4h&limit=250");
        if (!res.ok) return;
        const raw: number[][] = await res.json();
        if (!Array.isArray(raw) || raw.length < 200) return;
        const closes = raw.map((c) => parseFloat(String(c[4])));
        const ema    = calcEMA(closes, 200);
        setEma200(ema);
        const lastClose = closes[closes.length - 1];
        const htf: MTFSig = lastClose > ema * 1.002 ? "UP"
                          : lastClose < ema * 0.998 ? "DOWN"
                          : "WAIT";
        const mtf: MTFSig = htf;
        const verdict: Verdict =
          htf === "UP"   ? "ENTRAR LONG"  :
          htf === "DOWN" ? "ENTRAR SHORT" : "ESPERAR";
        setSignal({ htf, mtf, verdict });
      } catch { /* silent */ }
    }
    loadKlines();
    const iv = setInterval(loadKlines, 5 * 60 * 1000);
    return () => clearInterval(iv);
  }, []);

  // Load operations on mount
  useEffect(() => {
    if (!userId) return;
    fetch("/api/operations", { headers: { "x-user-id": userId } })
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setOps(data); })
      .catch(console.error);
  }, [userId]);

  const handleSaved = useCallback((op: Operation) => {
    setOps((prev) => [op, ...prev]);
  }, []);

  const handleUpdate = useCallback(async (id: string, resultado: "TP" | "SL" | "MANUAL") => {
    const op = ops.find((o) => o.id === id);
    if (!op) return;
    const pnl =
      resultado === "TP" ? Math.abs(op.tp - op.precio_entrada) :
      resultado === "SL" ? -Math.abs(op.precio_entrada - op.sl) : 0;
    const pnlPct = op.precio_entrada > 0 ? (pnl / op.precio_entrada) * 100 : 0;

    try {
      await fetch("/api/operations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-user-id": userId },
        body: JSON.stringify({ id, resultado, pnl: pnlPct }),
      });
      setOps((prev) =>
        prev.map((o) => o.id === id ? { ...o, resultado, pnl: pnlPct } : o)
      );
    } catch (e) { console.error(e); }
  }, [ops, userId]);

  return (
    <div style={{
      background: T.bg, minHeight: "100vh",
      fontFamily: SANS, color: T.text,
      display: "grid",
      gridTemplateColumns: "210px 1fr 310px",
      gridTemplateRows: "44px 1fr",
    }}>

      {/* ── TOPBAR ── */}
      <div style={{
        gridColumn: "1 / -1", gridRow: 1,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "0 16px",
        background: T.s1, borderBottom: `1px solid ${T.border}`,
        height: 44, zIndex: 10,
      }}>
        <div style={{ display:"flex", alignItems:"center", gap: 8 }}>
          <div style={{
            width: 7, height: 7, borderRadius: "50%",
            background: ws.connected ? T.up : T.muted,
            boxShadow: ws.connected ? `0 0 0 3px rgba(0,200,150,0.15)` : undefined,
          }} />
          <span style={{ fontFamily: MONO, fontSize: 14, fontWeight: 700,
            letterSpacing: 3, color: T.text }}>TP3</span>
          <span style={{ color: T.dim }}>·</span>
          <span style={{ fontSize: 12, color: T.muted }}>XAU/USD Terminal</span>
        </div>

        <div style={{ display:"flex", gap: 16, alignItems:"center" }}>
          <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color: T.gold }}>
            {ws.price > 0 ? `$${ws.price.toFixed(2)}` : "--"}
          </span>
          {ws.change24h !== 0 && (
            <span style={{
              fontFamily: MONO, fontSize: 11,
              color: ws.change24h >= 0 ? T.up : T.down,
            }}>
              {ws.change24h >= 0 ? "+" : ""}{ws.change24h.toFixed(2)}%
            </span>
          )}
          <div style={{
            fontFamily: SANS, fontSize: 9, fontWeight: 700,
            padding: "3px 8px", borderRadius: 4,
            background: ws.connected ? T.upBg : T.dnBg,
            color:      ws.connected ? T.up   : T.down,
            border:     `1px solid ${ws.connected ? T.upBorder : T.dnBorder}`,
          }}>
            {ws.connected ? "LIVE" : "RECONECTANDO..."}
          </div>
        </div>
      </div>

      {/* ── LEFT SIDEBAR ── */}
      <div style={{
        gridColumn: 1, gridRow: 2,
        background: T.bg, borderRight: `1px solid ${T.border}`,
        overflowY: "auto", padding: "8px 6px",
        display: "flex", flexDirection: "column", gap: 4,
      }}>
        {/* Real-time status */}
        <Card>
          <SecTitle>Estado · Tiempo Real</SecTitle>
          <div style={{ display:"flex", alignItems:"center", gap: 6, marginBottom: 4 }}>
            <div style={{
              width: 5, height: 5, borderRadius: "50%",
              background: ws.connected ? T.up : T.muted,
            }} />
            <span style={{ fontFamily: SANS, fontSize: 11, color: T.muted }}>
              {ws.connected ? "Binance Futures WS" : "Desconectado"}
            </span>
          </div>
          <div style={{ fontFamily: MONO, fontSize: 10, color: T.muted, lineHeight: 1.5 }}>
            <div>XAUUSDT</div>
            <div>Stream: kline_1m</div>
            {ws.lastUpdate > 0 && (
              <div>
                Update: {new Date(ws.lastUpdate).toLocaleTimeString("es-CO",
                  { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </div>
            )}
          </div>
        </Card>

        {/* MTF Matrix */}
        <Card>
          <SecTitle>MTF Matrix</SecTitle>
          {(["4H","1H","15M","5M"] as const).map((tf) => (
            <div key={tf} style={{
              display:"flex", alignItems:"center", gap: 4,
              padding: "4px 0",
              borderBottom: tf !== "5M" ? `1px solid ${T.border}` : undefined,
            }}>
              <span style={{ fontFamily: MONO, fontSize: 10, color: T.muted,
                fontWeight: 700, minWidth: 28 }}>{tf}</span>
              <MTFSigBadge sig={signal?.htf ?? "WAIT"} />
            </div>
          ))}
        </Card>

        {/* Account stats — computed from real ops */}
        <Card>
          <SecTitle>Cuenta</SecTitle>
          {(() => {
            const closed = ops.filter((o) => o.resultado !== null);
            const wins   = closed.filter((o) => o.resultado === "TP").length;
            const wr     = closed.length > 0 ? Math.round((wins / closed.length) * 100) : 0;
            const pnl    = closed.reduce((acc, o) => acc + (o.pnl ?? 0), 0);
            return (
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap: 4 }}>
                {[
                  { lbl:"WR",   val:`${wr}%`,                                    c: wr >= 50 ? T.up : T.down },
                  { lbl:"Ops",  val:`${ops.length}`,                               c: T.text },
                  { lbl:"P&L",  val:`${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}%`,   c: pnl >= 0 ? T.up : T.down },
                  { lbl:"Wins", val:`${wins}`,                                     c: T.up },
                ].map(({ lbl, val, c }) => (
                  <div key={lbl} style={{ background:T.s2, borderRadius:5, padding:"6px 7px" }}>
                    <div style={{ fontSize:7, fontWeight:600, letterSpacing:"0.06em",
                      textTransform:"uppercase", color:T.muted, marginBottom:2 }}>{lbl}</div>
                    <div style={{ fontFamily:MONO, fontSize:13, fontWeight:700, color:c }}>{val}</div>
                  </div>
                ))}
              </div>
            );
          })()}
        </Card>
      </div>

      {/* ── MAIN FEED ── */}
      <div style={{
        gridColumn: 2, gridRow: 2,
        overflowY: "auto", background: T.bg,
        padding: "8px 10px",
        display: "flex", flexDirection: "column", gap: 6,
      }}>
        <SessionBanner session={session} />
        <VerdictCard signal={signal} price={ws.price} />

        {/* History */}
        <Card>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom: 8 }}>
            <SecTitle>Historial · XAU/USD</SecTitle>
            <span style={{ fontFamily: MONO, fontSize: 9, color: T.muted }}>
              {ops.length} ops
            </span>
          </div>
          <HistoryList ops={ops} userId={userId} onUpdate={handleUpdate} />
        </Card>
      </div>

      {/* ── RIGHT PANEL ── */}
      <div style={{
        gridColumn: 3, gridRow: 2,
        overflowY: "auto", background: T.bg,
        borderLeft: `1px solid ${T.border}`,
        padding: "8px 8px",
        display: "flex", flexDirection: "column",
      }}>
        <Checklist
          session={session}
          signal={signal}
          price={ws.price}
          ema200={ema200}
          score={score}
          hasNews={false}
        />
        <OperationForm
          livePrice={ws.price}
          userId={userId}
          onSaved={handleSaved}
        />
      </div>

    </div>
  );
}
