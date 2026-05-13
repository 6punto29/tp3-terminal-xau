"use client";
// components/CuentaDashboard.tsx
// Tab de cuenta: performance, historial completo y reglas de gestión.

import { useState, useEffect, useCallback } from "react";

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

  useEffect(()=>{
    if(!userId)return;
    setLoading(true);
    fetch("/api/operations",{headers:{"x-user-id":userId}})
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
      await fetch("/api/operations",{method:"PATCH",headers:{"Content-Type":"application/json","x-user-id":userId},
        body:JSON.stringify({id,resultado,pnl})});
      setOps(p=>p.map(o=>o.id===id?{...o,resultado,pnl}:o));
    }catch(e){console.error(e);}
  },[ops,userId]);

  // Stats — todo en dólares
  const closed=ops.filter(o=>o.resultado!==null);
  const wins=closed.filter(o=>o.resultado==="TP").length;
  const losses=closed.filter(o=>o.resultado==="SL").length;
  const wr=closed.length>0?Math.round((wins/closed.length)*100):0;
  const pnlTotal=closed.reduce((a,o)=>a+(o.pnl??0),0); // $

  // Racha actual
  let racha=0;
  let rachaType:"WIN"|"LOSS"|null=null;
  for(let i=closed.length-1;i>=0;i--){
    const r=closed[i].resultado;
    if(i===closed.length-1){rachaType=r==="TP"?"WIN":"LOSS";racha=1;}
    else if((rachaType==="WIN"&&r==="TP")||(rachaType==="LOSS"&&r==="SL")){racha++;}
    else break;
  }

  // Max drawdown en dólares
  let peak=0,dd=0,maxDD=0,cum=0;
  for(const op of closed){
    cum+=(op.pnl??0);
    if(cum>peak)peak=cum;
    dd=peak-cum;
    if(dd>maxDD)maxDD=dd;
  }

  const stats=[
    {l:"Win Rate",    v:`${wr}%`,                      c:wr>=50?T.up:T.down},
    {l:"Operaciones", v:`${ops.length}`,                c:T.text},
    {l:"P&L Total",   v:fmtPnl(pnlTotal),               c:pnlTotal>=0?T.up:T.down},
    {l:"Ganadoras",   v:`${wins}`,                      c:T.up},
    {l:"Perdedoras",  v:`${losses}`,                    c:T.down},
    {l:"Max DD",      v:maxDD>0?`-$${maxDD.toFixed(0)}`:"$0", c:T.wait},
    {l:"Racha",       v:racha>0?`${racha} ${rachaType==="WIN"?"✓":"✗"}`:"--",
     c:rachaType==="WIN"?T.up:rachaType==="LOSS"?T.down:T.muted},
    {l:"Pendientes",  v:`${ops.filter(o=>o.resultado===null).length}`, c:T.muted},
  ];

  // Reglas de gestión
  const reglas=[
    {icn:"📊",txt:"Máximo 2 operaciones por sesión LDN o NY"},
    {icn:"🛑",txt:"Si acumulas 2 SL seguidos — cerrar terminal ese día"},
    {icn:"💰",txt:"Riesgo máximo 1% del capital por operación"},
    {icn:"⏱",txt:"Solo operar durante LDN (3-5 AM COL) o NY (9:30-11:30 AM COL)"},
    {icn:"🎯",txt:"Score mínimo 6/10 obligatorio antes de entrar"},
    {icn:"📰",txt:"Revisar calendario económico — no operar 30M antes de noticia"},
    {icn:"✅",txt:"Las 6 condiciones del checklist deben estar en verde"},
  ];

  return(
    <div style={{background:T.bg,minHeight:"100%",padding:"16px",overflowY:"auto"}}>
      <div style={{maxWidth:1100,margin:"0 auto",display:"flex",flexDirection:"column",gap:14}}>

        {/* Stats grid */}
        <Card>
          <SecTitle>Performance XAU/USD</SecTitle>
          {loading?(
            <div style={{fontFamily:MONO,fontSize:11,color:T.muted,padding:"10px 0"}}>Cargando...</div>
          ):(
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
              {stats.map(({l,v,c})=>(
                <div key={l} style={{background:T.s2,borderRadius:8,padding:"10px 12px"}}>
                  <div style={{fontFamily:SANS,fontSize:9,fontWeight:600,letterSpacing:"0.08em",
                    textTransform:"uppercase",color:T.muted,marginBottom:4}}>{l}</div>
                  <div style={{fontFamily:MONO,fontSize:18,fontWeight:700,color:c}}>{v}</div>
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
            <span>📊 Máx 2 ops · 🛑 2 SL=cerrar · 💰 1% riesgo · ⏱ LDN/NY · 🎯 Score≥6 · 📰 Sin noticias 30M · ✅ Checklist verde</span>
            <span style={{marginLeft:"auto",color:T.gold,fontSize:9}}>EV +1.55R · WR 51% · 81 señales</span>
            <span style={{color:T.muted,fontSize:11,flexShrink:0}}>{reglasOpen?"▲":"▼"}</span>
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
              <div style={{marginTop:6,padding:"4px 6px",fontFamily:SANS,fontSize:10,color:T.gold}}>
                💡 EV +1.55R con WR 51% sobre 81 señales reales. La disciplina separa el backtest del resultado real.
              </div>
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
                gridTemplateColumns:"60px 80px 1fr 80px 80px 55px 80px 80px",
                gap:8,padding:"4px 10px",fontFamily:SANS,fontSize:9,fontWeight:600,
                letterSpacing:"0.06em",textTransform:"uppercase",color:T.muted}}>
                <span>Fecha</span><span>Dir</span><span>Entrada</span>
                <span>SL</span><span>TP</span><span>Lotaje</span>
                <span>Resultado</span><span>P&L $</span>
              </div>
              {ops.map(op=>{
                const pnlColor=op.pnl!=null?(op.pnl>=0?T.up:T.down):T.muted;
                // R múltiplo
                const slPts=Math.abs(op.precio_entrada-op.sl);
                const dollarRisk=op.lotaje!=null?slPts*op.lotaje*100:null;
                const rMult=dollarRisk&&dollarRisk>0&&op.pnl!=null?op.pnl/dollarRisk:null;
                return(
                  <div key={op.id} style={{display:"grid",
                    gridTemplateColumns:"60px 80px 1fr 80px 80px 55px 80px 80px",
                    gap:8,padding:"7px 10px",borderRadius:7,background:T.s2,
                    borderLeft:`3px solid ${op.resultado==="TP"?T.up:op.resultado==="SL"?T.down:T.dim}`}}>
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
                      <div style={{display:"flex",gap:3,gridColumn:"span 2"}}>
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
                        <div>
                          <div style={{fontFamily:MONO,fontSize:11,fontWeight:700,color:pnlColor}}>
                            {fmtPnl(op.pnl)}
                          </div>
                          {op.pnl!=null&&(()=>{
                            const cap=parseFloat((typeof window!=="undefined"&&localStorage.getItem("tp3_capital"))||"10000")||10000;
                            const pct=(op.pnl/cap)*100;
                            return(<div style={{fontFamily:MONO,fontSize:9,color:pnlColor}}>
                              {pct>=0?"+":""}{pct.toFixed(2)}% cuenta
                            </div>);
                          })()}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>

      </div>
    </div>
  );
}
