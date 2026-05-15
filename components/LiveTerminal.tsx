"use client";
// components/LiveTerminal.tsx — v4.1
// · Fair Value Gaps (FVG) — desequilibrios institucionales en sidebar
// · PDH/PDL — Previous Day High/Low como niveles de liquidez real
// · D1 Hard Filter — bloquea señales contra tendencia diaria
// · FVG en score +1
// · tpSource visible en bloque MT5 (session/structure/fallback)
//
// Cambios v4.1:
// · Bug 6.1 — slPct/tpPct ahora en deps del useEffect MTF: cambiar SL/TP
//   en sidebar recalcula señales inmediatamente, no en el próximo tick 15min.
// · Bug 5.2 — capital_momento se guarda en cada op nueva (POST). El % cuenta
//   en HistoryList usa op.capital_momento si existe; cae a localStorage para
//   ops viejas (compatibilidad).

import { useState, useEffect, useCallback, useRef } from "react";
import { calcLotSize } from "@/lib/engine/simulator";
import { precompute, getPDHL } from "@/lib/engine/indicators";
import { getLiveVerdict, mtfSignalAt, htfSignalAt } from "@/lib/engine/signals";
import type { Candle, PriceStructure, StructureLevels, SessionLevels } from "@/lib/engine/types";
import { supabaseBrowser } from "@/lib/db/supabase-client";

// ── Auth helper ───────────────────────────────────────────────────────────────
// Obtiene los headers de auth para llamar a /api/operations.
// El access_token viene de la sesión activa de Supabase en el navegador.
// Si no hay sesión, retorna {} y la API responde 401.
async function authHeaders(): Promise<Record<string,string>> {
  const { data } = await supabaseBrowser.auth.getSession();
  const token = data.session?.access_token;
  return token ? { "Authorization": `Bearer ${token}` } : {};
}

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
  lotaje:number|null;
  resultado:OpsResult;pnl:number|null; // pnl en dólares reales
  capital_momento:number|null;          // capital cuenta al abrir la op (null = ops viejas)
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
  pdh:number|null;
  pdl:number|null;
}

const BINANCE_FUTURES = "https://fapi.binance.com/fapi/v1/klines";
const FETCH_TIMEOUT_MS = 10_000;

// Fix #3 (v4): aborta la request si Binance tarda más de 10s.
// Antes una request colgada congelaba el motor de señales hasta el próximo ciclo de 15min.
async function fetchWithTimeout(url:string,timeoutMs=FETCH_TIMEOUT_MS):Promise<Response>{
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{return await fetch(url,{signal:controller.signal});}
  finally{clearTimeout(timer);}
}

