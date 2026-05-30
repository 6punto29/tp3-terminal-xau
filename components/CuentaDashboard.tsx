"use client";
// components/CuentaDashboard.tsx
// Tab de cuenta: performance, historial completo y reglas de gestión.

import { useState, useEffect, useCallback } from "react";
import { supabaseBrowser } from "@/lib/db/supabase-client";
import EditOperationModal, { EditModalUpdate } from "./EditOperationModal";

// ── Auth helper ───────────────────────────────────────────────────────────────
// Obtiene los headers de auth para llamar a /api/operations.
// El access_token viene de la sesión activa de Supabase en el navegador.
// Si no hay sesión, retorna {} y la API responde 401.
async function authHeaders(): Promise<Record<string,string>> {
  const { data } = await supabaseBrowser.auth.getSession();
  const token = data.session?.access_token;
  return token ? { "Authorization": `Bearer ${token}` } : {};
}

const MONO = "'JetBrains Mono','Fira Code',monospace";
const SANS = "'Inter',-apple-system,sans-serif";

const T = {
  bg:"var(--tp3-bg)",s1:"var(--tp3-s1)",s2:"var(--tp3-s2)",s3:"var(--tp3-s3)",
  border:"var(--tp3-border)",border2:"var(--tp3-border2)",
  text:"var(--tp3-text)",muted:"var(--tp3-muted)",dim:"var(--tp3-dim)",
  up:"var(--tp3-up)",down:"var(--tp3-down)",wait:"var(--tp3-wait)",
  accent:"var(--tp3-accent)",gold:"var(--tp3-gold)",
  upBg:"var(--tp3-upBg)",dnBg:"var(--tp3-dnBg)",
  upBorder:"var(--tp3-upBorder)",dnBorder:"var(--tp3-dnBorder)",
};

type Direction = "LONG"|"SHORT";
type OpsResult = "TP"|"SL"|"MANUAL"|null;

interface Operation {
  id:string;fecha:string;direccion:Direction;
  precio_entrada:number;sl:number;tp:number;
  lotaje:number|null;
  resultado:OpsResult;pnl:number|null; // en dólares reales
  capital_momento?:number|null;
  hora_apertura_mt5?:string|null;
  created_at?:string;
}

const Card=({children,style}:{children:React.ReactNode;style?:React.CSSProperties})=>(
  <div style={{background:T.s1,borderRadius:10,border:`1px solid ${T.border}`,padding:"14px 16px",...style}}>{children}</div>
);
const SecTitle=({children}:{children:React.ReactNode})=>(
  <div style={{fontFamily:SANS,fontSize:11,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:T.muted,marginBottom:10}}>{children}</div>
);

function fmtPnl(pnl:number|null):string{
  if(pnl==null)return"--";
  return(pnl>=0?"+$":"-$")+Math.abs(pnl).toFixed(0);
}

