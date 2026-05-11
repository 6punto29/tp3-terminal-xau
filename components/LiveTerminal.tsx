"use client";
// components/LiveTerminal.tsx — v4.0
// · Fair Value Gaps (FVG) — desequilibrios institucionales en sidebar
// · PDH/PDL — Previous Day High/Low como niveles de liquidez real
// · D1 Hard Filter — bloquea señales contra tendencia diaria
// · FVG en score +1
// · tpSource visible en bloque MT5 (session/structure/fallback)

import { useState, useEffect, useCallback } from "react";
import { calcOpLevels, calcLotSize } from "@/lib/engine/simulator";
import { precompute, getPDHL } from "@/lib/engine/indicators";
import { getLiveVerdict, mtfSignalAt, htfSignalAt } from "@/lib/engine/signals";
import type { Candle, PriceStructure, StructureLevels, SessionLevels } from "@/lib/engine/types";

const T = {
  bg:"var(--tp3-bg)",s1:"var(--tp3-s1)",s2:"var(--tp3-s2)",s3:"var(--tp3-s3)",s4:"var(--tp3-s4)",
  border:"var(--tp3-border)",border2:"var(--tp3-border2)",
  text:"var(--tp3-text)",muted:"var(--tp3-muted)",dim:"var(--tp3-dim)",
  up:"var(--tp3-up)",down:"var(--tp3-down)",wait:"var(--tp3-wait)",
  accent:"var(--tp3-accent)",gold:"var(--tp3-gold)",
  upBg:"var(--tp3-upBg)",dnBg:"var(--tp3-dnBg)",
  upBorder:"var(--tp3-upBorder)",dnBorder:"var(--tp3-dnBorder)",
  warnBg:"var(--tp3-warnBg)",warnBorder:"var(--tp3-warnBorder)",
};

const MONO = "'JetBrains Mono','Fira Code',monospace";
const SANS = "'Inter',-apple-system,sans-serif";

type Direction  = "LONG"|"SHORT";
type OpsResult  = "TP"|"SL"|"MANUAL"|null;
type Session    = "LDN"|"NY"|"CLOSED"|"WEEKEND";
type MTFSig     = "UP"|"DOWN"|"WAIT";
type Verdict    = "ENTRAR LONG"|"ENTRAR SHORT"|"ESPERAR";
type Strength   = "FUERTE"|"MODERADO"|"DEBIL";

interface Operation {
  id:string;fecha:string;direccion:Direction;
  precio_entrada:number;sl:number;tp:number;
  resultado:OpsResult;pnl:number|null;
}

interface LiveSignal {
  htf:MTFSig;mtf:MTFSig;m15:MTFSig;ltf:MTFSig;
  verdict:Verdict;strength:Strength;
  ema200:number|null;rsi:number|null;
  structure:PriceStructure;
  levels:StructureLevels|null;
  atr:number|null;
  fvgActive:boolean;
  d1Blocked:boolean;
  fvgBull:{top:number;bot:number}|null;
  fvgBear:{top:number;bot:number}|null;
}

const BINANCE_FUTURES = "https://fapi.binance.com/fapi/v1/klines";
async function fetchLiveCandles(tf:string,limit=250):Promise<Candle[]>{
  const r=await fetch(`${BINANCE_FUTURES}?symbol=XAUUSDT&interval=${tf}&limit=${limit}`);
  if(!r.ok)throw new Error(`Binance ${r.status} (${tf})`);
  const d=await r.json() as number[][];
  if(!Array.isArray(d)||!d.length)return[];
  return d.slice(0,-1).map(k=>({t:+k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]}));
}

function calcSignalScore(
  htf:MTFSig,mtf:MTFSig,m15:MTFSig,ltf:MTFSig,
  rsi:number|null,ema200:number|null,price:number,
  session:Session,structure:PriceStructure,fvgActive:boolean
):number{
  // Fin de semana — XAU/USD no opera, score bloqueado
  if(session==="WEEKEND")return 0;
  let s=0;
  if(htf!=="WAIT")s+=2;
  if(htf!=="WAIT"&&mtf===htf)s+=2;
  if(htf!=="WAIT"&&m15===htf)s+=1;
  if(htf!=="WAIT"&&ltf===htf)s+=1;
  if(ema200!=null&&price>0){if((htf==="UP"&&price>ema200)||(htf==="DOWN"&&price<ema200))s+=2;}
  if(rsi!=null){if((htf==="UP"&&rsi<70)||(htf==="DOWN"&&rsi>30))s+=1;}
  if((htf==="UP"&&structure==="BULLISH")||(htf==="DOWN"&&structure==="BEARISH"))s+=1;
  if(fvgActive)s+=1;
  // Sesión activa +1 — si está CLOSED el score no llega al máximo pero las señales siguen visibles
  if(session==="LDN"||session==="NY")s+=1;
  return Math.min(s,10);
}

function getSession():Session{
  const now=new Date();
  const day=now.getUTCDay();
  const u=now.getUTCHours()*60+now.getUTCMinutes();
  if(day===6)return"WEEKEND";
  if(day===0&&u<1320)return"WEEKEND";
  // LDN: 07:00-12:00 UTC = 2:00 AM - 7:00 AM COL
  if(u>=420&&u<720)return"LDN";
  // NY:  13:00-18:00 UTC = 8:00 AM - 1:00 PM COL (incluye overlap + datos macro)
  if(u>=780&&u<1080)return"NY";
  return"CLOSED";
}
function getColTime():string{
  const c=new Date(Date.now()-5*3600000);
  return`${c.getUTCHours().toString().padStart(2,"0")}:${c.getUTCMinutes().toString().padStart(2,"0")} COL`;
}
function getNextSession():{label:string;mins:number}{
  const now=new Date();
  const day=now.getUTCDay();
  const u=now.getUTCHours()*60+now.getUTCMinutes();
  const DAY=1440;
  // Fin de semana → próximo lunes LDN (07:00 UTC)
  if(day===6){const minsToMon=(DAY-u)+DAY+420;return{label:"LDN Lunes",mins:minsToMon};}
  if(day===0&&u<1320){const minsToMon=(DAY-u)+420;return{label:"LDN Lunes",mins:minsToMon};}
  // Días de semana
  if(u<420)return{label:"LDN Open",mins:420-u};
  if(u>=720&&u<780)return{label:"NY Open",mins:780-u};
  const minsToLdn=u>=1080?DAY-u+420:420-u;
  return{label:"LDN mañana",mins:minsToLdn};
}
function fmtCountdown(mins:number):string{
  const h=Math.floor(mins/60),m=mins%60;
  return h>0?`${h}h ${m}m`:`${m}m`;
}