async function fetchLiveCandles(tf:string,limit=250):Promise<Candle[]>{
  const r=await fetchWithTimeout(`${BINANCE_FUTURES}?symbol=XAUUSDT&interval=${tf}&limit=${limit}`);
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
  // Fix #7 (v4): EMA200 ahora exige buffer 0.2% (igual que checklist).
  // Antes el score sumaba +2 con precio del lado correcto sin importar la distancia,
  // mientras que el checklist solo marcaba ✓ con separación clara. Inconsistencia
  // que mostraba "Score 8/10 · ENTRAR LONG" + "Checklist EMA200 ✗" simultáneamente.
  if(ema200!=null&&price>0&&Math.abs(price-ema200)/ema200>0.002){
    if((htf==="UP"&&price>ema200)||(htf==="DOWN"&&price<ema200))s+=2;
  }
  if(rsi!=null){if(rsi>=30&&rsi<=70)s+=1;}
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

// ── CapitalRiskControl ────────────────────────────────────────────────────────
// Control read-only con click-to-edit para Capital y Riesgo %.
// Reemplaza los inputs que estaban en el formulario Nueva Op derecho.
// Una sola fuente de verdad: localStorage tp3_capital y tp3_risk.
// Al editar, se guarda inmediatamente al perder foco o presionar Enter.
// El MT5Block recalcula lotaje en tiempo real porque lee del mismo localStorage.
function CapitalRiskControl({onChange}:{onChange:()=>void}){
  const[capital,setCapital]=useState(()=>{
    try{return localStorage.getItem("tp3_capital")||"10000";}catch{return"10000";}
  });
  const[riskPct,setRiskPct]=useState(()=>{
    try{return localStorage.getItem("tp3_risk")||"1";}catch{return"1";}
  });
  const[editing,setEditing]=useState<"capital"|"risk"|null>(null);

  const commitCapital=()=>{
    const num=parseFloat(capital);
    if(!isNaN(num)&&num>0){
      try{localStorage.setItem("tp3_capital",capital);}catch{}
      onChange();
    }else{
      // Revertir si el valor es inválido
      try{setCapital(localStorage.getItem("tp3_capital")||"10000");}catch{setCapital("10000");}
    }
    setEditing(null);
  };
  const commitRisk=()=>{
    const num=parseFloat(riskPct);
    if(!isNaN(num)&&num>0&&num<=100){
      try{localStorage.setItem("tp3_risk",riskPct);}catch{}
      onChange();
    }else{
      try{setRiskPct(localStorage.getItem("tp3_risk")||"1");}catch{setRiskPct("1");}
    }
    setEditing(null);
  };

  const capNum=parseFloat(capital)||0;
  const inpStyle:React.CSSProperties={
    background:T.s2,border:`1px solid ${T.accent}`,borderRadius:4,
    padding:"2px 6px",color:T.text,fontFamily:MONO,fontSize:11,fontWeight:700,
    outline:"none",width:80,textAlign:"right"
  };
  const valStyle:React.CSSProperties={
    fontFamily:MONO,fontSize:11,fontWeight:700,color:T.gold,
    cursor:"pointer",padding:"2px 6px",borderRadius:4,
    border:`1px solid transparent`,transition:"all 0.15s"
  };
  const valHover:React.CSSProperties={
    ...valStyle,
    border:`1px dashed ${T.border2}`,
    background:T.s2
  };
  const lblStyle:React.CSSProperties={
    fontFamily:SANS,fontSize:9,color:T.muted,fontWeight:600,
    letterSpacing:"0.05em",textTransform:"uppercase"
  };

  return(
    <Card style={{marginBottom:4,padding:"6px 12px"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10}}>
        {/* CAPITAL */}
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <span style={{fontSize:11}}>💰</span>
          <span style={lblStyle}>Capital</span>
          {editing==="capital"?(
            <input
              type="number" value={capital} autoFocus
              onChange={e=>setCapital(e.target.value)}
              onBlur={commitCapital}
              onKeyDown={e=>{if(e.key==="Enter")commitCapital();if(e.key==="Escape"){setCapital(localStorage.getItem("tp3_capital")||"10000");setEditing(null);}}}
              style={inpStyle}
            />
          ):(
            <span
              style={valStyle}
              onClick={()=>setEditing("capital")}
              onMouseEnter={e=>Object.assign(e.currentTarget.style,valHover)}
              onMouseLeave={e=>Object.assign(e.currentTarget.style,valStyle)}
              title="Click para editar"
            >${capNum.toLocaleString()}</span>
          )}
        </div>

        {/* Separador */}
        <div style={{width:1,height:18,background:T.border}}/>

        {/* RIESGO */}
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <span style={{fontSize:11}}>⚙</span>
          <span style={lblStyle}>Riesgo</span>
          {editing==="risk"?(
            <input
              type="number" step="0.1" value={riskPct} autoFocus
              onChange={e=>setRiskPct(e.target.value)}
              onBlur={commitRisk}
              onKeyDown={e=>{if(e.key==="Enter")commitRisk();if(e.key==="Escape"){setRiskPct(localStorage.getItem("tp3_risk")||"1");setEditing(null);}}}
              style={{...inpStyle,width:50}}
            />
          ):(
            <span
              style={valStyle}
              onClick={()=>setEditing("risk")}
              onMouseEnter={e=>Object.assign(e.currentTarget.style,valHover)}
              onMouseLeave={e=>Object.assign(e.currentTarget.style,valStyle)}
              title="Click para editar"
            >{riskPct}%</span>
          )}
        </div>

        {/* Hint sutil derecha */}
        <div style={{flex:1,textAlign:"right"}}>
          <span style={{fontFamily:SANS,fontSize:8,color:T.dim,fontStyle:"italic"}}>
            click para editar
          </span>
        </div>
      </div>
    </Card>
  );
}

// ── MT5 Block ─────────────────────────────────────────────────────────────────
// Solo aparece cuando score >= 6 y hay señal de entrada.
// Muestra los 3 precios exactos listos para copiar en MT5.
interface MT5BlockProps{
  signal:LiveSignal|null;
  score:number;
  price:number;
  slPct:number;
  tpPct:number;
  refreshKey:number;  // se incrementa cuando cambia Capital o Riesgo → fuerza re-render
}
function MT5Block({signal,score,price,slPct,tpPct,refreshKey}:MT5BlockProps){
  void refreshKey;  // solo lo usamos para invalidar el render; lectura ya se hace por localStorage
  if(!signal||score<6||signal.verdict==="ESPERAR")return null;
  const levels=signal.levels;
  const isLong=signal.verdict==="ENTRAR LONG";
  const color=isLong?T.up:T.down;
  const atrVal=signal.atr;

  // Si no hay niveles de estructura, usar % seleccionados por el usuario
  const entry = price>0?price.toFixed(2):"--";
  const sl    = levels?levels.slPrice.toFixed(2):price>0?(isLong?price*(1-slPct/100):price*(1+slPct/100)).toFixed(2):"--";
  const tp    = levels?levels.tpPrice.toFixed(2):price>0?(isLong?price*(1+tpPct/100):price*(1-tpPct/100)).toFixed(2):"--";
  const slPctStr = levels?`${levels.slPct.toFixed(2)}%`:`${slPct.toFixed(2)}%`;
  const tpPctStr = levels?`${levels.tpPct.toFixed(2)}%`:`${tpPct.toFixed(2)}%`;

  // Fix #8 (v4): leer tp3_risk del localStorage en vez de hardcodear 1%.
  // Antes el MT5Block siempre calculaba lotaje con 1% aunque el usuario
  // hubiera configurado otro % en el form (ej. 0.5%) — mostraba el doble
  // de lotes y al copiar a MT5 se ejecutaba al doble de riesgo real.
  const capital = (typeof window!=="undefined"&&parseFloat(localStorage.getItem("tp3_capital")||""))||10000;
  const riskPct = (typeof window!=="undefined"&&parseFloat(localStorage.getItem("tp3_risk")||""))||1;
  const slPoints = Math.abs(parseFloat(entry)-parseFloat(sl));
  const lotaje = slPoints>0?calcLotSize(capital,riskPct,slPoints):0;

  // R:R calculado — bloquear si < 1.5
  const rr = levels&&levels.slPct>0?(levels.tpPct/levels.slPct):0;
  if(rr>0&&rr<1.5){
    return(
      <Card style={{marginBottom:4,padding:"8px 10px",border:`1px solid ${T.down}40`,background:`${T.down}08`}}>
        <div style={{fontFamily:SANS,fontSize:9,fontWeight:700,color:T.down,marginBottom:4}}>⚠ ORDEN MT5 — R:R INVÁLIDO</div>
        <div style={{fontFamily:MONO,fontSize:9,color:T.muted}}>
          R:R calculado: <span style={{color:T.down,fontWeight:700}}>{rr.toFixed(2)}:1</span> · mínimo 1.5:1
        </div>
        <div style={{fontFamily:SANS,fontSize:8,color:T.muted,marginTop:4}}>
          El setup no produce un ratio aceptable. Esperar mejor entrada.
        </div>
      </Card>
    );
  }

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

      {/* Los 4 valores para copiar */}
      {[
        {lbl:"ENTRADA",val:entry,color:T.gold,hint:"market"},
        {lbl:"SL",     val:sl,   color:T.down,hint:slPctStr},
        {lbl:"TP",     val:tp,   color:T.up,  hint:levels?.tpSource==="session"?"PDH/PDL 🎯":levels?.tpSource==="structure"?"estructura":tpPctStr},
        {lbl:"LOTAJE", val:lotaje.toFixed(2),color:T.accent,hint:`$${capital.toLocaleString()} × ${riskPct}%`},
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
    ema200!=null&&price>0&&Math.abs(price-ema200)/ema200>0.002&&
      ((signal?.htf==="UP"&&price>ema200)||(signal?.htf==="DOWN"&&price<ema200)),
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
// Cambio v5 — Nueva Op simplificado a registro manual puro.
// Ya no extrae datos del central (sin botones estructura/usar live), ya no
// gestiona capital/riesgo (eso vive en el central). Solo registra lo que vos
// ejecutaste en MT5 para que el sistema lleve estadística. Cero contaminación
// de contextos: una pantalla = una decisión.
interface OpFormProps{userId:string;onSaved:(op:Operation)=>void;fillHeight?:boolean;}
function OperationForm({userId,onSaved,fillHeight}:OpFormProps){
  const[dir,setDir]=useState<Direction>("LONG");
  const[entry,setEntry]=useState("");
  const[sl,setSL]=useState("");
  const[tp,setTP]=useState("");
  const[lotaje,setLotaje]=useState("");
  const[saving,setSaving]=useState(false);
  const[error,setError]=useState<string|null>(null);

  const eNum=parseFloat(entry)||0;
  const slNum=parseFloat(sl)||0;
  const tpNum=parseFloat(tp)||0;
  const lotNum=parseFloat(lotaje)||0;

  // Validación coherencia SL/TP vs dirección (preview UX antes de mandar)
  const slTpCoherent=eNum>0&&slNum>0&&tpNum>0&&(
    (dir==="LONG"&&slNum<eNum&&tpNum>eNum)||
    (dir==="SHORT"&&slNum>eNum&&tpNum<eNum)
  );
  const canSave=eNum>0&&slNum>0&&tpNum>0&&lotNum>0&&slTpCoherent;

  const save=async()=>{
    if(!canSave)return;
    setSaving(true);setError(null);
    try{
      const now=new Date(Date.now()-5*3600000);
      const dd=now.getUTCDate().toString().padStart(2,"0");
      const mm=(now.getUTCMonth()+1).toString().padStart(2,"0");
      const hh=now.getUTCHours().toString().padStart(2,"0");
      const min=now.getUTCMinutes().toString().padStart(2,"0");
      const fecha=`${dd}/${mm} ${hh}:${min}`;
      // capital_momento se lee del localStorage que el MT5Block central setea
      const capitalSnap=(typeof window!=="undefined"&&parseFloat(localStorage.getItem("tp3_capital")||""))||null;
      const res=await fetch("/api/operations",{method:"POST",headers:{"Content-Type":"application/json",...(await authHeaders())},
        body:JSON.stringify({
          fecha,direccion:dir,precio_entrada:eNum,sl:slNum,tp:tpNum,
          lotaje:lotNum,
          capital_momento:capitalSnap,
        })});
      if(!res.ok){
        const errBody=await res.json().catch(()=>null);
        throw new Error(errBody?.error||"Error al guardar");
      }
      const op=await res.json() as Operation;
      onSaved(op);
      setEntry("");setSL("");setTP("");setLotaje("");
    }catch(e){
      setError(e instanceof Error?e.message:"Error desconocido");
      console.error(e);
    }finally{setSaving(false);}
  };

  const inp:React.CSSProperties={width:"100%",background:T.s2,border:`1px solid ${T.border2}`,
    borderRadius:5,padding:"5px 8px",color:T.text,fontFamily:SANS,fontSize:12,outline:"none",boxSizing:"border-box"};
  const lbl:React.CSSProperties={display:"block",fontSize:8,fontWeight:600,letterSpacing:"0.06em",
    textTransform:"uppercase",color:T.muted,marginBottom:3};
  return(
    <Card style={{padding:"7px 10px",...(fillHeight?{flex:1,display:"flex",flexDirection:"column"}:{})}}>
      <div style={{marginBottom:6}}>
        <SecTitle>Nueva Op XAU/USD</SecTitle>
        <div style={{fontSize:9,color:T.dim,fontFamily:SANS,marginTop:2}}>
          Registro manual de operación ejecutada en MT5
        </div>
      </div>
      <div style={{marginBottom:5}}>
        <label style={lbl}>Dirección</label>
        <select value={dir} onChange={e=>setDir(e.target.value as Direction)} style={{...inp,cursor:"pointer"}}>
          <option value="LONG">▲ LONG</option><option value="SHORT">▼ SHORT</option>
        </select>
      </div>
      <div style={{marginBottom:5}}>
        <label style={lbl}>Precio entrada</label>
        <input type="number" value={entry} placeholder="Ej: 4658.50" onChange={e=>setEntry(e.target.value)} style={inp}/>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:5,marginBottom:5}}>
        <div>
          <label style={{...lbl,color:T.down}}>SL</label>
          <input type="number" value={sl} placeholder="Stop Loss" onChange={e=>setSL(e.target.value)} style={inp}/>
        </div>
        <div>
          <label style={{...lbl,color:T.up}}>TP</label>
          <input type="number" value={tp} placeholder="Take Profit" onChange={e=>setTP(e.target.value)} style={inp}/>
        </div>
      </div>
      <div style={{marginBottom:6}}>
        <label style={lbl}>Lotaje</label>
        <input type="number" step="0.01" value={lotaje} placeholder="Ej: 0.04" onChange={e=>setLotaje(e.target.value)} style={inp}/>
      </div>
      {/* Validación inline antes de habilitar el botón */}
      {eNum>0&&slNum>0&&tpNum>0&&!slTpCoherent&&(
        <div style={{fontSize:9,color:T.down,fontFamily:SANS,marginBottom:5,padding:"4px 6px",
          background:T.dnBg,borderRadius:4,border:`1px solid ${T.dnBorder}`}}>
          ⚠ {dir==="LONG"?"En LONG: SL debe ser MENOR y TP MAYOR al entry":"En SHORT: SL debe ser MAYOR y TP MENOR al entry"}
        </div>
      )}
      {error&&(
        <div style={{fontSize:9,color:T.down,fontFamily:SANS,marginBottom:5,padding:"4px 6px",
          background:T.dnBg,borderRadius:4,border:`1px solid ${T.dnBorder}`}}>
          {error}
        </div>
      )}
      <button onClick={save} disabled={saving||!canSave} style={{width:"100%",padding:"8px",
        background:canSave?"linear-gradient(135deg,#C9A227,#E8B84B)":T.s3,
        color:canSave?"#1D1D1F":T.muted,
        fontFamily:SANS,fontSize:12,fontWeight:700,border:"none",borderRadius:6,
        cursor:saving||!canSave?"not-allowed":"pointer",opacity:saving?0.6:1,
        ...(fillHeight?{marginTop:"auto"}:{})}}>
        {saving?"Guardando...":"+ Registrar operación"}
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

// ── CopyTerminalBtn ───────────────────────────────────────────────────────────
interface CopyTerminalProps{
  signal:LiveSignal|null;price:number;score:number;
  session:Session;d1Bias:MTFSig;htfTf:string;ltfTf:string;
  slPct:number;tpPct:number;hasNews:boolean;
  wr:number;totalOps:number;pnlTotal:number;connected:boolean;
  sigError:string|null;
}
function CopyTerminalBtn(p:CopyTerminalProps){
  const[copied,setCopied]=useState(false);
  const copy=()=>{
    const col=new Date(Date.now()-5*3600000);
    const time=`${col.getUTCHours().toString().padStart(2,"0")}:${col.getUTCMinutes().toString().padStart(2,"0")} COL`;
    const date=new Date().toLocaleDateString("es-CO",{day:"2-digit",month:"2-digit",year:"2-digit"});
    const candleMins=59-new Date().getUTCMinutes();
    const next=(p.session==="CLOSED"||p.session==="WEEKEND")?getNextSession():null;
    const s=p.signal;
    const verdict=p.score>=6?s?.verdict:"ESPERAR";
    const sesLbl=p.session==="LDN"?"LDN ACTIVA":p.session==="NY"?"NY ACTIVA (+OVERLAP)":p.session==="WEEKEND"?"FIN DE SEMANA":"CLOSED";
    const d1lbl=p.d1Bias==="UP"?"▲ ALCISTA":p.d1Bias==="DOWN"?"▼ BAJISTA":"- NEUTRAL";
    const fvg=s?.fvgBull?`▲ ${s.fvgBull.bot.toFixed(0)}-${s.fvgBull.top.toFixed(0)}`:s?.fvgBear?`▼ ${s.fvgBear.bot.toFixed(0)}-${s.fvgBear.top.toFixed(0)}`:"NONE";
    const struct=s?.structure==="BULLISH"?"HH/HL ▲":s?.structure==="BEARISH"?"LH/LL ▼":"NEUTRAL";
    const mtfTf=p.htfTf==="4h"?"1H":"15M";
    const txt=[
      `━━━ TP3 Terminal · XAU/USD ━━━`,
      `📅 ${date} ${time}`,
      `💰 Precio: $${p.price>0?p.price.toFixed(2):"--"} · ${p.connected?"TwelveData LIVE":"desconectado"}`,
      `🕐 Sesión: ${sesLbl}${next?` · ${next.label} en ${fmtCountdown(next.mins)}`:""}`,
      `⏱ Vela cierra en: ${candleMins}m`,
      `📊 Config: HTF ${p.htfTf.toUpperCase()} · MTF ${mtfTf} · LTF ${p.ltfTf.toUpperCase()} · SL ${p.slPct}% · TP ${p.tpPct}%`,
      p.sigError?`⚠ Error señales: ${p.sigError}`:"",
      ``,
      `🎯 SEÑAL: ${verdict??"-"} · Score ${p.score}/10 · ${s?.strength??"-"}${s?.d1Blocked?" · 🚫 D1 BLOQUEADO":""}`,
      ``,
      `📈 MTF MATRIX:`,
      `  D1:  ${d1lbl}`,
      `  ${p.htfTf.toUpperCase()}: ${s?.htf??"WAIT"} · ${mtfTf}: ${s?.mtf??"WAIT"} · ${p.ltfTf.toUpperCase()}: ${s?.ltf??"WAIT"}`,
      `  Estructura: ${struct} · FVG: ${fvg}`,
      `  RSI: ${s?.rsi!=null?s.rsi.toFixed(0):"--"} · EMA200: ${s?.ema200!=null?s.ema200.toFixed(0):"--"} · ATR: ${s?.atr!=null?s.atr.toFixed(1):"--"}/vela`,
      ``,
      ...(s?.levels&&p.score>=6?[
        `📋 ORDEN MT5:`,
        `  ENTRADA: $${s.levels.entryPrice.toFixed(2)}`,
        `  SL:      $${s.levels.slPrice.toFixed(2)} (${s.levels.slPct.toFixed(2)}%)`,
        `  TP:      $${s.levels.tpPrice.toFixed(2)} (${s.levels.tpPct.toFixed(2)}%) [${s.levels.tpSource}]`,
        ``,
      ]:[]),
      `✅ CHECKLIST:`,
      `  Sesión activa:     ${p.session==="LDN"||p.session==="NY"?"✓":"✗"}`,
      `  EMA200 sesgo:      ${s?.ema200!=null&&p.price>0&&Math.abs(p.price-s.ema200)/s.ema200>0.002?"✓":"✗"}`,
      `  HTF+MTF alineados: ${s?.htf!=="WAIT"&&s?.htf===s?.mtf?"✓":"✗"}`,
      `  RSI ok:            ${s?.rsi!=null&&s.rsi>=30&&s.rsi<=70?"✓":"✗"} (${s?.rsi!=null?s.rsi.toFixed(0):"--"})`,
      `  Sin noticia:       ${!p.hasNews?"✓":"✗ HAY NOTICIA"}`,
      `  Score ≥ 6:         ${p.score>=6?"✓":"✗"} (${p.score}/10)`,
      ``,
      `📊 CUENTA: ${p.totalOps} ops · WR ${p.wr}% · P&L ${p.pnlTotal>=0?"+$":"-$"}${Math.abs(p.pnlTotal).toFixed(0)}`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ].filter(l=>l!=="").join("\n");
    navigator.clipboard.writeText(txt).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),2500);});
  };
  return(
    <button onClick={copy} style={{
      fontFamily:MONO,fontSize:10,fontWeight:700,padding:"4px 14px",borderRadius:6,cursor:"pointer",
      border:`1px solid ${copied?T.up:T.border}`,background:copied?T.upBg:T.s2,
      color:copied?T.up:T.muted,transition:"all 0.2s",
    }}>{copied?"✓ Copiado":"📋 Copiar estado"}</button>
  );
}

