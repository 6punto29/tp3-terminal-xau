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
type NotifPerm = "default" | "granted" | "denied";

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
  const [notifPerm, setNotifPerm] = useState<NotifPerm>("default");
  // Toggle local de alertas. Default true para que cuando el permiso ya esté granted
  // el usuario reciba alertas. Si el usuario lo apaga manualmente, queda silenciado
  // hasta que lo vuelva a prender. Se persiste en localStorage.
  // Distinto del permiso del navegador: el permiso lo controla el navegador (granted/
  // denied/default), este boolean lo controla el usuario adentro de la app.
  const [notifEnabled, setNotifEnabled] = useState<boolean>(true);
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

  // ── Permiso de notificaciones (state lifted desde LiveTerminal el 04/06/26).
  //    Razón: el toggle vive ahora en el topbar (toggle global), no en el right panel.
  //    Acá manejamos el state y la solicitud; la lógica de disparo (transición
  //    ESPERAR→ENTRAR + cooldown) sigue en LiveTerminal porque depende de signal.
  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    setNotifPerm(Notification.permission);
    // Cargar preferencia de toggle local (default true).
    try {
      const stored = localStorage.getItem("tp3-notif-enabled");
      if (stored !== null) setNotifEnabled(stored === "true");
    } catch {}
  }, []);

  const requestNotif = useCallback(async () => {
    if (typeof window === "undefined" || !("Notification" in window)) {
      alert("Tu navegador no soporta notificaciones");
      return;
    }
    const perm = Notification.permission;
    // Caso 1: permiso bloqueado a nivel navegador. No se puede activar desde acá.
    if (perm === "denied") {
      alert("Las notificaciones están bloqueadas por el navegador. Habilitalas desde la configuración (candado/info de URL → permitir notificaciones).");
      return;
    }
    // Caso 2: ya está granted → toggle local on/off.
    if (perm === "granted") {
      const next = !notifEnabled;
      setNotifEnabled(next);
      try { localStorage.setItem("tp3-notif-enabled", String(next)); } catch {}
      return;
    }
    // Caso 3: default → pedir permiso al navegador.
    const result = await Notification.requestPermission();
    setNotifPerm(result);
    if (result === "granted") {
      setNotifEnabled(true);
      try { localStorage.setItem("tp3-notif-enabled", "true"); } catch {}
    }
  }, [notifEnabled]);

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

      {/* ── ESTILOS GLOBALES — mobile responsive (auditoría 03/06/26) ── */}
      <style>{`
        @media (max-width: 700px) {
          .tp3-mobile-hide { display: none !important; }
        }
      `}</style>

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
              <span className="tp3-mobile-hide" style={{ fontFamily:MONO, fontSize:13, fontWeight:700,
                color:"var(--tp3-gold)" }}>
                ${ws.price.toFixed(2)}
              </span>
              {ws.changeSession !== 0 && (
                <span
                  className="tp3-mobile-hide"
                  title="Cambio % desde apertura de esta sesión (no 24h reales)"
                  style={{ fontFamily:MONO, fontSize:11,
                    color: ws.changeSession >= 0 ? "var(--tp3-up)" : "var(--tp3-down)" }}
                >
                  {ws.changeSession >= 0 ? "+" : ""}{ws.changeSession.toFixed(2)}% ses
                </span>
              )}
            </>
          )}
          <button
            onClick={requestNotif}
            title={
              notifPerm==="granted" && notifEnabled
                ? "Alertas activadas — click para silenciar"
                : notifPerm==="granted" && !notifEnabled
                ? "Alertas silenciadas — click para reactivar"
                : notifPerm==="denied"
                ? "Bloqueadas — habilitar desde config del navegador"
                : "Activar alertas de señal"
            }
            style={{
              background: (notifPerm==="granted" && notifEnabled)
                ? "rgba(0,200,150,0.10)"
                : "transparent",
              border: (notifPerm==="granted" && notifEnabled)
                ? "1px solid rgba(0,200,150,0.45)"
                : "1px solid var(--tp3-border2)",
              borderRadius:6, padding:"4px 8px", cursor:"pointer",
              fontSize:14, lineHeight:1,
              color: (notifPerm==="granted" && notifEnabled)
                ? "var(--tp3-up)"
                : "var(--tp3-down)",
            }}
          >
            {(notifPerm==="granted" && notifEnabled) ? "🔔" : "🔕"}
          </button>
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
          <LiveTerminal userId={userId} price={ws.price} connected={ws.connected} notifPerm={notifPerm} notifEnabled={notifEnabled} />}
        {tab === "backtest" &&
          <div style={{overflowY:"auto",flex:1}}><BacktestLab /></div>}
        {tab === "cuenta" && userId &&
          <div style={{overflowY:"auto",flex:1}}><CuentaDashboard userId={userId} /></div>}
      </div>
    </div>
  );
}
