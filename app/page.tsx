"use client";
// app/page.tsx
//
// Cambios v3:
// · Bug 1.5 — campo `change24h` renombrado a `changeSession` en useTwelveDataWS.
//   El número mostrado en topbar es % desde apertura de sesión del navegador,
//   no cambio real de 24h.

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { supabaseBrowser } from "@/lib/db/supabase-client";
import { useTwelveDataWS } from "@/lib/ws/twelvedata-ws";

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
  const ws = useTwelveDataWS();

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

  // ── Notificaciones push (B.9: state liftado desde LiveTerminal a page.tsx) ──
  // Vive acá para que el toggle 🔔 del topbar (B.10) pueda leerlo. LiveTerminal
  // sigue consumiendo notifPerm/requestNotif vía props para el banner del
  // checklist y para el useEffect disparador de notificaciones.
  const [notifPerm, setNotifPerm] = useState<"default"|"granted"|"denied">("default");

  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    setNotifPerm(Notification.permission);
  }, []);

  const requestNotif = useCallback(async () => {
    if (typeof window === "undefined" || !("Notification" in window)) {
      alert("Tu navegador no soporta notificaciones");
      return;
    }
    const result = await Notification.requestPermission();
    setNotifPerm(result);
  }, []);

  // B.11: silenciador local del botón 🔔 del topbar.
  // Persiste en localStorage bajo "tp3-notif-enabled". Por default true.
  // Solo se considera false si explícitamente fue guardado como "false".
  // Patrón WhatsApp/Slack: el navegador puede tener permiso granted pero el
  // operador silenciar localmente sin revocar el permiso del navegador.
  const [notifEnabled, setNotifEnabled] = useState<boolean>(true);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = localStorage.getItem("tp3-notif-enabled");
    if (saved === "false") setNotifEnabled(false);
  }, []);

  const toggleNotifEnabled = useCallback(() => {
    setNotifEnabled(prev => {
      const next = !prev;
      try { localStorage.setItem("tp3-notif-enabled", String(next)); } catch {}
      return next;
    });
  }, []);

  // B.10/B.11: handler del botón 🔔 del topbar.
  // · denied → alert (no se puede re-pedir permiso desde JS, hay que ir a config del navegador)
  // · default → pide permiso (mismo flujo que el banner "Activar alertas" del checklist)
  // · granted → toggle on/off local (silenciador notifEnabled vía localStorage)
  const handleNotifClick = useCallback(() => {
    if (notifPerm === "denied") {
      alert("Para activar las notificaciones, habilitalas desde la configuración del navegador (icono del candado en la barra de direcciones).");
      return;
    }
    if (notifPerm === "default") {
      requestNotif();
      return;
    }
    // granted → silenciador on/off (B.11)
    toggleNotifEnabled();
  }, [notifPerm, requestNotif, toggleNotifEnabled]);

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
        padding:"0 16px",
        // Sub-item B.6 del handoff v13: respeta el área superior del notch/Dynamic Island
        // del iPhone (con viewportFit cover, el viewport se extiende hasta cubrir TODA la
        // pantalla, así que el topbar quedaría tapado por la hora/batería del sistema).
        // En desktop env(safe-area-inset-top) es 0, idéntico a hoy.
        paddingTop:"env(safe-area-inset-top)",
        height:"calc(44px + env(safe-area-inset-top))",
        flexShrink:0,
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

          {/* Tabs — Pill / Segment Control style (estilo Vercel dashboard / iOS Segmented)
              · Container con bg var(--tp3-s2) y padding 2px agrupa los 3 tabs visualmente
              · Active tab: bg var(--tp3-s3) + rounded para destacarse del container
              · Inactivos: sin bg, solo cambia el color del texto
              · Total height del container ≈ 28px (24px del tab + 2px padding arriba+abajo)
                → alineado con los botones del lado derecho */}
          <div style={{
            display:"inline-flex", alignItems:"center",
            background:"var(--tp3-s2)", borderRadius:8, padding:2,
          }}>
            {([
              { id:"terminal" as Tab, label:"Terminal" },
              { id:"backtest" as Tab, label:"Backtest" },
              { id:"cuenta"   as Tab, label:"Cuenta"   },
            ]).map(({ id, label }) => (
              <button key={id} onClick={() => setTab(id)} style={{
                fontFamily:SANS, fontSize:11, fontWeight:700,
                padding:"0 14px", height:24, borderRadius:6, border:"none",
                display:"flex", alignItems:"center", justifyContent:"center",
                cursor:"pointer", transition:"all .15s",
                background: tab === id ? "var(--tp3-s3)" : "transparent",
                color:      tab === id ? "var(--tp3-text)" : "var(--tp3-muted)",
              }}>{label}</button>
            ))}
          </div>
        </div>

        {/* Derecha — precio + cambio sesión + botones */}
        <div style={{ display:"flex", gap:6, alignItems:"center" }}>
          {/* Sub-item B.3 del handoff v13: precio y %ses ocultos en mobile (<700px) */}
          <div className="tp3-mobile-hide" style={{ display:"flex", gap:10, alignItems:"center" }}>
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
          </div>
          <button
            onClick={toggleTheme}
            title={theme === "dark"
              ? "Modo oscuro · click para cambiar a claro"
              : "Modo claro · click para cambiar a oscuro"}
            style={{
              background:"transparent", border:"1px solid var(--tp3-border2)",
              borderRadius:6, padding:"0 8px", height:28, cursor:"pointer",
              display:"flex", alignItems:"center", justifyContent:"center",
              fontSize:13, lineHeight:1, color:"var(--tp3-muted)",
            }}
          >
            {theme === "dark" ? "◑" : "☀"}
          </button>
          {/* B.10/B.11: botón de notificaciones — visible en desktop Y mobile.
              Mismo estilo visual que ☀/◑ y Salir (transparent + var(--tp3-border2)).
              · 🔔 cuando notifPerm === "granted" && notifEnabled (alertas activas)
              · 🔕 en cualquier otro caso (sin permiso, bloqueadas, o silenciadas localmente) */}
          {/* Botón de alertas — SVG monocromo Lucide-style:
              · Activa (notifPerm granted + notifEnabled): campana llena, color dorado (var --tp3-gold)
              · Silenciada / no activada / denied: campana tachada, color gris (var --tp3-muted)
              Coherencia visual con los otros 2 íconos del topbar (☀/◑ y Salir SVG):
              todos monocromos, todos heredan currentColor */}
          <button
            onClick={handleNotifClick}
            title={
              notifPerm === "denied"  ? "Notificaciones bloqueadas en el navegador" :
              notifPerm === "default" ? "Activar notificaciones" :
              notifEnabled            ? "Alertas activas · click para silenciar" :
                                        "Alertas silenciadas · click para reactivar"
            }
            aria-label="Alertas"
            style={{
              background:"transparent", border:"1px solid var(--tp3-border2)",
              borderRadius:6, padding:"0 8px", height:28, cursor:"pointer",
              display:"flex", alignItems:"center", justifyContent:"center",
              color: (notifPerm === "granted" && notifEnabled)
                ? "var(--tp3-gold)"
                : "var(--tp3-muted)",
            }}
          >
            {(notifPerm === "granted" && notifEnabled) ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/>
                <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                <path d="M18.63 13A17.89 17.89 0 0 1 18 8"/>
                <path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"/>
                <path d="M18 8a6 6 0 0 0-9.33-5"/>
                <line x1="1" y1="1" x2="23" y2="23"/>
              </svg>
            )}
          </button>
          {/* Botón Salir — responsive:
              · Desktop (≥701px): muestra texto "Salir" (span con tp3-mobile-hide)
              · Mobile (<700px): muestra SVG logout (span con tp3-desktop-hide)
              Resuelve el problema de "Salir" pegado al borde derecho en iPhone */}
          <button onClick={logout}
            title="Salir / Cerrar sesión"
            aria-label="Salir"
            style={{
              background:"transparent", border:"1px solid var(--tp3-border2)",
              borderRadius:6, padding:"0 8px", height:28, cursor:"pointer",
              display:"flex", alignItems:"center", justifyContent:"center",
              fontFamily:SANS, fontSize:13, fontWeight:600, lineHeight:1,
              color:"var(--tp3-muted)",
            }}>
            <span className="tp3-mobile-hide">Salir</span>
            <span className="tp3-desktop-hide" style={{ display:"flex", alignItems:"center" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                <polyline points="16 17 21 12 16 7"/>
                <line x1="21" y1="12" x2="9" y2="12"/>
              </svg>
            </span>
          </button>
        </div>
      </div>

      {/* ── CONTENIDO ── */}
      <div style={{ flex:1, overflow:"hidden", minHeight:0, display:"flex", flexDirection:"column" }}>
        {tab === "terminal" && userId &&
          <LiveTerminal
            userId={userId}
            price={ws.price}
            connected={ws.connected}
            notifPerm={notifPerm}
            notifEnabled={notifEnabled}
          />}
        {tab === "backtest" &&
          <div style={{overflowY:"auto",flex:1}}><BacktestLab /></div>}
        {tab === "cuenta" && userId &&
          <div style={{overflowY:"auto",flex:1}}><CuentaDashboard userId={userId} /></div>}
      </div>
    </div>
  );
}
