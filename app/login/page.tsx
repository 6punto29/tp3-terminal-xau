"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/db/supabase-client";

const MONO = "'JetBrains Mono','Fira Code',monospace";
const SANS = "'Inter',-apple-system,sans-serif";

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
    <div style={{ background:"#0B0D11", minHeight:"100vh", display:"flex",
      alignItems:"center", justifyContent:"center",
      fontFamily:MONO, fontSize:12, color:"#5A6478", letterSpacing:2 }}>
      CARGANDO...
    </div>
  );

  return (
    <div style={{ background:"#0B0D11", minHeight:"100vh", display:"flex",
      alignItems:"center", justifyContent:"center", fontFamily:SANS }}>
      <div style={{ width:340, background:"#131620", borderRadius:12,
        border:"1px solid rgba(255,255,255,0.06)", padding:"32px 28px" }}>
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