export default function CuentaDashboard({userId}:{userId:string}){
  const[ops,setOps]=useState<Operation[]>([]);
  const[loading,setLoading]=useState(true);
  const[reglasOpen,setReglasOpen]=useState(false);
  const[copied,setCopied]=useState(false);  // feedback visual del botón "Copiar estadísticas"
  const[editingOp,setEditingOp]=useState<Operation|null>(null);

  useEffect(()=>{
    if(!userId)return;
    setLoading(true);
    authHeaders().then(h=>fetch("/api/operations",{headers:h}))
      .then(r=>r.json()).then(d=>{if(Array.isArray(d))setOps(d);})
      .catch(console.error).finally(()=>setLoading(false));
  },[userId]);

  // handleUpdate: P&L en dólares reales usando lotaje
  const handleUpdate=useCallback(async(id:string,resultado:"TP"|"SL"|"MANUAL")=>{
    const op=ops.find(o=>o.id===id);if(!op)return;
    const lot=op.lotaje??0;
    let pnl:number|null=null;
    if(resultado==="TP"){
      const pts=op.direccion==="LONG"?op.tp-op.precio_entrada:op.precio_entrada-op.tp;
      pnl=pts*lot*100;
    }else if(resultado==="SL"){
      const pts=op.direccion==="LONG"?op.precio_entrada-op.sl:op.sl-op.precio_entrada;
      pnl=-pts*lot*100;
    }
    // MANUAL → queda en null, se corrige con ✏️
    try{
      await fetch("/api/operations",{method:"PATCH",headers:{"Content-Type":"application/json",...(await authHeaders())},
        body:JSON.stringify({id,resultado,pnl})});
      setOps(p=>p.map(o=>o.id===id?{...o,resultado,pnl}:o));
    }catch(e){console.error(e);}
  },[ops,userId]);

  // handleDelete: eliminar operación con confirmación
  const handleDelete=useCallback(async(id:string)=>{
    if(!confirm("¿Eliminar esta operación? Esta acción no se puede deshacer."))return;
    try{
      await fetch(`/api/operations?id=${id}`,{method:"DELETE",headers:await authHeaders()});
      setOps(p=>p.filter(o=>o.id!==id));
    }catch(e){console.error(e);}
  },[userId]);

  // handleEditSave: guardar cambios del modal de edición
  const handleEditSave=useCallback(async(updated:EditModalUpdate)=>{
    try{
      await fetch("/api/operations",{method:"PATCH",headers:{"Content-Type":"application/json",...(await authHeaders())},
        body:JSON.stringify(updated)});
      setOps(p=>p.map(o=>o.id===updated.id?{...o,...updated}:o));
      setEditingOp(null);
    }catch(e){console.error(e);}
  },[userId]);

  // ═══════════════════════════════════════════════════════════════════════════
  // ESTADÍSTICAS PROFESIONALES (actualizado 30/05/26)
  // Win Rate por P&L (estándar industria): TP=WIN, SL=LOSS,
  // MANUAL clasifica por P&L (>0 win, <0 loss, =0 excluido del WR).
  // Métricas: Profit Factor, Expectancy, Avg Win/Loss, R:R Real,
  // Best/Worst Trade, Sharpe Ratio, Max DD, Racha.
  // ═══════════════════════════════════════════════════════════════════════════
  const closed=ops.filter(o=>o.resultado!==null);

  // Clasificación profesional: una op es WIN si P&L > 0, LOSS si P&L < 0.
  // Break-even (P&L = 0) se excluye del WR (estándar profesional).
  const winOps  = closed.filter(o => o.resultado==="TP" || (o.resultado==="MANUAL" && (o.pnl??0) > 0));
  const lossOps = closed.filter(o => o.resultado==="SL" || (o.resultado==="MANUAL" && (o.pnl??0) < 0));
  const wins   = winOps.length;
  const losses = lossOps.length;
  const totalContados = wins + losses;
  const wr = totalContados>0 ? Math.round((wins/totalContados)*100) : 0;

  // P&L total (incluye todas las cerradas, incluso BE)
  const pnlTotal = closed.reduce((a,o)=>a+(o.pnl??0), 0);

  // Avg Win / Avg Loss
  const sumWins   = winOps.reduce((a,o)=>a+(o.pnl??0), 0);
  const sumLosses = Math.abs(lossOps.reduce((a,o)=>a+(o.pnl??0), 0));
  const avgWin  = wins>0   ? sumWins/wins     : null;
  const avgLoss = losses>0 ? sumLosses/losses : null; // valor positivo (magnitud)

  // Profit Factor: suma ganancias / |suma pérdidas|
  // Estándar industria: <1.0 pierde, 1.5-2.5 profesional, >3.0 excepcional
  const profitFactor = sumLosses>0 ? sumWins/sumLosses : null;

  // Expectancy: ganancia esperada por trade promedio
  // (Win Rate × Avg Win) − ((1 − Win Rate) × Avg Loss)
  const expectancy = (avgWin!=null && avgLoss!=null && totalContados>0)
    ? (wr/100)*avgWin - ((100-wr)/100)*avgLoss
    : null;

  // R:R Real: Avg Win / Avg Loss
  const rrReal = (avgWin!=null && avgLoss!=null && avgLoss>0) ? avgWin/avgLoss : null;

  // Best / Worst Trade (incluyendo MANUAL)
  const pnls = closed.map(o=>o.pnl??0);
  const bestTrade  = pnls.length>0 ? Math.max(...pnls) : null;
  const worstTrade = pnls.length>0 ? Math.min(...pnls) : null;

  // Sharpe Ratio simplificado: media P&L / desviación estándar
  // Requiere mínimo 20 ops para tener peso estadístico (estándar industria)
  let sharpe:number|null = null;
  if(closed.length >= 20){
    const mean = pnlTotal/closed.length;
    const variance = closed.reduce((a,o)=>a+Math.pow((o.pnl??0)-mean, 2), 0) / closed.length;
    const stdDev = Math.sqrt(variance);
    sharpe = stdDev>0 ? mean/stdDev : null;
  }

  // Racha actual
  let racha=0;
  let rachaType:"WIN"|"LOSS"|null=null;
  for(let i=closed.length-1;i>=0;i--){
    const o = closed[i];
    const isWin = o.resultado==="TP" || (o.resultado==="MANUAL" && (o.pnl??0) > 0);
    const isLoss = o.resultado==="SL" || (o.resultado==="MANUAL" && (o.pnl??0) < 0);
    const tipo = isWin ? "WIN" : isLoss ? "LOSS" : null;
    if(tipo===null) break; // BE corta la racha
    if(i===closed.length-1){ rachaType=tipo; racha=1; }
    else if(tipo===rachaType){ racha++; }
    else break;
  }

  // Alerta: 2 LOSS seguidas (advertencia visual, no obligación absoluta)
  const alertaDoblePerdida = rachaType==="LOSS" && racha>=2;

  // Max drawdown en dólares
  let peak=0,dd=0,maxDD=0,cum=0;
  for(const op of closed){
    cum+=(op.pnl??0);
    if(cum>peak)peak=cum;
    dd=peak-cum;
    if(dd>maxDD)maxDD=dd;
  }

  // Helpers de formato
  const fmtNum = (n:number|null, suffix=""):string => n==null?"--":n.toFixed(2)+suffix;
  const fmtMoney = (n:number|null):string => {
    if(n==null) return "--";
    return (n>=0?"+$":"-$")+Math.abs(n).toFixed(0);
  };

  // Grilla 4×4 = 16 métricas, agrupadas por filas lógicas:
  // Fila 1: Rendimiento principal | Fila 2: Detalle de ops
  // Fila 3: Riesgo y calidad      | Fila 4: Información complementaria
  const stats=[
    // Fila 1 — Rendimiento principal
    {l:"Win Rate",      v:totalContados>0?`${wr}%`:"--",        c:totalContados>0?(wr>=50?T.up:T.down):T.muted},
    {l:"Profit Factor", v:fmtNum(profitFactor),                 c:profitFactor==null?T.muted:profitFactor>=1.5?T.up:profitFactor>=1?T.wait:T.down},
    {l:"Expectancy",    v:fmtMoney(expectancy),                 c:expectancy==null?T.muted:expectancy>0?T.up:T.down},
    {l:"P&L Total",     v:fmtMoney(pnlTotal),                   c:pnlTotal>=0?T.up:T.down},
    // Fila 2 — Detalle de operaciones
    {l:"Ganadoras",     v:`${wins}`,                            c:T.up},
    {l:"Perdedoras",    v:`${losses}`,                          c:T.down},
    {l:"Avg Win",       v:fmtMoney(avgWin),                     c:avgWin==null?T.muted:T.up},
    {l:"Avg Loss",      v:avgLoss==null?"--":`-$${avgLoss.toFixed(0)}`, c:avgLoss==null?T.muted:T.down},
    // Fila 3 — Riesgo y calidad
    {l:"R:R Real",      v:fmtNum(rrReal),                       c:rrReal==null?T.muted:rrReal>=2?T.up:rrReal>=1?T.wait:T.down},
    {l:"Best Trade",    v:fmtMoney(bestTrade),                  c:bestTrade==null?T.muted:bestTrade>=0?T.up:T.down},
    {l:"Worst Trade",   v:fmtMoney(worstTrade),                 c:worstTrade==null?T.muted:worstTrade>=0?T.up:T.down},
    {l:"Max DD",        v:maxDD>0?`-$${maxDD.toFixed(0)}`:"$0", c:maxDD>0?T.down:T.muted},
    // Fila 4 — Información complementaria
    {l:"Sharpe Ratio",  v:sharpe!=null?fmtNum(sharpe):closed.length<20?`-- (n<20)`:"--", c:sharpe==null?T.muted:sharpe>=1?T.up:T.wait},
    {l:"Racha",         v:racha>0?`${racha} ${rachaType==="WIN"?"✓":"✗"}`:"--",
     c:rachaType==="WIN"?T.up:rachaType==="LOSS"?T.down:T.muted},
    {l:"Operaciones",   v:`${ops.length}`,                      c:T.text},
    {l:"Pendientes",    v:`${ops.filter(o=>o.resultado===null).length}`, c:T.muted},
  ];

  // Función "Copiar estadísticas" — formato profesional para análisis externo
  const copyStats = async()=>{
    const now = new Date();
    const dateStr = now.toLocaleDateString("es-CO",{day:"2-digit",month:"2-digit",year:"2-digit"});
    const timeStr = now.toLocaleTimeString("es-CO",{hour:"2-digit",minute:"2-digit",hour12:false});
    const capital = (typeof window!=="undefined" && parseFloat(localStorage.getItem("tp3_capital")||""))||10000;

    const text = [
      "━━━ TP3 Cuenta · XAU/USD ━━━",
      `📅 ${dateStr} ${timeStr} COL · Capital $${capital.toLocaleString("en-US")}`,
      "",
      "📊 RENDIMIENTO",
      `  Win Rate:       ${totalContados>0?`${wr}% (${wins} wins / ${totalContados} ops)`:"--"}`,
      `  Profit Factor:  ${fmtNum(profitFactor)}${profitFactor!=null?(profitFactor>=1.5?" ✓ profesional":profitFactor>=1?" ⚠ marginal":" ✗ pierde"):""}`,
      `  Expectancy:     ${fmtMoney(expectancy)}${expectancy!=null?"/trade":""}`,
      `  P&L Total:      ${fmtMoney(pnlTotal)}`,
      "",
      "📈 DETALLE",
      `  Ganadoras: ${wins}  ·  Perdedoras: ${losses}  ·  BE/excluidas: ${closed.length-totalContados}`,
      `  Avg Win:   ${fmtMoney(avgWin)}  ·  Avg Loss:  ${avgLoss==null?"--":`-$${avgLoss.toFixed(0)}`}`,
      `  R:R Real:  ${fmtNum(rrReal)}`,
      "",
      "⚠️ RIESGO",
      `  Best Trade:   ${fmtMoney(bestTrade)}`,
      `  Worst Trade:  ${fmtMoney(worstTrade)}`,
      `  Max DD:       ${maxDD>0?`-$${maxDD.toFixed(0)}`:"$0"}`,
      "",
      "📉 OTROS",
      `  Sharpe Ratio: ${sharpe!=null?fmtNum(sharpe):closed.length<20?`-- (n<20, requiere ≥20 ops)`:"--"}`,
      `  Racha:        ${racha>0?`${racha} ${rachaType==="WIN"?"✓":"✗"}`:"--"}${alertaDoblePerdida?"  ⚠️ 2+ LOSS seguidas":""}`,
      `  Operaciones:  ${ops.length}  ·  Pendientes: ${ops.filter(o=>o.resultado===null).length}`,
      "━━━━━━━━━━━━━━━━━━━━━━━━━━",
    ].join("\n");

    try{
      await navigator.clipboard.writeText(text);
      // feedback visual breve usando el state de "copied"
      setCopied(true);
      setTimeout(()=>setCopied(false), 2000);
    }catch{
      // fallback silencioso
    }
  };

  // Reglas de gestión (actualizado 30/05/26)
  // - Eliminada "Máx 2 ops por sesión" (decisión del usuario, depende de capital)
  // - "2 SL seguidos" pasa a advertencia visual (no obligación absoluta)
  // - Sesión actualizada: ya no es gate, solo afecta liquidez (+1/−2 score)
  // - Aclaración: el toggle "Sin noticia" es manual del usuario
  // - Veredicto ENTRAR del motor reemplaza "6 condiciones verde"
  const reglas=[
    {icn:"⚠️",txt:"Si acumulás 2 SL seguidos — revisar y considerar parar (advertencia)"},
    {icn:"💰",txt:"Riesgo máximo 1% del capital por operación"},
    {icn:"⏱",txt:"Operar preferentemente en liquidez alta (08:00–12:00 COL, overlap LDN+NY). Liquidez baja resta 2 al score."},
    {icn:"🎯",txt:"Score mínimo 6/10 obligatorio antes de entrar"},
    {icn:"📰",txt:"Si sabés que viene noticia importante o evento geopolítico, activá manualmente el toggle 'Sin noticia 30M' en el checklist"},
    {icn:"✅",txt:"Solo entrar con veredicto ENTRAR del motor (score ≥ 6 ajustado por liquidez)"},
  ];

  return(
    <div style={{background:T.bg,minHeight:"100%",padding:"16px",overflowY:"auto"}}>
      <div style={{maxWidth:1100,margin:"0 auto",display:"flex",flexDirection:"column",gap:14}}>

        {/* Stats grid */}
        <Card>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10,gap:8,flexWrap:"wrap"}}>
            <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
              <div style={{fontFamily:SANS,fontSize:11,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:T.muted}}>Performance XAU/USD</div>
              {alertaDoblePerdida && (
                <div style={{fontFamily:SANS,fontSize:10,fontWeight:700,color:T.down,background:T.dnBg,border:`1px solid ${T.dnBorder}`,borderRadius:6,padding:"3px 8px"}}>
                  ⚠️ {racha} LOSS seguidas — considerar parar
                </div>
              )}
            </div>
            <button
              onClick={copyStats}
              disabled={closed.length===0}
              style={{
                background:copied?T.upBg:T.s2,
                border:`1px solid ${copied?T.upBorder:T.border2}`,
                borderRadius:6,padding:"5px 10px",
                cursor:closed.length>0?"pointer":"not-allowed",
                fontFamily:SANS,fontSize:10,fontWeight:600,
                color:copied?T.up:T.muted,
                opacity:closed.length>0?1:0.4,
                transition:"all 0.2s"
              }}>
              {copied?"✓ Copiado":"📋 Copiar estadísticas"}
            </button>
          </div>
          {loading?(
            <div style={{fontFamily:MONO,fontSize:11,color:T.muted,padding:"10px 0"}}>Cargando...</div>
          ):(
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(140px, 1fr))",gap:8}}>
              {stats.map(({l,v,c})=>(
                <div key={l} style={{background:T.s2,borderRadius:8,padding:"10px 12px"}}>
                  <div style={{fontFamily:SANS,fontSize:9,fontWeight:600,letterSpacing:"0.08em",
                    textTransform:"uppercase",color:T.muted,marginBottom:4}}>{l}</div>
                  <div style={{fontFamily:MONO,fontSize:17,fontWeight:700,color:c}}>{v}</div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Reglas de gestión — colapsable */}
        <div style={{position:"relative"}}>
          <button
            onClick={()=>setReglasOpen(o=>!o)}
            style={{width:"100%",display:"flex",alignItems:"center",gap:8,padding:"5px 12px",
              borderRadius:7,background:T.s1,border:`1px solid ${T.border}`,cursor:"pointer",
              fontFamily:SANS,fontSize:10,color:T.muted,textAlign:"left"}}>
            <span style={{color:T.gold,fontWeight:700}}>Reglas</span>
            <span>⚠️ 2 SL=alerta · 💰 1% riesgo · ⏱ Liquidez alta · 🎯 Score≥6 · 📰 Sin noticia (manual) · ✅ Veredicto ENTRAR</span>
            <span style={{color:T.muted,fontSize:11,flexShrink:0,marginLeft:"auto"}}>{reglasOpen?"▲":"▼"}</span>
          </button>
          {reglasOpen&&(
            <div style={{position:"absolute",top:"calc(100% + 4px)",left:0,right:0,zIndex:100,
              background:T.s1,border:`1px solid ${T.border}`,borderRadius:7,padding:"8px 10px",
              boxShadow:"0 8px 24px rgba(0,0,0,0.4)"}}>
              {reglas.map(({icn,txt},i)=>(
                <div key={i} style={{display:"flex",alignItems:"center",gap:8,
                  padding:"4px 6px",borderRadius:4,background:i%2===0?T.s2:"transparent"}}>
                  <span style={{fontSize:11,flexShrink:0}}>{icn}</span>
                  <span style={{fontFamily:SANS,fontSize:11,color:T.text}}>{txt}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Historial completo */}
        <Card>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
            <SecTitle>Historial Completo</SecTitle>
            <span style={{fontFamily:MONO,fontSize:10,color:T.muted}}>{ops.length} ops</span>
          </div>
          {loading?(
            <div style={{fontFamily:MONO,fontSize:11,color:T.muted,padding:"10px 0"}}>Cargando...</div>
          ):ops.length===0?(
            <div style={{fontFamily:SANS,fontSize:12,color:T.muted,padding:"20px 0",textAlign:"center"}}>
              Sin operaciones registradas. Empieza tu primera operación en el Terminal.
            </div>
          ):(
            <div style={{display:"flex",flexDirection:"column",gap:4}}>
              {/* Header */}
              <div style={{display:"grid",
                gridTemplateColumns:"90px 80px 100px 90px 90px 60px 90px 70px 80px 60px",
                gap:8,padding:"4px 10px",fontFamily:SANS,fontSize:9,fontWeight:600,
                letterSpacing:"0.06em",textTransform:"uppercase",color:T.muted,borderBottom:`1px solid ${T.border}`,paddingBottom:6,marginBottom:4}}>
                <span>Fecha</span><span>Dir</span><span>Entrada</span>
                <span>SL</span><span>TP</span><span>Lotaje</span>
                <span>Resultado</span><span>P&L $</span><span>% Cuenta</span>
                <span style={{textAlign:"right"}}>Acciones</span>
              </div>
              {ops.map(op=>{
                const pnlColor=op.pnl!=null?(op.pnl>=0?T.up:T.down):T.muted;
                // R múltiplo
                const slPts=Math.abs(op.precio_entrada-op.sl);
                const dollarRisk=op.lotaje!=null?slPts*op.lotaje*100:null;
                const rMult=dollarRisk&&dollarRisk>0&&op.pnl!=null?op.pnl/dollarRisk:null;
                return(
                  <div key={op.id} style={{display:"grid",
                    gridTemplateColumns:"90px 80px 100px 90px 90px 60px 90px 70px 80px 60px",
                    gap:8,padding:"7px 10px",borderRadius:7,background:T.s2,
                    borderLeft:`3px solid ${op.resultado==="TP"?T.up:op.resultado==="SL"?T.down:T.dim}`,
                    alignItems:"center"}}>
                    <span style={{fontFamily:MONO,fontSize:10,color:T.muted,whiteSpace:"nowrap"}}>{op.fecha}</span>
                    <span style={{fontFamily:MONO,fontSize:10,fontWeight:700,
                      color:op.direccion==="LONG"?T.up:T.down}}>
                      {op.direccion==="LONG"?"▲ LONG":"▼ SHORT"}
                    </span>
                    <span style={{fontFamily:MONO,fontSize:11,color:T.text}}>${op.precio_entrada.toFixed(2)}</span>
                    <span style={{fontFamily:MONO,fontSize:10,color:T.down}}>${op.sl.toFixed(2)}</span>
                    <span style={{fontFamily:MONO,fontSize:10,color:T.up}}>${op.tp.toFixed(2)}</span>
                    <span style={{fontFamily:MONO,fontSize:10,color:T.gold}}>
                      {op.lotaje!=null?op.lotaje.toFixed(2):"--"}
                    </span>
                    {op.resultado==null?(
                      <div style={{display:"flex",gap:3,gridColumn:"span 3"}}>
                        {(["TP","SL","MANUAL"]as const).map(r=>(
                          <button key={r} onClick={()=>handleUpdate(op.id,r)} style={{
                            fontFamily:SANS,fontSize:8,fontWeight:700,padding:"2px 5px",borderRadius:4,
                            cursor:"pointer",border:"none",
                            background:r==="TP"?T.up:r==="SL"?T.down:T.s3,
                            color:r==="TP"||r==="SL"?"#fff":T.muted}}>{r}</button>
                        ))}
                      </div>
                    ):(
                      <>
                        <span style={{fontFamily:MONO,fontSize:11,fontWeight:700,
                          color:op.resultado==="TP"?T.up:op.resultado==="SL"?T.down:T.muted}}>
                          {op.resultado}
                        </span>
                        <span style={{fontFamily:MONO,fontSize:11,fontWeight:700,color:pnlColor}}>
                          {fmtPnl(op.pnl)}
                        </span>
                        <span style={{fontFamily:MONO,fontSize:11,fontWeight:700,color:pnlColor}}>
                          {op.pnl!=null?(()=>{
                            const cap=parseFloat((typeof window!=="undefined"&&localStorage.getItem("tp3_capital"))||"10000")||10000;
                            const pct=(op.pnl/cap)*100;
                            return(pct>=0?"+":"")+pct.toFixed(2)+"%";
                          })():"--"}
                        </span>
                      </>
                    )}
                    {/* Columna acciones — editar + eliminar */}
                    <div style={{display:"flex",gap:4,justifyContent:"flex-end"}}>
                      <button onClick={()=>setEditingOp(op)} title="Editar" style={{
                        background:"none",border:`1px solid ${T.border}`,borderRadius:4,
                        padding:"3px 6px",cursor:"pointer",fontSize:11,color:T.muted,lineHeight:1}}>✏️</button>
                      <button onClick={()=>handleDelete(op.id)} title="Eliminar" style={{
                        background:"none",border:`1px solid ${T.border}`,borderRadius:4,
                        padding:"3px 6px",cursor:"pointer",fontSize:11,color:T.down,lineHeight:1}}>🗑️</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

      </div>
      {editingOp&&<EditOperationModal op={editingOp} onClose={()=>setEditingOp(null)} onSave={handleEditSave}/>}
    </div>
  );
}