// ── Componentes base ──────────────────────────────────────────────────────────

const Card=({children,style}:{children:React.ReactNode;style?:React.CSSProperties})=>(
  <div style={{background:T.s1,borderRadius:8,border:`1px solid ${T.border}`,padding:"10px 12px",...style}}>{children}</div>
);
const SecTitle=({children}:{children:React.ReactNode})=>(
  <div style={{fontFamily:SANS,fontSize:11,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:T.muted,marginBottom:6}}>{children}</div>
);
const Badge=({children,color}:{children:React.ReactNode;color:string})=>(
  <span style={{fontFamily:MONO,fontSize:10,fontWeight:700,padding:"2px 7px",borderRadius:20,background:`${color}18`,color,border:`1px solid ${color}30`}}>{children}</span>
);
const MTFSigBadge=({sig}:{sig:MTFSig})=>{
  const m:Record<MTFSig,{label:string;color:string}>={
    UP:{label:"▲ UP",color:T.up},DOWN:{label:"▼ DOWN",color:T.down},WAIT:{label:"- WAIT",color:T.muted}};
  const{label,color}=m[sig];return<Badge color={color}>{label}</Badge>;
};

// ── CopyButton ────────────────────────────────────────────────────────────────
function CopyButton({value}:{value:string}){
  const[copied,setCopied]=useState(false);
  const copy=()=>{
    navigator.clipboard.writeText(value).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),1500);});
  };
  return(
    <button onClick={copy} style={{
      fontFamily:MONO,fontSize:8,fontWeight:700,padding:"2px 6px",borderRadius:4,cursor:"pointer",
      border:`1px solid ${copied?T.up:T.border}`,
      background:copied?T.upBg:T.s2,color:copied?T.up:T.muted,
      transition:"all 0.2s",minWidth:36
    }}>{copied?"✓":"copiar"}</button>
  );
}

// ── MT5 Block ─────────────────────────────────────────────────────────────────
// Solo aparece cuando score >= 6 y hay señal de entrada.
// Muestra los 3 precios exactos listos para copiar en MT5.
interface MT5BlockProps{
  signal:LiveSignal|null;
  score:number;
  price:number;
}
function MT5Block({signal,score,price}:MT5BlockProps){
  if(!signal||score<6||signal.verdict==="ESPERAR")return null;
  const levels=signal.levels;
  const isLong=signal.verdict==="ENTRAR LONG";
  const color=isLong?T.up:T.down;
  const atrVal=signal.atr;

  // Si no hay niveles de estructura, usar % como fallback
  const entry = price>0?price.toFixed(2):"--";
  const sl    = levels?levels.slPrice.toFixed(2):price>0?(isLong?price*0.9925:price*1.0075).toFixed(2):"--";
  const tp    = levels?levels.tpPrice.toFixed(2):price>0?(isLong?price*1.03:price*0.97).toFixed(2):"--";
  const slPct = levels?`${levels.slPct.toFixed(2)}%`:"--";
  const tpPct = levels?`${levels.tpPct.toFixed(2)}%`:"--";

  return(
    <Card style={{marginBottom:4,padding:"8px 10px",border:`1px solid ${color}40`,background:`${color}08`}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
        <div style={{fontFamily:SANS,fontSize:9,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color}}>
          Orden MT5 · {isLong?"LONG":"SHORT"}
        </div>
        {atrVal&&(
          <span style={{fontFamily:MONO,fontSize:8,color:T.muted}}>
            ATR ~${atrVal.toFixed(1)}/vela
          </span>
        )}
      </div>

      {/* Regla de entrada */}
      <div style={{fontFamily:SANS,fontSize:8,color:T.muted,marginBottom:6,padding:"3px 6px",
        background:T.s2,borderRadius:4,borderLeft:`2px solid ${color}`}}>
        Regla: entrar en apertura de la vela siguiente
      </div>

      {/* Los 3 precios */}
      {[
        {lbl:"ENTRADA",val:entry,color:T.gold,hint:"market"},
        {lbl:"SL",     val:sl,   color:T.down,hint:slPct},
        {lbl:"TP",     val:tp,   color:T.up,  hint:levels?.tpSource==="session"?"PDH/PDL 🎯":levels?.tpSource==="structure"?"estructura":tpPct},
      ].map(({lbl,val,color:c,hint})=>(
        <div key={lbl} style={{display:"flex",alignItems:"center",justifyContent:"space-between",
          padding:"4px 6px",borderRadius:5,background:T.s2,marginBottom:3}}>
          <div>
            <span style={{fontFamily:MONO,fontSize:8,color:T.muted,marginRight:6}}>{lbl}</span>
            <span style={{fontFamily:MONO,fontSize:13,fontWeight:700,color:c}}>${val}</span>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:5}}>
            <span style={{fontFamily:MONO,fontSize:8,color:T.dim}}>{hint}</span>
            <CopyButton value={val}/>
          </div>
        </div>
      ))}

      {/* Estructura que generó los niveles */}
      {levels&&(
        <div style={{marginTop:4,fontFamily:MONO,fontSize:8,color:T.muted,textAlign:"center"}}>
          Estructura: {levels.structure==="BULLISH"?"HH/HL ▲":levels.structure==="BEARISH"?"LH/LL ▼":"NEUTRAL"}
        </div>
      )}
    </Card>
  );
}

