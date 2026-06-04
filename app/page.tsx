"use client";
// app/page.tsx
//
// Cambios v3:
// · Bug 1.5 — campo `change24h` renombrado a `changeSession` en useBinanceWS.
//   El número mostrado en topbar es % desde apertura de sesión del navegador,
//   no cambio real de 24h.

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { supabaseBrowser } from "@/lib/db/supabase-client";
import { useBinanceWS } from "@/lib/ws/binance-ws";

type Tab   = "terminal" | "backtest" | "cuenta";
type Theme = "dark" | "light";

const MONO = "'JetBrains Mono','Fira Code',monospace";
const SANS = "'Inter',-apple-system,sans-serif";

const LiveTerminal    = dynamic(() => import("@/components/LiveTerminal"),     { ssr: false });
const BacktestLab     = dynamic(() => import("@/components/BacktestLaboratory"),{ ssr: false });
const CuentaDashboard = dynamic(() => import("@/components/CuentaDashboard"),  { ssr: false });

export default function HomePage() {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [tab,    setTab]    = useState<Tab>("terminal");
  const [theme,  setTheme]  = useState<Theme>("dark");
  const ws = useBinanceWS("xauusdt", "1m");

  // ── Auth ──
  useEffect(() => {
    supabaseBrowser.auth.getSession().then(({ data }) => {
      if (!data.session) router.replace("/login");
      else setUserId(data.session.user.id);
    });
    const { data: listener } = supabaseBrowser.auth.onAuthStateChange((_e, session) => {
      if (!session) router.replace("/login");
      else setUserId(session.user.id);
    });
    return () => listener.subscription.unsubscribe();
  }, [router]);

  // ── Tema ──
  useEffect(() => {
    const saved = localStorage.getItem("tp3-theme") as Theme | null;
    const initial = saved ?? "dark";
    setTheme(initial);
    document.documentElement.setAttribute("data-theme", initial);
  }, []);

  const toggleTheme = useCallback(() => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("tp3-theme", next);
  }, [theme]);

  const logout = useCallback(async () => {
    await supabaseBrowser.auth.signOut();
    window.location.href = "/login";
  }, []);

  if (!userId) return (
    <div style={{ background:"var(--tp3-bg,#0B0D11)", minHeight:"100vh",
      display:"flex", alignItems:"center", justifyContent:"center",
      fontFamily:MONO, fontSize:13, color:"var(--tp3-muted,#5A6478)", letterSpacing:2 }}>
      VERIFICANDO SESION...
    </div>
  );

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100vh",
      overflow:"hidden", background:"var(--tp3-bg)", color:"var(--tp3-text)" }}>

      {/* ── TOPBAR ── */}
      <div style={{
        display:"flex", alignItems:"center", justifyContent:"space-between",
        padding:"0 16px", height:44, flexShrink:0,
        background:"var(--tp3-s1)", borderBottom:"1px solid var(--tp3-border)",
        zIndex:10,
      }}>
        {/* Izquierda — logo + tabs */}
        <div style={{ display:"flex", alignItems:"center", gap:12 }}>
          <div style={{ display:"flex", alignItems:"center", gap:6 }}>
            <div style={{
              width:7, height:7, borderRadius:"50%",
              background: ws.connected ? "var(--tp3-up)" : "var(--tp3-muted)",
              boxShadow: ws.connected ? "0 0 0 3px rgba(0,200,150,0.15)" : undefined,
            }}/>
            <span style={{ fontFamily:MONO, fontSize:14, fontWeight:700,
              letterSpacing:3, color:"var(--tp3-text)" }}>TP3</span>
          </div>

          {/* Tabs */}
          <div style={{ display:"flex", gap:2 }}>
            {([
              { id:"terminal" as Tab, label:"Terminal" },
              { id:"backtest" as Tab, label:"Backtest" },
              { id:"cuenta"   as Tab, label:"Cuenta"   },
            ]).map(({ id, label }) => (
              <button key={id} onClick={() => setTab(id)} style={{
                fontFamily:SANS, fontSize:11, fontWeight:700,
                padding:"4px 14px", borderRadius:6, border:"none",
                cursor:"pointer", transition:"all .15s",
                background: tab === id ? "var(--tp3-s3)" : "transparent",
                color:      tab === id ? "var(--tp3-text)" : "var(--tp3-muted)",
                borderBottom: tab === id
                  ? "2px solid var(--tp3-gold)"
                  : "2px solid transparent",
              }}>{label}</button>
            ))}
          </div>
        </div>

        {/* Derecha — precio + cambio sesión + botones */}
        <div style={{ display:"flex", gap:10, alignItems:"center" }}>
          {ws.price > 0 && (
            <>
              <span style={{ fontFamily:MONO, fontSize:13, fontWeight:700,
                color:"var(--tp3-gold)" }}>
                ${ws.price.toFixed(2)}
              </span>
              {ws.changeSession !== 0 && (
                <span
                  title="Cambio % desde apertura de esta sesión (no 24h reales)"
                  style={{ fontFamily:MONO, fontSize:11,
                    color: ws.changeSession >= 0 ? "var(--tp3-up)" : "var(--tp3-down)" }}
                >
                  {ws.changeSession >= 0 ? "+" : ""}{ws.changeSession.toFixed(2)}% ses
                </span>
              )}
            </>
          )}
          <button onClick={toggleTheme} style={{
            background:"transparent", border:"1px solid var(--tp3-border2)",
            borderRadius:6, padding:"4px 8px", cursor:"pointer",
            fontSize:16, lineHeight:1, color:"var(--tp3-muted)",
          }}>
            {theme === "dark" ? "☀" : "◑"}
          </button>
          <button onClick={logout} style={{
            background:"transparent", border:"1px solid var(--tp3-border2)",
            borderRadius:6, padding:"4px 10px", cursor:"pointer",
            fontFamily:SANS, fontSize:11, fontWeight:600,
            color:"var(--tp3-muted)",
          }}>
            Salir
          </button>
        </div>
      </div>

      {/* ── CONTENIDO ── */}
      <div style={{ flex:1, overflow:"hidden", minHeight:0, display:"flex", flexDirection:"column" }}>
        {tab === "terminal" && userId &&
          <LiveTerminal userId={userId} price={ws.price} connected={ws.connected} />}
        {tab === "backtest" &&
          <div style={{overflowY:"auto",flex:1}}><BacktestLab /></div>}
        {tab === "cuenta" && userId &&
          <div style={{overflowY:"auto",flex:1}}><CuentaDashboard userId={userId} /></div>}
      </div>
    </div>
  );
}
