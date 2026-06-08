"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/db/supabase-client";

const MONO = "'JetBrains Mono','Fira Code',monospace";
const SANS = "'Inter',-apple-system,sans-serif";

// ── FONDO ANIMADO DE PUNTOS TEAL (08/06/26) ─────────────────────────────────
// Variante B (Teal #1D9E75) elegida sobre verde puro tras revisión de
// literatura de psicología del trading (Denise Shull, AMarkets, Bookmap).
// Razones:
//   · Verde puro activa "luz verde de actuar" → FOMO subliminal.
//   · Teal está entre verde (asociación "ganancia") y azul (calma + decisión).
//   · #1D9E75 coincide con T.up del proyecto → coherencia visual.
// Patrón "mueve y pausa" inspirado en Gemini: keyframes con plateaus a 35-50%
// y 80-100% para que el ojo descanse entre movimientos.
// Implementación: 2 capas radial-gradient + halo teal + 3 animaciones CSS.
// Sin librerías nuevas, sin canvas, sin JS — todo en GPU compositor.
const BG_STYLES = `
@keyframes tp3WaveA {
  0%        { transform: translate(0, 0); }
  20%       { transform: translate(-14px, -8px); }
  35%, 50%  { transform: translate(0, -16px); }
  65%       { transform: translate(14px, -8px); }
  80%, 100% { transform: translate(0, 0); }
}
@keyframes tp3WaveB {
  0%        { transform: translate(0, 0); }
  20%       { transform: translate(10px, 6px); }
  35%, 50%  { transform: translate(0, 12px); }
  65%       { transform: translate(-10px, 6px); }
  80%, 100% { transform: translate(0, 0); }
}
@keyframes tp3HaloBreathe {
  0%, 100% { opacity: 0.85; transform: scale(1); }
  50%      { opacity: 1;    transform: scale(1.05); }
}
.tp3-halo {
  position: absolute; inset: 0; pointer-events: none;
  background-image: radial-gradient(circle at center,
    rgba(29, 158, 117, 0.28) 0%, rgba(29, 158, 117, 0) 68%);
  animation: tp3HaloBreathe 12s ease-in-out infinite;
}
.tp3-dots-a {
  position: absolute; inset: -60px; pointer-events: none;
  background-image: radial-gradient(circle, rgba(29, 158, 117, 0.18) 1px, transparent 1.5px);
  background-size: 22px 22px;
  animation: tp3WaveA 22s ease-in-out infinite;
}
.tp3-dots-b {
  position: absolute; inset: -60px; pointer-events: none;
  background-image: radial-gradient(circle, rgba(29, 158, 117, 0.12) 1px, transparent 1.5px);
  background-size: 34px 34px;
  background-position: 11px 11px;
  animation: tp3WaveB 28s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .tp3-halo, .tp3-dots-a, .tp3-dots-b { animation: none; }
}
`;

export default function LoginPage() {
  const router = useRouter();
  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState("");
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    supabaseBrowser.auth.getSession().then(({ data }) => {
      if (data.session) router.replace("/");
      else setChecking(false);
    });
  }, [router]);

  const login = async () => {
    if (!email || !password) return;
    setLoading(true); setError("");
    const { error: err } = await supabaseBrowser.auth.signInWithPassword({ email, password });
    if (err) { setError("Credenciales incorrectas"); setLoading(false); }
    else router.replace("/");
  };

  const onKey = (e: React.KeyboardEvent) => { if (e.key === "Enter") login(); };

  if (checking) return (
    <div style={{ background:"#0B0D11", minHeight:"100dvh", display:"flex",
      alignItems:"center", justifyContent:"center",
      fontFamily:MONO, fontSize:12, color:"#5A6478", letterSpacing:2 }}>
      CARGANDO...
    </div>
  );

  return (
    <div style={{ background:"#0B0D11", minHeight:"100dvh", display:"flex",
      alignItems:"center", justifyContent:"center", fontFamily:SANS,
      position:"relative", overflow:"hidden" }}>
      <style>{BG_STYLES}</style>
      <div className="tp3-halo"   aria-hidden="true" />
      <div className="tp3-dots-a" aria-hidden="true" />
      <div className="tp3-dots-b" aria-hidden="true" />
      <div style={{ width:340, background:"#131620", borderRadius:12,
        border:"1px solid rgba(255,255,255,0.06)", padding:"32px 28px",
        position:"relative", zIndex:1 }}>
        <div style={{ textAlign:"center", marginBottom:28 }}>
          <div style={{ fontFamily:MONO, fontSize:22, fontWeight:700,
            letterSpacing:4, color:"#E2E8F4", marginBottom:6 }}>TP3</div>
          <div style={{ fontSize:11, color:"#5A6478" }}>XAU/USD Terminal · Acceso privado</div>
        </div>
        <div style={{ marginBottom:12 }}>
          <label style={{ display:"block", fontSize:9, fontWeight:700,
            letterSpacing:"0.08em", textTransform:"uppercase",
            color:"#5A6478", marginBottom:5 }}>Email</label>
          <input type="email" value={email} onChange={e=>setEmail(e.target.value)}
            onKeyDown={onKey} placeholder="tu@email.com"
            style={{ width:"100%", background:"#1A1E2E",
              border:"1px solid rgba(255,255,255,0.12)", borderRadius:6,
              padding:"10px 12px", color:"#E2E8F4", fontFamily:SANS,
              fontSize:13, outline:"none", boxSizing:"border-box" }}/>
        </div>
        <div style={{ marginBottom:20 }}>
          <label style={{ display:"block", fontSize:9, fontWeight:700,
            letterSpacing:"0.08em", textTransform:"uppercase",
            color:"#5A6478", marginBottom:5 }}>Contraseña</label>
          <input type="password" value={password} onChange={e=>setPassword(e.target.value)}
            onKeyDown={onKey} placeholder="••••••••"
            style={{ width:"100%", background:"#1A1E2E",
              border:"1px solid rgba(255,255,255,0.12)", borderRadius:6,
              padding:"10px 12px", color:"#E2E8F4", fontFamily:SANS,
              fontSize:13, outline:"none", boxSizing:"border-box" }}/>
        </div>
        {error && (
          <div style={{ marginBottom:14, padding:"8px 12px", borderRadius:6,
            background:"rgba(255,59,92,0.08)", border:"1px solid rgba(255,59,92,0.18)",
            fontFamily:SANS, fontSize:11, color:"#FF3B5C" }}>{error}</div>
        )}
        <button onClick={login} disabled={loading||!email||!password} style={{
          width:"100%", padding:"11px",
          background:"linear-gradient(135deg,#C9A227,#E8B84B)",
          color:"#1D1D1F", fontFamily:SANS, fontSize:13, fontWeight:700,
          border:"none", borderRadius:6,
          cursor:loading?"not-allowed":"pointer",
          opacity:loading||!email||!password?0.6:1 }}>
          {loading?"Entrando...":"Entrar al Terminal"}
        </button>
        <div style={{ marginTop:16, textAlign:"center",
          fontFamily:MONO, fontSize:9, color:"#3A4260" }}>
          tp3-terminal-xau.vercel.app
        </div>
      </div>
    </div>
  );
}