// ── Checklist ─────────────────────────────────────────────────────────────────
interface ChecklistProps{
  session:Session;signal:LiveSignal|null;price:number;
  signalScore:number;hasNews:boolean;onToggleNews:()=>void;
}
function Checklist({session,signal,price,signalScore,hasNews,onToggleNews}:ChecklistProps){
  const ema200=signal?.ema200??null,rsi=signal?.rsi??null;
  const checks=[
    session==="LDN"||session==="NY",
    ema200!=null&&price>0&&Math.abs(price-ema200)/ema200>0.002,
    signal!=null&&signal.htf!=="WAIT"&&signal.htf===signal.mtf,
    rsi!=null&&rsi>=30&&rsi<=70,
    !hasNews,
    signalScore>=6,
  ];
  const passed=checks.filter(Boolean).length,allOk=passed===6;
  const items=["Sesion LDN/NY activa","EMA200 sesgo claro","HTF + MTF alineados",
    `RSI ok${rsi!=null?` (${rsi.toFixed(0)})`:""}`,
    "Sin noticia 30M",
    `Score >= 6 (${signalScore})`];
  return(
    <Card style={{marginBottom:4,padding:"7px 10px"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:5}}>
        <SecTitle>Checklist XAU/USD</SecTitle>
        <span style={{fontFamily:MONO,fontSize:9,color:allOk?T.up:passed>=4?T.wait:T.muted}}>{passed}/6</span>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:2}}>
        {items.map((lbl,i)=>{
          const isNews = i===4;
          return(
            <div key={i} style={{display:"flex",alignItems:"center",justifyContent:"space-between",
              padding:"3px 7px",borderRadius:4,fontSize:9,
              background:checks[i]?T.upBg:T.dnBg,color:checks[i]?T.up:T.down,
              border:`1px solid ${checks[i]?T.upBorder:T.dnBorder}`}}>
              <div style={{display:"flex",alignItems:"center",gap:5}}>
                <span style={{fontSize:10,width:12,textAlign:"center",flexShrink:0}}>{checks[i]?"✓":"✗"}</span>
                {lbl}
              </div>
              {isNews&&(
                <button onClick={onToggleNews} style={{
                  fontFamily:MONO,fontSize:7,fontWeight:700,padding:"1px 5px",borderRadius:3,cursor:"pointer",
                  border:`1px solid ${hasNews?T.down:T.border}`,
                  background:hasNews?T.dnBg:T.s2,
                  color:hasNews?T.down:T.muted
                }}>{hasNews?"⚠️ HAY":"OK"}</button>
              )}
            </div>
          );
        })}
      </div>
      <div style={{marginTop:5,padding:"5px",borderRadius:5,textAlign:"center",fontSize:9,fontFamily:MONO,fontWeight:700,
        background:allOk?T.upBg:T.dnBg,color:allOk?T.up:T.down,border:`1px solid ${allOk?T.upBorder:T.dnBorder}`}}>
        {allOk?`OK · ${signal?.htf==="UP"?"BUSCAR LONG":"BUSCAR SHORT"}`:`${passed}/6 condiciones · ESPERAR`}
      </div>
    </Card>
  );
}