// ── VerdictCard ───────────────────────────────────────────────────────────────
function VerdictCard({signal,price,score,htfTf,ltfTf}:{signal:LiveSignal|null;price:number;score:number;htfTf:string;ltfTf:string}){
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
          {label:`HTF ${htfTf.toUpperCase()}`,sig:signal.htf},
          {label:`MTF ${htfTf==="4h"?"1H":"15M"}`,sig:signal.mtf},
          {label:"15M",sig:signal.m15},
          {label:`LTF ${ltfTf.toUpperCase()}`,sig:signal.ltf},
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

// ── EditModal ─────────────────────────────────────────────────────────────────
interface EditModalProps{
  op:Operation;
  onClose:()=>void;
  onSave:(updated:{id:string;direccion:Direction;precio_entrada:number;sl:number;tp:number;lotaje:number|null;resultado:OpsResult;pnl:number|null})=>void;
}
function EditModal({op,onClose,onSave}:EditModalProps){
  const[dir,setDir]=useState<Direction>(op.direccion);
  const[entry,setEntry]=useState(op.precio_entrada.toFixed(2));
  const[sl,setSL]=useState(op.sl.toFixed(2));
  const[tp,setTP]=useState(op.tp.toFixed(2));
  const[lotaje,setLotaje]=useState(op.lotaje!=null?op.lotaje.toFixed(2):"");
  const[resultado,setResultado]=useState<OpsResult>(op.resultado);
  const[cierre,setCierre]=useState("");
  const[saving,setSaving]=useState(false);

  const inp:React.CSSProperties={width:"100%",background:T.s2,border:`1px solid ${T.border2}`,
    borderRadius:5,padding:"5px 8px",color:T.text,fontFamily:SANS,fontSize:12,outline:"none",boxSizing:"border-box"};
  const lbl:React.CSSProperties={display:"block",fontSize:8,fontWeight:600,letterSpacing:"0.06em",
    textTransform:"uppercase",color:T.muted,marginBottom:3};

  const eNum=parseFloat(entry)||0;
  const slNum=parseFloat(sl)||0;
  const tpNum=parseFloat(tp)||0;
  const lotNum=parseFloat(lotaje)||0;
  const cNum=parseFloat(cierre)||0;

  // Preview del P&L en dólares
  const calcPnlDollar=():number|null=>{
    if(!eNum||!lotNum)return null;
    if(resultado==="TP"){
      const pts=dir==="LONG"?tpNum-eNum:eNum-tpNum;
      return pts*lotNum*100;
    }else if(resultado==="SL"){
      const pts=dir==="LONG"?eNum-slNum:slNum-eNum;
      return -pts*lotNum*100;
    }else if(resultado==="MANUAL"&&cNum>0){
      const pts=dir==="LONG"?cNum-eNum:eNum-cNum;
      return pts*lotNum*100;
    }
    return null;
  };
  const pnlPreview=calcPnlDollar();

  // R múltiplo preview
  const slPts=Math.abs(eNum-slNum);
  const dollarRisk=slPts*lotNum*100;
  const rPreview=dollarRisk>0&&pnlPreview!=null?pnlPreview/dollarRisk:null;

  const handleSave=async()=>{
    if(!eNum||!slNum||!tpNum)return;
    const pnl=calcPnlDollar();
    setSaving(true);
    try{onSave({id:op.id,direccion:dir,precio_entrada:eNum,sl:slNum,tp:tpNum,
      lotaje:lotNum>0?lotNum:null,resultado,pnl});}
    finally{setSaving(false);}
  };

  return(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.78)",zIndex:1000,
      display:"flex",alignItems:"center",justifyContent:"center"}}
      onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div style={{background:T.s1,border:`1px solid ${T.border}`,borderRadius:10,
        padding:"18px 20px",width:300,boxShadow:"0 20px 60px rgba(0,0,0,0.6)"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
          <span style={{fontFamily:SANS,fontSize:12,fontWeight:700,color:T.text}}>Editar operación</span>
          <button onClick={onClose} style={{background:"none",border:"none",color:T.muted,
            cursor:"pointer",fontSize:16,padding:0,lineHeight:1}}>✕</button>
        </div>

        <div style={{marginBottom:8}}>
          <label style={lbl}>Dirección</label>
          <select value={dir} onChange={e=>setDir(e.target.value as Direction)}
            style={{...inp,cursor:"pointer"}}>
            <option value="LONG">▲ LONG</option>
            <option value="SHORT">▼ SHORT</option>
          </select>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:8}}>
          <div><label style={lbl}>Precio entrada</label>
            <input type="number" value={entry} onChange={e=>setEntry(e.target.value)} style={inp}/></div>
          <div><label style={{...lbl,color:T.gold}}>Lotaje</label>
            <input type="number" value={lotaje} placeholder="0.04"
              onChange={e=>setLotaje(e.target.value)} style={inp}/></div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:8}}>
          <div><label style={{...lbl,color:T.down}}>SL</label>
            <input type="number" value={sl} onChange={e=>setSL(e.target.value)} style={inp}/></div>
          <div><label style={{...lbl,color:T.up}}>TP</label>
            <input type="number" value={tp} onChange={e=>setTP(e.target.value)} style={inp}/></div>
        </div>
        <div style={{marginBottom:8}}>
          <label style={lbl}>Resultado</label>
          <select value={resultado??""} onChange={e=>setResultado((e.target.value||null) as OpsResult)}
            style={{...inp,cursor:"pointer"}}>
            <option value="">Abierta</option>
            <option value="TP">TP ✅</option>
            <option value="SL">SL ❌</option>
            <option value="MANUAL">MANUAL</option>
          </select>
        </div>
        {resultado==="MANUAL"&&(
          <div style={{marginBottom:8}}>
            <label style={lbl}>Precio cierre real</label>
            <input type="number" value={cierre} placeholder="ej. 4701.72"
              onChange={e=>setCierre(e.target.value)} style={inp}/>
          </div>
        )}

        {/* Preview P&L */}
        {pnlPreview!=null&&(
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:4,marginBottom:10,
            padding:"6px 8px",borderRadius:5,background:T.s2,border:`1px solid ${T.border}`}}>
            <div>
              <div style={{fontSize:7,color:T.muted,letterSpacing:"0.05em",textTransform:"uppercase",marginBottom:2}}>P&L real</div>
              <div style={{fontFamily:MONO,fontSize:13,fontWeight:700,color:pnlPreview>=0?T.up:T.down}}>
                {pnlPreview>=0?"+":""}{pnlPreview>=0?"$"+pnlPreview.toFixed(0):"-$"+Math.abs(pnlPreview).toFixed(0)}
              </div>
            </div>
            <div>
              <div style={{fontSize:7,color:T.muted,letterSpacing:"0.05em",textTransform:"uppercase",marginBottom:2}}>R múltiplo</div>
              <div style={{fontFamily:MONO,fontSize:13,fontWeight:700,color:rPreview!=null&&rPreview>=0?T.up:T.down}}>
                {rPreview!=null?`${rPreview>=0?"+":""}${rPreview.toFixed(1)}R`:"--"}
              </div>
            </div>
          </div>
        )}

        <div style={{display:"flex",gap:6,marginTop:6}}>
          <button onClick={onClose} style={{flex:1,padding:"7px",background:T.s3,
            border:`1px solid ${T.border}`,borderRadius:6,color:T.muted,
            fontFamily:SANS,fontSize:11,cursor:"pointer"}}>Cancelar</button>
          <button onClick={handleSave} disabled={saving} style={{flex:2,padding:"7px",
            background:"linear-gradient(135deg,#C9A227,#E8B84B)",border:"none",borderRadius:6,
            color:"#1D1D1F",fontFamily:SANS,fontSize:11,fontWeight:700,
            cursor:saving?"not-allowed":"pointer",opacity:saving?0.6:1}}>
            {saving?"Guardando...":"Guardar cambios"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── HistoryList ───────────────────────────────────────────────────────────────
interface HistoryListProps{
  ops:Operation[];userId:string;
  onUpdate:(id:string,resultado:"TP"|"SL"|"MANUAL")=>void;
  onEdit:(op:Operation)=>void;
  onDelete:(id:string)=>void;
  limit?:number;  // Si está presente, solo muestra las últimas N ops + contador del resto
}
function HistoryList({ops,onUpdate,onEdit,onDelete,limit}:HistoryListProps){
  if(!ops.length)return<div style={{fontFamily:SANS,fontSize:10,color:T.muted,padding:"10px 0",textAlign:"center"}}>Sin operaciones registradas.</div>;
  // Recorte para vista compacta del Terminal — Cuenta usa el componente sin limit
  const totalOps=ops.length;
  const opsToRender=limit!=null?ops.slice(0,limit):ops;
  const hiddenCount=totalOps-opsToRender.length;
  return(
    <div style={{display:"flex",flexDirection:"column",gap:4}}>
      {opsToRender.map(op=>{
        const isPos=op.pnl!=null&&op.pnl>=0;
        const pnlColor=op.pnl!=null?(isPos?T.up:T.down):T.muted;
        // R múltiplo desde datos de la op
        const slPts=Math.abs(op.precio_entrada-op.sl);
        const dollarRisk=op.lotaje!=null?slPts*op.lotaje*100:null;
        const rMultiple=dollarRisk&&dollarRisk>0&&op.pnl!=null?op.pnl/dollarRisk:null;
        // % precio
        const movPts=op.resultado==="TP"?Math.abs(op.tp-op.precio_entrada)
          :op.resultado==="SL"?Math.abs(op.precio_entrada-op.sl)
          :op.pnl!=null&&op.lotaje&&op.lotaje>0?Math.abs(op.pnl/(op.lotaje*100)):0;
        const pnlPct=op.precio_entrada>0?(movPts/op.precio_entrada)*100*(op.pnl!=null&&op.pnl<0?-1:1):0;

        return(
          <div key={op.id}>
            {/* Fila principal */}
            <div style={{display:"flex",alignItems:"center",gap:6,padding:"6px 10px",
              borderRadius:op.resultado!=null?"6px 6px 0 0":"6px",
              background:T.s2,fontSize:10,
              borderLeft:`2px solid ${op.resultado==="TP"?T.up:op.resultado==="SL"?T.down:T.dim}`}}>
              <span style={{color:op.direccion==="LONG"?T.up:T.down,fontFamily:MONO,minWidth:12}}>
                {op.direccion==="LONG"?"▲":"▼"}
              </span>
              <span style={{color:T.muted,fontFamily:MONO,minWidth:38,fontSize:9}}>{op.fecha}</span>
              <span style={{color:T.text,fontFamily:MONO}}>${op.precio_entrada.toFixed(0)}</span>
              {op.lotaje!=null&&(
                <span style={{color:T.gold,fontFamily:MONO,fontSize:9}}>{op.lotaje.toFixed(2)}L</span>
              )}
              <div style={{flex:1}}/>
              {op.resultado==null?(
                <div style={{display:"flex",gap:3}}>
                  {(["TP","SL","MANUAL"]as const).map(r=>(
                    <button key={r} onClick={()=>onUpdate(op.id,r)} style={{fontFamily:SANS,fontSize:8,fontWeight:700,
                      padding:"2px 5px",borderRadius:4,cursor:"pointer",border:"none",
                      background:r==="TP"?T.up:r==="SL"?T.down:T.s4,
                      color:r==="TP"||r==="SL"?"#000":T.muted}}>{r}</button>
                  ))}
                </div>
              ):(
                <span style={{fontFamily:MONO,fontWeight:700,fontSize:10,color:pnlColor}}>
                  {op.resultado}
                </span>
              )}
              <button onClick={()=>onEdit(op)} title="Editar" style={{
                background:"none",border:`1px solid ${T.border}`,borderRadius:4,
                padding:"2px 4px",cursor:"pointer",fontSize:9,color:T.muted,lineHeight:1,flexShrink:0}}>✏️</button>
              <button onClick={()=>onDelete(op.id)} title="Eliminar" style={{
                background:"none",border:`1px solid ${T.border}`,borderRadius:4,
                padding:"2px 4px",cursor:"pointer",fontSize:9,color:T.down,lineHeight:1,flexShrink:0}}>🗑️</button>
            </div>
            {/* Fila P&L — solo si hay resultado */}
            {op.resultado!=null&&(
              <div style={{display:"flex",alignItems:"center",gap:10,padding:"4px 10px",
                borderRadius:"0 0 6px 6px",background:isPos?T.upBg:T.dnBg,
                borderLeft:`2px solid ${op.resultado==="TP"?T.up:op.resultado==="SL"?T.down:T.dim}`}}>
                {/* P&L en $ */}
                <div>
                  <div style={{fontSize:7,color:T.muted,letterSpacing:"0.05em",textTransform:"uppercase"}}>P&L</div>
                  <div style={{fontFamily:MONO,fontSize:12,fontWeight:700,color:pnlColor}}>
                    {op.pnl!=null
                      ?(op.pnl>=0?"+$":"-$")+Math.abs(op.pnl).toFixed(0)
                      :"--"}
                  </div>
                </div>
                {/* % cuenta */}
                {op.pnl!=null&&(()=>{
                  // Bug 5.2 — prioridad: capital del momento de la op, luego localStorage, luego 10000
                  const capFallback=parseFloat((typeof window!=="undefined"&&localStorage.getItem("tp3_capital"))||"10000")||10000;
                  const cap=op.capital_momento!=null&&op.capital_momento>0?op.capital_momento:capFallback;
                  const pct=(op.pnl/cap)*100;
                  const isHistoric=op.capital_momento!=null&&op.capital_momento>0;
                  return(<div>
                    <div style={{fontSize:7,color:T.muted,letterSpacing:"0.05em",textTransform:"uppercase"}}>
                      % cuenta{!isHistoric&&<span style={{color:T.wait,marginLeft:3}}>~</span>}
                    </div>
                    <div style={{fontFamily:MONO,fontSize:12,fontWeight:700,color:pnlColor}}
                      title={isHistoric?`Capital al abrir: $${cap.toLocaleString()}`:"Capital del momento no registrado — usando capital actual"}>
                      {pct>=0?"+":""}{pct.toFixed(2)}%
                    </div>
                  </div>);
                })()}
                {/* Lotaje */}
                {op.lotaje!=null&&(
                  <div style={{marginLeft:"auto"}}>
                    <div style={{fontSize:7,color:T.muted,letterSpacing:"0.05em",textTransform:"uppercase"}}>Lotaje</div>
                    <div style={{fontFamily:MONO,fontSize:10,color:T.gold}}>{op.lotaje.toFixed(2)}</div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
      {hiddenCount>0&&(
        <div style={{fontFamily:SANS,fontSize:9,color:T.muted,textAlign:"center",
          padding:"6px 0 2px",fontStyle:"italic"}}>
          + {hiddenCount} operación{hiddenCount===1?"":"es"} más · ver todas en Cuenta
        </div>
      )}
    </div>
  );
}

// ── ROOT ──────────────────────────────────────────────────────────────────────
export default function LiveTerminal({userId,price,connected}:{userId:string;price:number;connected:boolean}){
  const[session,  setSession] = useState<Session>("CLOSED");
  const[signal,   setSignal]  = useState<LiveSignal|null>(null);
  const[ops,      setOps]     = useState<Operation[]>([]);
  const[editingOp,setEditingOp]= useState<Operation|null>(null);
  const[sigError, setSigError]= useState<string|null>(null);
  const[hasNews,  setHasNews] = useState(false);
  const[d1Bias,   setD1Bias]  = useState<MTFSig>("WAIT");

  const SL_OPTIONS = [0.5,0.75,1,1.5,2,2.5,3,3.5,4];
  const TP_OPTIONS = [0.5,0.75,1,1.5,2,2.5,3,3.5,4];
  const[htfTf,setHtfTf] = useState<"4h"|"1h">(()=>{ try{ const v=localStorage.getItem('tp3_htf'); return (v==="4h"||v==="1h")?v:"1h"; }catch{ return "1h"; } });
  const[ltfTf,setLtfTf] = useState<"15m"|"5m">(()=>{ try{ const v=localStorage.getItem('tp3_ltf'); return (v==="15m"||v==="5m")?v:"15m"; }catch{ return "15m"; } });
  const[slPct,setSlPct] = useState(()=>{ try{ const v=parseFloat(localStorage.getItem('tp3_slPct')||''); return isNaN(v)?0.5:v; }catch{ return 0.5; } });
  const[tpPct,setTpPct] = useState(()=>{ try{ const v=parseFloat(localStorage.getItem('tp3_tpPct')||''); return isNaN(v)?2.5:v; }catch{ return 2.5; } });

  // Cambio #4 (v5): refreshKey se incrementa cuando el usuario cambia Capital o
  // Riesgo en el CapitalRiskControl central. Esto fuerza re-render del MT5Block
  // para que recalcule el lotaje con los nuevos valores del localStorage.
  const[capRiskKey,setCapRiskKey]=useState(0);

  // Ref para price — se actualiza sin disparar re-renders
  const priceRef = useRef(price);

  const handleHtfChange=(tf:"4h"|"1h")=>{
    setHtfTf(tf);
    const ltf=tf==="1h"?"5m":"15m";
    setLtfTf(ltf);
    try{localStorage.setItem('tp3_htf',tf);localStorage.setItem('tp3_ltf',ltf);}catch{}
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

  // Sincronizar priceRef con cada tick sin disparar re-runs de MTF signals
  useEffect(()=>{
    priceRef.current = price;
  },[price]);

  // Señales MTF + D1 bias
  useEffect(()=>{
    async function load(){
      setSigError(null);
      try{
        const mtfTf=htfTf==="4h"?"1h":"15m";
        // Promise.allSettled — si falla 1 fetch, los demás siguen
        const results=await Promise.allSettled([
          fetchLiveCandles(htfTf,250),
          fetchLiveCandles(mtfTf,250),
          fetchLiveCandles("15m",150),
          fetchLiveCandles(ltfTf,120),
          fetchLiveCandles("1d",300),   // D1 bias — 300 para EMA200
        ]);
        const htfC  = results[0].status==="fulfilled"?results[0].value:[];
        const mtfC  = results[1].status==="fulfilled"?results[1].value:[];
        const m15C  = results[2].status==="fulfilled"?results[2].value:[];
        const ltfC  = results[3].status==="fulfilled"?results[3].value:[];
        const d1C   = results[4].status==="fulfilled"?results[4].value:[];
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

        const v=getLiveVerdict(htfInd,mtfInd,htfC.length-1,mtfC.length-1,priceRef.current,d1SigLocal,sessionLevels,slPct,tpPct);
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
          pdh:sessionLevels.pdh,
          pdl:sessionLevels.pdl,
        });
      }catch(err){
        setSigError(err instanceof Error?err.message:"Error desconocido");
      }
    }
    load();
    const iv=setInterval(load,15*60*1000);
    return()=>clearInterval(iv);
  },[htfTf,ltfTf,slPct,tpPct]);  // Bug 6.1 — slPct/tpPct en deps: cambiarlos recalcula al instante

  // Operaciones
  useEffect(()=>{
    if(!userId)return;
    authHeaders().then(h=>fetch("/api/operations",{headers:h}))
      .then(r=>r.json()).then(d=>{if(Array.isArray(d))setOps(d);}).catch(console.error);
  },[userId]);

  const handleSaved=useCallback((op:Operation)=>setOps(p=>[op,...p]),[]);
  const handleUpdate=useCallback(async(id:string,resultado:"TP"|"SL"|"MANUAL")=>{
    const op=ops.find(o=>o.id===id);if(!op)return;
    // P&L en dólares reales usando lotaje almacenado
    const lot=op.lotaje??0;
    let pnl:number|null=null;
    // Sin lotaje → P&L desconocido, dejar null (no $0 que ensucia stats)
    if(lot===0){
      pnl=null;
    }else if(resultado==="TP"){
      const pts=op.direccion==="LONG"?op.tp-op.precio_entrada:op.precio_entrada-op.tp;
      pnl=pts*lot*100;
    }else if(resultado==="SL"){
      const pts=op.direccion==="LONG"?op.precio_entrada-op.sl:op.sl-op.precio_entrada;
      pnl=-pts*lot*100;
    }else{
      pnl=null; // MANUAL requiere edición manual para P&L exacto
    }
    try{
      await fetch("/api/operations",{method:"PATCH",headers:{"Content-Type":"application/json",...(await authHeaders())},
        body:JSON.stringify({id,resultado,pnl})});
      setOps(p=>p.map(o=>o.id===id?{...o,resultado,pnl}:o));
    }catch(e){console.error(e);}
  },[ops,userId]);

  const handleDelete=useCallback(async(id:string)=>{
    if(!confirm("¿Eliminar esta operación? Esta acción no se puede deshacer."))return;
    try{
      await fetch(`/api/operations?id=${id}`,{method:"DELETE",headers:await authHeaders()});
      setOps(p=>p.filter(o=>o.id!==id));
    }catch(e){console.error(e);}
  },[userId]);

  const handleEditSave=useCallback(async(updated:{id:string;direccion:Direction;precio_entrada:number;sl:number;tp:number;lotaje:number|null;resultado:OpsResult;pnl:number|null})=>{
    try{
      await fetch("/api/operations",{method:"PATCH",headers:{"Content-Type":"application/json",...(await authHeaders())},
        body:JSON.stringify(updated)});
      setOps(p=>p.map(o=>o.id===updated.id?{...o,...updated}:o));
      setEditingOp(null);
    }catch(e){console.error(e);}
  },[userId]);

  const closed=ops.filter(o=>o.resultado!==null);
  const wins=closed.filter(o=>o.resultado==="TP").length;
  const wr=closed.length>0?Math.round((wins/closed.length)*100):0;
  const pnlTotal=closed.reduce((a,o)=>a+(o.pnl??0),0); // suma en dólares reales

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
        {editingOp&&<EditModal op={editingOp} onClose={()=>setEditingOp(null)} onSave={handleEditSave}/>}

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
                <button key={value} onClick={()=>{setLtfTf(value);try{localStorage.setItem('tp3_ltf',value);}catch{}}} style={{
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
                <Badge color={T.up}>H {signal?.pdh!=null?Math.round(signal.pdh):"--"}</Badge>
                {signal?.pdl!=null&&<Badge color={T.down}>L {Math.round(signal.pdl)}</Badge>}
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
                      <button key={v} onClick={()=>{set(v);try{localStorage.setItem(label==='SL'?'tp3_slPct':'tp3_tpPct',String(v));}catch{}}} style={{
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

            {/* Score + Copiar estado */}
            <div style={{marginTop:6,display:"flex",gap:4}}>
              <div style={{flex:1,padding:"5px 8px",borderRadius:5,textAlign:"center",fontFamily:MONO,fontSize:12,fontWeight:700,
                background:signalScore>=6?T.upBg:T.s2,color:signalScore>=6?T.up:T.muted,
                border:`1px solid ${signalScore>=6?T.upBorder:T.border}`}}>
                Score {signalScore}/10
              </div>
              <CopyTerminalBtn
                signal={signal} price={price} score={signalScore}
                session={session} d1Bias={d1Bias} htfTf={htfTf} ltfTf={ltfTf}
                slPct={slPct} tpPct={tpPct} hasNews={hasNews}
                wr={wr} totalOps={ops.length} pnlTotal={pnlTotal} connected={connected}
                sigError={sigError}
              />
            </div>
          </Card>

        </div>

        {/* ── MAIN FEED ── */}
        <div className="tp3-main"
          style={{background:T.bg,overflowY:"auto",padding:"8px 10px",display:"flex",flexDirection:"column"}}>
          <SessionBanner session={session}/>
          <VerdictCard signal={signal} price={price} score={signalScore} htfTf={htfTf} ltfTf={ltfTf}/>
          <CapitalRiskControl onChange={()=>setCapRiskKey(k=>k+1)}/>
          <MT5Block signal={signal} score={signalScore} price={price} slPct={slPct} tpPct={tpPct} refreshKey={capRiskKey}/>
          <Card>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:7}}>
              <SecTitle>Historial XAU/USD</SecTitle>
              <span style={{fontFamily:MONO,fontSize:9,color:T.muted}}>{ops.length} ops</span>
            </div>
            <HistoryList ops={ops} userId={userId} onUpdate={handleUpdate} onEdit={setEditingOp} onDelete={handleDelete} limit={5}/>
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
              userId={userId} onSaved={handleSaved}
              fillHeight
            />
          </div>
        </div>

      </div>
    </>
  );
}