// ── OperationForm ─────────────────────────────────────────────────────────────
interface OpFormProps{livePrice:number;userId:string;onSaved:(op:Operation)=>void;fillHeight?:boolean;slPct?:number;tpPct?:number;structureSL?:number;structureTP?:number;}
function OperationForm({livePrice,userId,onSaved,fillHeight,slPct=1,tpPct=4,structureSL,structureTP}:OpFormProps){
  const[dir,setDir]=useState<Direction>("LONG");
  const[entry,setEntry]=useState("");const[sl,setSL]=useState("");const[tp,setTP]=useState("");
  const[capital,setCap]=useState("");const[riskPct,setRisk]=useState("1");
  const[saving,setSaving]=useState(false);
  const[useStructure,setUseStructure]=useState(false);

  useEffect(()=>{
    const e=parseFloat(entry);if(!e||e<=0){setSL("");setTP("");return;}
    if(useStructure&&structureSL&&structureTP){
      setSL(structureSL.toFixed(2));setTP(structureTP.toFixed(2));
    }else{
      const{sl:slv,tp:tpv}=calcOpLevels(e,dir,slPct/100,tpPct/100);setSL(slv.toFixed(2));setTP(tpv.toFixed(2));
    }
  },[entry,dir,slPct,tpPct,useStructure,structureSL,structureTP]);

  const fillLive=()=>{if(livePrice>0)setEntry(livePrice.toFixed(2));};
  const eNum=parseFloat(entry)||0,slNum=parseFloat(sl)||0,tpNum=parseFloat(tp)||0;
  const capNum=parseFloat(capital)||0,rNum=parseFloat(riskPct)||1;
  const riskPts=Math.abs(eNum-slNum),gainPts=Math.abs(tpNum-eNum);
  const rr=riskPts>0?gainPts/riskPts:0;
  const lotSize=capNum>0&&riskPts>0?calcLotSize(capNum,rNum,riskPts):0;
  const dollarR=capNum>0?capNum*(rNum/100):0;
  const save=async()=>{
    if(!eNum||!slNum||!tpNum)return;setSaving(true);
    try{
      const fecha=new Date().toLocaleString("es-CO",{timeZone:"America/Bogota",hour:"2-digit",minute:"2-digit",day:"2-digit",month:"2-digit"});
      const res=await fetch("/api/operations",{method:"POST",headers:{"Content-Type":"application/json","x-user-id":userId},
        body:JSON.stringify({fecha,direccion:dir,precio_entrada:eNum,sl:slNum,tp:tpNum})});
      if(!res.ok)throw new Error("Save failed");
      const op=await res.json() as Operation;onSaved(op);setEntry("");setSL("");setTP("");
    }catch(e){console.error(e);}finally{setSaving(false);}
  };
  const inp:React.CSSProperties={width:"100%",background:T.s2,border:`1px solid ${T.border2}`,
    borderRadius:5,padding:"5px 8px",color:T.text,fontFamily:SANS,fontSize:12,outline:"none",boxSizing:"border-box"};
  const lbl:React.CSSProperties={display:"block",fontSize:8,fontWeight:600,letterSpacing:"0.06em",
    textTransform:"uppercase",color:T.muted,marginBottom:3};
  return(
    <Card style={{padding:"7px 10px",...(fillHeight?{flex:1,display:"flex",flexDirection:"column"}:{})}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
        <SecTitle>Nueva Op XAU/USD</SecTitle>
        <div style={{display:"flex",gap:4}}>
          {structureSL&&structureTP&&(
            <button onClick={()=>setUseStructure(u=>!u)} style={{
              fontFamily:MONO,fontSize:8,fontWeight:700,padding:"2px 6px",borderRadius:4,cursor:"pointer",
              border:`1px solid ${useStructure?T.accent:T.border}`,
              background:useStructure?`${T.accent}18`:T.s2,color:useStructure?T.accent:T.muted
            }}>estructura</button>
          )}
          <button onClick={fillLive} style={{fontFamily:SANS,fontSize:9,fontWeight:700,
            background:T.s3,border:`1px solid ${T.border2}`,borderRadius:5,padding:"2px 7px",color:T.gold,cursor:"pointer"}}>
            ${livePrice>0?livePrice.toFixed(2):"--"} Usar
          </button>
        </div>
      </div>
      <div style={{marginBottom:5}}>
        <label style={lbl}>Direccion</label>
        <select value={dir} onChange={e=>setDir(e.target.value as Direction)} style={{...inp,cursor:"pointer"}}>
          <option value="LONG">▲ LONG</option><option value="SHORT">▼ SHORT</option>
        </select>
      </div>
      <div style={{marginBottom:5}}>
        <label style={lbl}>Precio entrada</label>
        <input type="number" value={entry} placeholder="3320.00" onChange={e=>setEntry(e.target.value)} style={inp}/>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:5,marginBottom:5}}>
        <div><label style={{...lbl,color:T.down}}>SL {useStructure?"(estructura)":`(${slPct}%)`}</label>
          <input type="number" value={sl} placeholder="SL" onChange={e=>setSL(e.target.value)} style={inp}/></div>
        <div><label style={{...lbl,color:T.up}}>TP {useStructure?"(estructura)":`(${tpPct}%)`}</label>
          <input type="number" value={tp} placeholder="TP" onChange={e=>setTP(e.target.value)} style={inp}/></div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:5,marginBottom:5}}>
        <div><label style={lbl}>Capital $</label>
          <input type="number" value={capital} placeholder="10000" onChange={e=>setCap(e.target.value)} style={inp}/></div>
        <div><label style={lbl}>Riesgo %</label>
          <input type="number" value={riskPct} placeholder="1" onChange={e=>setRisk(e.target.value)} style={inp}/></div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:3,marginBottom:6}}>
        {[
          {l:"R:R",   v:rr>0?`${rr.toFixed(1)}:1`:"--",        c:rr>=2?T.up:T.wait},
          {l:"Lotes", v:lotSize>0?`${lotSize.toFixed(2)}`:"--", c:T.gold},
          {l:"Riesgo",v:dollarR>0?`$${dollarR.toFixed(0)}`:"--",c:T.down},
          {l:"Ganar", v:lotSize>0&&gainPts>0?`$${(lotSize*gainPts*100).toFixed(0)}`:gainPts>0?`${gainPts.toFixed(1)}pts`:"--",c:T.up},
        ].map(({l,v,c})=>(
          <div key={l} style={{background:T.s2,borderRadius:4,padding:"4px 5px"}}>
            <div style={{fontSize:7,fontWeight:600,color:T.muted,letterSpacing:"0.05em",textTransform:"uppercase",marginBottom:2}}>{l}</div>
            <div style={{fontFamily:MONO,fontSize:11,fontWeight:700,color:c}}>{v}</div>
          </div>
        ))}
      </div>
      <button onClick={save} disabled={saving||!eNum} style={{width:"100%",padding:"8px",
        background:"linear-gradient(135deg,#C9A227,#E8B84B)",color:"#1D1D1F",
        fontFamily:SANS,fontSize:12,fontWeight:700,border:"none",borderRadius:6,
        cursor:saving?"not-allowed":"pointer",opacity:saving?0.6:1,
        ...(fillHeight?{marginTop:"auto"}:{})}}>
        {saving?"Guardando...":"+ Registrar operacion"}
      </button>
    </Card>
  );
}

// ── SessionBanner ─────────────────────────────────────────────────────────────
function SessionBanner({session}:{session:Session}){
  const[clock,setClock]=useState("--");
  const[next,setNext]=useState<{label:string;mins:number}|null>(null);
  useEffect(()=>{
    setClock(getColTime());
    if(session==="CLOSED"||session==="WEEKEND")setNext(getNextSession());
    const iv=setInterval(()=>{setClock(getColTime());if(session==="CLOSED"||session==="WEEKEND")setNext(getNextSession());},60000);
    return()=>clearInterval(iv);
  },[session]);
  const m:Record<Session,{label:string;sub:string;color:string;bg:string;border:string}>={
    LDN:{label:"LDN",sub:"2:00 AM - 7:00 AM Colombia · ACTIVA",color:T.wait,bg:T.warnBg,border:T.warnBorder},
    NY:{label:"NY OPEN",sub:"8:00 AM - 1:00 PM Colombia · ACTIVA + OVERLAP",color:T.up,bg:T.upBg,border:T.upBorder},
    CLOSED:{label:"MERCADO",sub:"Fuera de ventana operativa",color:T.muted,bg:T.s1,border:T.border},
    WEEKEND:{label:"FIN DE SEMANA",sub:"Mercado cerrado · XAU/USD no opera",color:T.down,bg:T.dnBg,border:T.dnBorder},
  };
  const s=m[session];
  return(
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",
      padding:"6px 10px",borderRadius:7,background:s.bg,border:`1px solid ${s.border}`,marginBottom:6}}>
      <div style={{display:"flex",alignItems:"center",gap:8}}>
        <div style={{width:7,height:7,borderRadius:"50%",background:s.color}}/>
        <div>
          <div style={{fontFamily:MONO,fontSize:11,fontWeight:700,color:s.color}}>{s.label}</div>
          <div style={{fontFamily:SANS,fontSize:9,color:T.muted}}>{s.sub}</div>
          {(session==="CLOSED"||session==="WEEKEND")&&next&&(
            <div style={{fontFamily:MONO,fontSize:9,color:session==="WEEKEND"?T.down:T.accent,marginTop:2}}>
              ⏱ {next.label} en {fmtCountdown(next.mins)}
            </div>
          )}
        </div>
      </div>
      <div style={{fontFamily:MONO,fontSize:11,color:T.muted}}>{clock}</div>
    </div>
  );
}

// ── VerdictCard ───────────────────────────────────────────────────────────────
function VerdictCard({signal,price,score}:{signal:LiveSignal|null;price:number;score:number}){
  const[candleMins,setCandleMins]=useState<number>(0);
  useEffect(()=>{
    function calc(){
      const now=new Date();
      const mins=now.getUTCMinutes();
      const secs=now.getUTCSeconds();
      // Minutos restantes hasta cierre de vela 1H
      setCandleMins(59-mins+(secs<30?1:0));
    }
    calc();
    const iv=setInterval(calc,30000);
    return()=>clearInterval(iv);
  },[]);
  if(!signal)return(
    <Card style={{marginBottom:6}}>
      <div style={{fontFamily:MONO,fontSize:11,color:T.muted,textAlign:"center",padding:"8px 0"}}>Cargando señal...</div>
    </Card>
  );
  const verdict=score>=6?signal.verdict:"ESPERAR";
  const vMap:Record<Verdict,{color:string;border:string}>={
    "ENTRAR LONG":{color:T.up,border:T.up},"ENTRAR SHORT":{color:T.down,border:T.down},"ESPERAR":{color:T.muted,border:T.dim}};
  const{color,border}=vMap[verdict];
  const sc:Record<Strength,string>={FUERTE:T.up,MODERADO:T.wait,DEBIL:T.muted};
  const structureLabel=signal.structure==="BULLISH"?"HH/HL ▲":signal.structure==="BEARISH"?"LH/LL ▼":"-";
  return(
    <Card style={{borderLeft:`3px solid ${border}`,marginBottom:6}}>
      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:8,gap:8}}>
        <div>
          <div style={{fontFamily:SANS,fontSize:8,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:T.muted,marginBottom:4}}>Signal MTF · XAU/USD</div>
          <div style={{fontFamily:MONO,fontSize:24,fontWeight:700,lineHeight:1,letterSpacing:-1,color}}>
            {verdict==="ENTRAR LONG"?"▲ ENTRAR LONG":verdict==="ENTRAR SHORT"?"▼ ENTRAR SHORT":"- ESPERAR"}
          </div>
          <div style={{marginTop:5,display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
            <Badge color={sc[signal.strength]}>{signal.strength}</Badge>
            <span style={{fontFamily:MONO,fontSize:10,color:score>=6?T.up:T.wait}}>Score {score}/10</span>
            <span style={{fontFamily:MONO,fontSize:9,color:signal.structure==="BULLISH"?T.up:signal.structure==="BEARISH"?T.down:T.muted}}>{structureLabel}</span>
            {signal.fvgActive&&<Badge color={T.accent}>FVG ✓</Badge>}
            {signal.d1Blocked&&<Badge color={T.down}>D1 BLOQUEADO</Badge>}
          </div>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontFamily:MONO,fontSize:20,fontWeight:700,color:T.gold,lineHeight:1}}>${price>0?price.toFixed(2):"--"}</div>
          <div style={{marginTop:4}}><Badge color={T.accent}>XAU/USD</Badge></div>
          {signal.ema200!=null&&<div style={{marginTop:4,fontFamily:MONO,fontSize:9,color:T.muted}}>EMA200 {signal.ema200.toFixed(0)}</div>}
          {signal.atr!=null&&<div style={{marginTop:2,fontFamily:MONO,fontSize:9,color:T.dim}}>ATR {signal.atr.toFixed(1)}</div>}
          <div style={{marginTop:2,fontFamily:MONO,fontSize:9,color:candleMins<=5?T.wait:T.dim}}>
            Vela cierra en {candleMins}m
          </div>
        </div>
      </div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        {[
          {label:"HTF 4H",sig:signal.htf},{label:"MTF 1H",sig:signal.mtf},
          {label:"15M",sig:signal.m15},{label:"LTF 5M",sig:signal.ltf},
        ].map(({label,sig})=>(
          <div key={label} style={{display:"flex",alignItems:"center",gap:4}}>
            <span style={{fontFamily:SANS,fontSize:9,color:T.muted}}>{label}</span>
            <MTFSigBadge sig={sig}/>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ── HistoryList ───────────────────────────────────────────────────────────────
function HistoryList({ops,userId,onUpdate}:{ops:Operation[];userId:string;onUpdate:(id:string,resultado:"TP"|"SL"|"MANUAL")=>void}){
  if(!ops.length)return<div style={{fontFamily:SANS,fontSize:10,color:T.muted,padding:"10px 0",textAlign:"center"}}>Sin operaciones registradas.</div>;
  return(
    <div style={{display:"flex",flexDirection:"column",gap:4}}>
      {ops.map(op=>(
        <div key={op.id} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",borderRadius:6,
          background:T.s2,fontSize:10,borderLeft:`2px solid ${op.resultado==="TP"?T.up:op.resultado==="SL"?T.down:T.dim}`}}>
          <span style={{color:op.direccion==="LONG"?T.up:T.down,fontFamily:MONO,minWidth:12}}>{op.direccion==="LONG"?"▲":"▼"}</span>
          <span style={{color:T.muted,fontFamily:MONO,minWidth:40}}>{op.fecha}</span>
          <span style={{color:T.text,fontFamily:MONO,flex:1}}>${op.precio_entrada.toFixed(0)}</span>
          {op.resultado==null?(
            <div style={{display:"flex",gap:4}}>
              {(["TP","SL","MANUAL"]as const).map(r=>(
                <button key={r} onClick={()=>onUpdate(op.id,r)} style={{fontFamily:SANS,fontSize:8,fontWeight:700,
                  padding:"2px 6px",borderRadius:4,cursor:"pointer",border:"none",
                  background:r==="TP"?T.up:r==="SL"?T.down:T.s4,color:r==="TP"||r==="SL"?"#000":T.muted}}>{r}</button>
              ))}
            </div>
          ):(
            <span style={{fontFamily:MONO,fontWeight:700,fontSize:10,color:op.pnl!=null&&op.pnl>=0?T.up:T.down}}>
              {op.resultado} {op.pnl!=null?`${op.pnl>=0?"+":""}${op.pnl.toFixed(1)}%`:""}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

// ── ROOT ──────────────────────────────────────────────────────────────────────
export default function LiveTerminal({userId,price,connected}:{userId:string;price:number;connected:boolean}){
  const[session,  setSession] = useState<Session>("CLOSED");
  const[signal,   setSignal]  = useState<LiveSignal|null>(null);
  const[ops,      setOps]     = useState<Operation[]>([]);
  const[sigError, setSigError]= useState<string|null>(null);
  const[hasNews,  setHasNews] = useState(false);
  const[d1Bias,   setD1Bias]  = useState<MTFSig>("WAIT");

  const SL_OPTIONS = [0.5,0.75,1,1.5,2,2.5,3,3.5,4];
  const TP_OPTIONS = [0.5,0.75,1,1.5,2,2.5,3,3.5,4];
  const[htfTf,setHtfTf] = useState<"4h"|"1h">("1h");
  const[ltfTf,setLtfTf] = useState<"15m"|"5m">("15m");
  const[slPct,setSlPct] = useState(0.75);
  const[tpPct,setTpPct] = useState(3);

  const handleHtfChange=(tf:"4h"|"1h")=>{
    setHtfTf(tf);
    setLtfTf(tf==="1h"?"5m":"15m");
  };

  const mtfTfLabel = htfTf==="4h"?"1H":"15M";
  const ltfOptions: {value:"15m"|"5m";label:string}[] = htfTf==="4h"
    ?[{value:"15m",label:"15M"},{value:"5m",label:"5M"}]
    :[{value:"5m",label:"5M"}];

  const signalScore=signal
    ?calcSignalScore(signal.htf,signal.mtf,signal.m15,signal.ltf,signal.rsi,signal.ema200,price,session,signal.structure,signal.fvgActive)
    :0;

  // Sesión
  useEffect(()=>{
    setSession(getSession());
    const iv=setInterval(()=>setSession(getSession()),30000);
    return()=>clearInterval(iv);
  },[]);

  // Señales MTF + D1 bias
  useEffect(()=>{
    async function load(){
      setSigError(null);
      try{
        const mtfTf=htfTf==="4h"?"1h":"15m";
        const[htfC,mtfC,m15C,ltfC,d1C]=await Promise.all([
          fetchLiveCandles(htfTf,250),
          fetchLiveCandles(mtfTf,250),
          fetchLiveCandles("15m",150),
          fetchLiveCandles(ltfTf,120),
          fetchLiveCandles("1d",60),   // D1 bias
        ]);
        if(htfC.length<50||mtfC.length<50){setSigError("Datos insuficientes de Binance");return;}

        const htfInd=precompute(htfC),mtfInd=precompute(mtfC);
        const m15Ind=precompute(m15C),ltfInd=precompute(ltfC);

        // D1 bias + PDH/PDL
        let d1SigLocal:MTFSig="WAIT";
        let sessionLevels:SessionLevels={pdh:null,pdl:null};
        if(d1C.length>=50){
          const d1Ind=precompute(d1C);
          const{sig:d1Sig}=htfSignalAt(d1Ind,d1C.length-1);
          d1SigLocal=d1Sig;
          setD1Bias(d1Sig);
          sessionLevels=getPDHL(d1C);
        }

        const v=getLiveVerdict(htfInd,mtfInd,htfC.length-1,mtfC.length-1,price,d1SigLocal,sessionLevels);
        const m15Sig=m15C.length>=50?mtfSignalAt(m15Ind,m15C.length-1):"WAIT";
        const ltfSig=ltfC.length>=50?mtfSignalAt(ltfInd,ltfC.length-1):"WAIT";
        const atrVal=htfInd.atr[htfC.length-1]??null;
        const fvgNow=htfInd.fvg[htfC.length-1];

        setSignal({
          htf:v.htf,mtf:v.mtf,m15:m15Sig,ltf:ltfSig,
          verdict:v.verdict,strength:v.strength as Strength,
          ema200:v.ema200,rsi:v.rsi,
          structure:v.structure,
          levels:v.levels,
          atr:atrVal,
          fvgActive:v.fvgActive,
          d1Blocked:v.d1Blocked,
          fvgBull:fvgNow?.bull??null,
          fvgBear:fvgNow?.bear??null,
        });
      }catch(err){
        setSigError(err instanceof Error?err.message:"Error desconocido");
      }
    }
    load();
    const iv=setInterval(load,15*60*1000);
    return()=>clearInterval(iv);
  },[htfTf,ltfTf,price]);

  // Operaciones
  useEffect(()=>{
    if(!userId)return;
    fetch("/api/operations",{headers:{"x-user-id":userId}})
      .then(r=>r.json()).then(d=>{if(Array.isArray(d))setOps(d);}).catch(console.error);
  },[userId]);

  const handleSaved=useCallback((op:Operation)=>setOps(p=>[op,...p]),[]);
  const handleUpdate=useCallback(async(id:string,resultado:"TP"|"SL"|"MANUAL")=>{
    const op=ops.find(o=>o.id===id);if(!op)return;
    const pnl=resultado==="TP"?Math.abs(op.tp-op.precio_entrada):resultado==="SL"?-Math.abs(op.precio_entrada-op.sl):0;
    const pnlPct=op.precio_entrada>0?(pnl/op.precio_entrada)*100:0;
    try{
      await fetch("/api/operations",{method:"PATCH",headers:{"Content-Type":"application/json","x-user-id":userId},
        body:JSON.stringify({id,resultado,pnl:pnlPct})});
      setOps(p=>p.map(o=>o.id===id?{...o,resultado,pnl:pnlPct}:o));
    }catch(e){console.error(e);}
  },[ops,userId]);

  const closed=ops.filter(o=>o.resultado!==null);
  const wins=closed.filter(o=>o.resultado==="TP").length;
  const wr=closed.length>0?Math.round((wins/closed.length)*100):0;
  const pnlTotal=closed.reduce((a,o)=>a+(o.pnl??0),0);

  const mtfRows=[
    {key:"htf",tf:htfTf.toUpperCase(),rol:"Tendencia",   sig:(signal?.htf??"WAIT") as MTFSig},
    {key:"mtf",tf:mtfTfLabel,         rol:"Confirmación",sig:(signal?.mtf??"WAIT") as MTFSig},
    {key:"m15",tf:"15M",              rol:"Refinamiento",sig:(signal?.m15??"WAIT") as MTFSig},
    {key:"ltf",tf:ltfTf.toUpperCase(),rol:"Entrada",     sig:(signal?.ltf??"WAIT") as MTFSig},
  ];

  const structureColor=signal?.structure==="BULLISH"?T.up:signal?.structure==="BEARISH"?T.down:T.muted;
  const structureLabel=signal?.structure==="BULLISH"?"HH/HL ▲":signal?.structure==="BEARISH"?"LH/LL ▼":"NEUTRAL";
  const d1Color=d1Bias==="UP"?T.up:d1Bias==="DOWN"?T.down:T.muted;
  const d1Label=d1Bias==="UP"?"▲ ALCISTA":d1Bias==="DOWN"?"▼ BAJISTA":"- NEUTRAL";

  return(
    <>
      <style>{`
        .tp3-root{display:grid;grid-template-columns:360px 1fr 360px;grid-template-rows:1fr;height:100%;overflow:hidden;}
        .tp3-sidebar{grid-column:1;grid-row:1;}
        .tp3-main{grid-column:2;grid-row:1;}
        .tp3-right{grid-column:3;grid-row:1;}
        @media(max-width:1100px){.tp3-root{grid-template-columns:1fr 300px;}.tp3-sidebar{display:none;}.tp3-main{grid-column:1;}.tp3-right{grid-column:2;}}
        @media(max-width:700px){
          .tp3-root{grid-template-columns:1fr;}
          .tp3-sidebar{display:none!important;}
          .tp3-right{display:none!important;}
          .tp3-main{grid-column:1;grid-row:1;}
        }
      `}</style>

      <div className="tp3-root" style={{fontFamily:SANS,color:T.text,background:T.bg}}>

        {/* ── LEFT SIDEBAR ── */}
        <div className="tp3-sidebar"
          style={{background:T.bg,borderRight:`1px solid ${T.border}`,overflowY:"auto",padding:"8px 6px",display:"flex",flexDirection:"column",height:"100%"}}>

          {/* Fuentes */}
          <Card style={{marginBottom:6}}>
            <SecTitle>Fuentes de Datos</SecTitle>
            <div style={{display:"flex",flexDirection:"column",gap:4}}>
              {[
                {label:"Precio en vivo",sub:"TwelveData · WS tick",live:connected},
                {label:"Señales MTF",   sub:"Binance Futures · REST 5m",live:!!signal},
              ].map(({label,sub,live})=>(
                <div key={label} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"4px 7px",borderRadius:5,background:T.s2}}>
                  <div>
                    <div style={{fontFamily:SANS,fontSize:9,fontWeight:700,color:T.text}}>{label}</div>
                    <div style={{fontFamily:MONO,fontSize:8,color:T.muted}}>{sub}</div>
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:5}}>
                    <div style={{width:5,height:5,borderRadius:"50%",background:live?T.up:T.muted}}/>
                    <span style={{fontFamily:MONO,fontSize:8,color:live?T.up:T.muted}}>{live?"LIVE":"..."}</span>
                  </div>
                </div>
              ))}
            </div>
            {sigError&&<div style={{marginTop:6,padding:"4px 8px",borderRadius:5,background:T.dnBg,border:`1px solid ${T.dnBorder}`,fontFamily:MONO,fontSize:9,color:T.down}}>! {sigError}</div>}
          </Card>

          {/* MTF Matrix */}
          <Card style={{marginBottom:6}}>
            <SecTitle>MTF Matrix</SecTitle>

            {/* Selectores HTF / LTF */}
            <div style={{display:"flex",gap:3,marginBottom:6}}>
              {(["4h","1h"]as const).map(tf=>(
                <button key={tf} onClick={()=>handleHtfChange(tf)} style={{
                  flex:1,padding:"3px 0",borderRadius:5,cursor:"pointer",fontFamily:MONO,fontSize:9,fontWeight:700,
                  border:`1px solid ${htfTf===tf?T.gold:T.border}`,
                  background:htfTf===tf?"rgba(212,175,55,0.12)":T.s2,
                  color:htfTf===tf?T.gold:T.muted,
                }}>{tf.toUpperCase()}</button>
              ))}
              {ltfOptions.map(({value,label})=>(
                <button key={value} onClick={()=>setLtfTf(value)} style={{
                  flex:1,padding:"3px 0",borderRadius:5,cursor:"pointer",fontFamily:MONO,fontSize:9,fontWeight:700,
                  border:`1px solid ${ltfTf===value?T.accent:T.border}`,
                  background:ltfTf===value?`${T.accent}18`:T.s2,
                  color:ltfTf===value?T.accent:T.muted,
                }}>{label}</button>
              ))}
            </div>

            {/* D1 Bias */}
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",
              padding:"6px 0",borderBottom:`1px solid ${T.border}`}}>
              <div>
                <span style={{fontFamily:MONO,fontSize:12,color:T.muted,fontWeight:700,minWidth:32}}>D1</span>
                <span style={{fontFamily:SANS,fontSize:10,color:T.dim,marginLeft:6}}>Sesgo diario</span>
              </div>
              <Badge color={d1Color}>{d1Label}</Badge>
            </div>

            {/* Filas MTF */}
            {mtfRows.map(({key,tf,rol,sig})=>(
              <div key={key} style={{display:"flex",alignItems:"center",justifyContent:"space-between",
                padding:"6px 0",borderBottom:`1px solid ${T.border}`}}>
                <div>
                  <span style={{fontFamily:MONO,fontSize:12,color:T.muted,fontWeight:700,minWidth:32}}>{tf}</span>
                  <span style={{fontFamily:SANS,fontSize:10,color:T.dim,marginLeft:6}}>{rol}</span>
                </div>
                <MTFSigBadge sig={sig}/>
              </div>
            ))}

            {/* Estructura fractal */}
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",
              padding:"6px 0",borderBottom:`1px solid ${T.border}`}}>
              <div>
                <span style={{fontFamily:MONO,fontSize:12,color:T.muted,fontWeight:700,minWidth:32}}>EST</span>
                <span style={{fontFamily:SANS,fontSize:10,color:T.dim,marginLeft:6}}>Estructura</span>
              </div>
              <Badge color={structureColor}>{structureLabel}</Badge>
            </div>

            {/* FVG activa */}
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",
              padding:"6px 0",borderBottom:`1px solid ${T.border}`}}>
              <div>
                <span style={{fontFamily:MONO,fontSize:12,color:T.muted,fontWeight:700,minWidth:32}}>FVG</span>
                <span style={{fontFamily:SANS,fontSize:10,color:T.dim,marginLeft:6}}>Desequilibrio</span>
              </div>
              {signal?.fvgBull&&<Badge color={T.up}>▲ {signal.fvgBull.bot.toFixed(0)}–{signal.fvgBull.top.toFixed(0)}</Badge>}
              {signal?.fvgBear&&<Badge color={T.down}>▼ {signal.fvgBear.bot.toFixed(0)}–{signal.fvgBear.top.toFixed(0)}</Badge>}
              {!signal?.fvgBull&&!signal?.fvgBear&&<Badge color={T.muted}>- NONE</Badge>}
            </div>

            {/* PDH / PDL */}
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",
              padding:"6px 0",borderBottom:`1px solid ${T.border}`}}>
              <div>
                <span style={{fontFamily:MONO,fontSize:12,color:T.muted,fontWeight:700,minWidth:32}}>PDH</span>
                <span style={{fontFamily:SANS,fontSize:10,color:T.dim,marginLeft:6}}>Liquidez</span>
              </div>
              <div style={{display:"flex",gap:4,alignItems:"center"}}>
                {signal?.levels?.tpSource==="session"&&<span style={{fontFamily:MONO,fontSize:9,color:T.accent}}>TP aquí</span>}
                <Badge color={T.up}>H {signal?.levels?Math.round(signal.levels.tpPrice+0.5):"--"}</Badge>
              </div>
            </div>

            {/* SL / TP */}
            <div style={{marginTop:7,paddingTop:6,borderTop:`1px solid ${T.border}`}}>
              {[
                {label:"SL",opts:SL_OPTIONS,val:slPct,set:setSlPct,activeColor:T.down,activeBg:"rgba(255,59,92,0.12)"},
                {label:"TP",opts:TP_OPTIONS,val:tpPct,set:setTpPct,activeColor:T.up,  activeBg:"rgba(0,200,150,0.12)"},
              ].map(({label,opts,val,set,activeColor,activeBg})=>(
                <div key={label} style={{display:"flex",alignItems:"center",gap:4,marginBottom:4}}>
                  <span style={{fontFamily:SANS,fontSize:10,color:T.muted,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.06em",minWidth:20}}>{label}</span>
                  <div style={{display:"flex",flexWrap:"wrap",gap:2}}>
                    {opts.map(v=>(
                      <button key={v} onClick={()=>set(v)} style={{
                        padding:"2px 5px",borderRadius:4,cursor:"pointer",fontFamily:MONO,fontSize:10,fontWeight:700,
                        border:`1px solid ${val===v?activeColor:T.border}`,
                        background:val===v?activeBg:T.s2,
                        color:val===v?activeColor:T.muted,
                      }}>{v}%</button>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* Score */}
            <div style={{marginTop:6,padding:"5px 8px",borderRadius:5,textAlign:"center",fontFamily:MONO,fontSize:12,fontWeight:700,
              background:signalScore>=6?T.upBg:T.s2,color:signalScore>=6?T.up:T.muted,
              border:`1px solid ${signalScore>=6?T.upBorder:T.border}`}}>
              Score {signalScore}/10
            </div>
          </Card>

        </div>

        {/* ── MAIN FEED ── */}
        <div className="tp3-main"
          style={{background:T.bg,overflowY:"auto",padding:"8px 10px",display:"flex",flexDirection:"column"}}>
          <SessionBanner session={session}/>
          <VerdictCard signal={signal} price={price} score={signalScore}/>
          <MT5Block signal={signal} score={signalScore} price={price}/>
          <Card>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:7}}>
              <SecTitle>Historial XAU/USD</SecTitle>
              <span style={{fontFamily:MONO,fontSize:9,color:T.muted}}>{ops.length} ops</span>
            </div>
            <HistoryList ops={ops} userId={userId} onUpdate={handleUpdate}/>
          </Card>
        </div>

        {/* ── RIGHT PANEL ── */}
        <div className="tp3-right"
          style={{background:T.bg,borderLeft:`1px solid ${T.border}`,
            overflow:"hidden",padding:"8px 8px",display:"flex",flexDirection:"column",height:"100%"}}>
          <Checklist
            session={session} signal={signal} price={price}
            signalScore={signalScore} hasNews={hasNews}
            onToggleNews={()=>setHasNews(n=>!n)}
          />
          <div style={{flex:1,display:"flex",flexDirection:"column",minHeight:0}}>
            <OperationForm
              livePrice={price} userId={userId} onSaved={handleSaved}
              fillHeight slPct={slPct} tpPct={tpPct}
              structureSL={signal?.levels?.slPrice}
              structureTP={signal?.levels?.tpPrice}
            />
          </div>
        </div>

      </div>
    </>
  );
}
