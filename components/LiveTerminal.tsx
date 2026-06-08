"use client";
// components/LiveTerminal.tsx — v4.1
// · Fair Value Gaps (FVG) — desequilibrios institucionales en sidebar
// · PDH/PDL — Previous Day High/Low como niveles de liquidez real
// · D1 Hard Filter — bloquea señales contra tendencia diaria
// · FVG en score +1
// · tpSource visible en bloque MT5 (session/structure/fallback)
//
// Cambios v4.1:
// · Bug 5.2 — capital_momento se guarda en cada op nueva (POST).
//   El historial de operaciones vive ahora en la pestaña Cuenta.
// · Limpieza 28/05/26 — sliders SL/TP eliminados del UI (Regla 5: hardcodeo).
//   Cap SL fijo en 0.75% y TP 100% estructural. Estado y constantes removidos.

import { useState, useEffect, useCallback, useRef } from "react";
import { calcLotSize } from "@/lib/engine/simulator";
import { precompute, getPDHL } from "@/lib/engine/indicators";
import { getLiveVerdict, mtfSignalAt, htfSignalAt } from "@/lib/engine/signals";
import type { LiquidityLevel, LiveVerdict } from "@/lib/engine/signals";
import { getEntryValidity } from "@/lib/engine/validity";
import {
  detectShadowCondition,
  calcShadowSetup,
  checkShadowOutcome,
  SHADOW_EXPIRY_MS,
} from "@/lib/engine/shadow";
import type { ShadowCaseType, ShadowDirection } from "@/lib/engine/shadow";
import type {
  Candle, PriceStructure, StructureLevels, SessionLevels,
  PrecomputedIndicators, SignalDirection,
} from "@/lib/engine/types";
import { supabaseBrowser } from "@/lib/db/supabase-client";
import { fetchLiveCandles } from "@/lib/binance/klines";

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
  hora_apertura_mt5:string|null;        // hora exacta MT5 (opcional, para timer Hold)
  created_at:string;                    // timestamp registro Supabase (fallback para timer Hold)
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
  // ── Arquitectura de 3 capas (22/05/26) — salida única del engine ──
  veredictoFinal:"ESPERAR"|"ENTRAR";
  detenidoEn:"capa1"|"capa2"|"capa3"|null;
  gates:{sesion:boolean;d1:boolean;rr:boolean;noticia:boolean};
  gatesPasan:boolean;
  score:number;
  scoreUmbral:number;
  // ── Liquidez (CAMBIO 27/05/26) ──
  liquidez:LiquidityLevel;     // "alta" (LDN/NY) o "baja" (resto de horas)
  liquidezAdj:number;          // ajuste al score: +1 si alta, -2 si baja
  scoreAjustado:number;        // score + liquidezAdj — uso interno
}

// Refactor 04/06/2026: BINANCE_FUTURES, fetchWithTimeout y fetchLiveCandles
// se movieron a lib/binance/klines.ts para separar la fuente Binance (REST)
// de la fuente TwelveData (WS). El import de fetchLiveCandles está arriba en
// la sección de imports.

// Cambio #7 (v5): calcSignalScore y getScoreThreshold movidos al engine.
// Fix #2 Auditoría 20/05/26 — el backtest también los usa ahora. Single source of truth.
// Ver: lib/engine/signals.ts (exports calcSignalScore, getScoreThreshold)

// Offset (local - UTC) en minutos para una zona horaria. Ajusta DST automáticamente.
// BST(verano LDN)=+60, GMT(invierno LDN)=0, EDT(verano NY)=-240, EST(invierno NY)=-300.
function getTZOffsetMin(tz:string):number{
  const d=new Date();
  const parts=new Intl.DateTimeFormat("en-US",{
    timeZone:tz,hour12:false,
    year:"numeric",month:"2-digit",day:"2-digit",
    hour:"2-digit",minute:"2-digit",second:"2-digit"
  }).formatToParts(d);
  const m:Record<string,string>={};
  parts.forEach(p=>{if(p.type!=="literal")m[p.type]=p.value;});
  const h=m.hour==="24"?0:parseInt(m.hour);
  const localMs=Date.UTC(
    parseInt(m.year),parseInt(m.month)-1,parseInt(m.day),
    h,parseInt(m.minute),parseInt(m.second)
  );
  return Math.round((localMs-d.getTime())/60000);
}
// Apertura LDN/NY en minutos UTC (08:00 hora local de cada ciudad, DST-aware)
function ldnOpenUTC():number{return 480-getTZOffsetMin("Europe/London");}
function nyOpenUTC():number{return 480-getTZOffsetMin("America/New_York");}
// CAMBIO (27/05/26): cierre/apertura semanal del oro = 17:00 hora Nueva York,
// DST-aware. Verano (EDT): 21:00 UTC. Invierno (EST): 22:00 UTC.
// Define el borde real del fin de semana (viernes 17:00 NY → domingo 17:00 NY).
function weeklyEdgeUTC():number{return 17*60-getTZOffsetMin("America/New_York");}
const SESSION_LEN=300; // 5h en minutos

function getSession():Session{
  const now=new Date();
  const day=now.getUTCDay();
  const u=now.getUTCHours()*60+now.getUTCMinutes();
  // CAMBIO (27/05/26): WEEKEND ahora cubre el fin de semana REAL —
  // desde el cierre del viernes (17:00 NY) hasta la apertura del domingo (17:00 NY),
  // no solo sábado completo + domingo-mañana. Sin esto, las 2-3 horas del viernes
  // noche (entre el cierre y la medianoche UTC) quedaban como "CLOSED" en vez
  // de "WEEKEND" — con el cambio sesión→liquidez eso daría señales con el
  // mercado realmente cerrado.
  const wEdge=weeklyEdgeUTC();
  if(day===6)return"WEEKEND";                    // sábado completo
  if(day===5&&u>=wEdge)return"WEEKEND";          // viernes tras el cierre semanal
  if(day===0&&u<wEdge)return"WEEKEND";           // domingo antes de la apertura
  const ldn=ldnOpenUTC();
  const ny=nyOpenUTC();
  // LDN: 08:00-13:00 hora Londres (verano: 07-12 UTC / invierno: 08-13 UTC)
  if(u>=ldn&&u<ldn+SESSION_LEN)return"LDN";
  // NY: 08:00-13:00 hora NY (verano: 12-17 UTC / invierno: 13-18 UTC) — incluye overlap + macro
  if(u>=ny&&u<ny+SESSION_LEN)return"NY";
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
  const ldn=ldnOpenUTC();
  const ny=nyOpenUTC();
  const nyClose=ny+SESSION_LEN;
  // CAMBIO (27/05/26): borde domingo = apertura real (17:00 NY, DST-aware),
  // no el hardcoded 1320 (que solo era correcto en invierno).
  const wEdge=weeklyEdgeUTC();
  // Fin de semana → próximo lunes LDN
  if(day===6){const minsToMon=(DAY-u)+DAY+ldn;return{label:"LDN Lunes",mins:minsToMon};}
  if(day===0&&u<wEdge){const minsToMon=(DAY-u)+ldn;return{label:"LDN Lunes",mins:minsToMon};}
  // Fix viernes tarde (v6): después del cierre NY el viernes,
  // el próximo evento es LDN del LUNES, no "mañana" (sábado).
  if(day===5&&u>=nyClose){const minsToMon=(DAY-u)+DAY+DAY+ldn;return{label:"LDN Lunes",mins:minsToMon};}
  // Días de semana
  if(u<ldn)return{label:"LDN Open",mins:ldn-u};
  if(u>=ldn+SESSION_LEN&&u<ny)return{label:"NY Open",mins:ny-u};
  const minsToLdn=u>=nyClose?DAY-u+ldn:ldn-u;
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

// ── EntryValidityIndicator ────────────────────────────────────────────────────
// Semáforo adaptativo de validez de entrada — capa de RENDERIZADO únicamente.
//
// La lógica de decisión (estado, label, reason, R:R live, override) vive en
// lib/engine/validity.ts → getEntryValidity(). Acá solo:
//   1. Mantenemos el tick de 5s para refrescar la UI con precio/tiempo nuevo
//   2. Llamamos al motor con los inputs actuales
//   3. Renderizamos el resultado (colores, emojis, estilos)
//
// Cambio 02/06/26 v7: refactor arquitectónico. La lógica del semáforo
// (antes 110 líneas inline) se migró al motor para cumplir el principio
// del knowledge: "el terminal LEE el veredicto del engine — no recalcula".
// Comportamiento idéntico al anterior, validado en producción.
function EntryValidityIndicator({
  signal, price, htfTf, d1Bias, h4Bias, snap
}:{
  signal:LiveSignal;
  price:number;
  htfTf:"1h"|"4h";
  d1Bias:MTFSig;
  h4Bias:MTFSig;
  snap:MT5Snapshot;
}){
  const[,setTick]=useState(0);
  useEffect(()=>{
    const id=setInterval(()=>setTick(t=>t+1),5000);
    return()=>clearInterval(id);
  },[]);

  // Cálculo delegado al motor (función pura, sin estado, sin framework)
  const validity = getEntryValidity({
    signal: {
      verdict:   signal.verdict,
      htf:       signal.htf,
      mtf:       signal.mtf,
      structure: signal.structure,
    },
    price,
    htfTf,
    d1Bias,
    h4Bias,
    snap: { sl: snap.sl, tp: snap.tp },
  });

  const { state, label, reason } = validity;

  const stateMap={
    green: {color:T.up,   bg:T.upBg,   border:T.upBorder, emoji:"🟢"},
    yellow:{color:T.wait, bg:T.warnBg||T.s2, border:T.warnBorder||T.border2, emoji:"🟡"},
    red:   {color:T.down, bg:T.dnBg,   border:T.dnBorder, emoji:"🔴"},
  };
  const s = stateMap[state];

  return(
    <div style={{
      display:"flex",alignItems:"center",gap:8,
      padding:"6px 10px",marginBottom:6,borderRadius:5,
      background:s.bg,border:`1px solid ${s.border}`
    }}>
      <span style={{fontSize:13}}>{s.emoji}</span>
      <span style={{fontFamily:SANS,fontSize:10,fontWeight:700,letterSpacing:"0.05em",
        textTransform:"uppercase",color:s.color}}>{label}</span>
      <span style={{fontFamily:MONO,fontSize:9,color:T.muted,marginLeft:"auto"}}>{reason}</span>
    </div>
  );
}

// ── NextCandleClock ───────────────────────────────────────────────────────────
// Cuenta regresiva hasta la apertura de la próxima vela HTF.
// HTF=1H → cierra a los :00 de cada hora UTC.
// HTF=4H → cierra a las 0,4,8,12,16,20 UTC.
//
// Estados visuales (semáforo):
// · >5 min → verde tranquilo (esperar)
// · 1-5 min → amarillo (preparar)
// · <1 min → rojo pulsante (listo para entrar), muestra M:SS
function NextCandleClock({htfTf}:{htfTf:"1h"|"4h"}){
  // tick fuerza re-render cada N segundos
  const[,setTick]=useState(0);

  useEffect(()=>{
    // Cuando falta poco, refrescar más seguido para mostrar segundos
    const updateInterval=():number=>{
      const remaining=getRemaining();
      // <60s → cada 1s · <5min → cada 10s · resto → cada 30s
      if(remaining<60_000)return 1000;
      if(remaining<5*60_000)return 10_000;
      return 30_000;
    };
    let id:ReturnType<typeof setTimeout>;
    const schedule=()=>{
      id=setTimeout(()=>{
        setTick(t=>t+1);
        schedule();
      },updateInterval());
    };
    schedule();
    return()=>clearTimeout(id);
  },[]);

  function getRemaining():number{
    const now=Date.now();
    const d=new Date(now);
    if(htfTf==="1h"){
      // Próximo cierre = siguiente :00 UTC
      const next=new Date(d);
      next.setUTCMinutes(0,0,0);
      next.setUTCHours(d.getUTCHours()+1);
      return next.getTime()-now;
    }else{
      // 4H: próximo cierre = siguiente bloque de 4h en UTC (0,4,8,12,16,20)
      const next=new Date(d);
      next.setUTCMinutes(0,0,0);
      const currH=d.getUTCHours();
      const nextH=Math.floor(currH/4)*4+4;
      if(nextH>=24){
        next.setUTCDate(d.getUTCDate()+1);
        next.setUTCHours(nextH-24);
      }else{
        next.setUTCHours(nextH);
      }
      return next.getTime()-now;
    }
  }

  const remainingMs=getRemaining();
  const totalSec=Math.max(0,Math.floor(remainingMs/1000));
  const mins=Math.floor(totalSec/60);
  const secs=totalSec%60;

  // Texto: minutos enteros si >=60s, M:SS si <60s
  const timeText=mins>=1?`${mins}m`:`0:${secs.toString().padStart(2,"0")}`;
  const tfLabel=htfTf==="1h"?"1H":"4H";

  // Semáforo
  let dotColor=T.up;
  let textColor=T.text;
  let pulse=false;
  if(remainingMs<60_000){
    dotColor=T.down;textColor=T.down;pulse=true;
  }else if(remainingMs<5*60_000){
    dotColor=T.wait;textColor=T.wait;
  }

  return(
    <div style={{
      display:"flex",alignItems:"center",gap:6,
      padding:"5px 8px",marginBottom:5,borderRadius:5,
      background:T.s2,border:`1px solid ${T.border}`
    }}>
      <span style={{
        display:"inline-block",width:8,height:8,borderRadius:"50%",
        background:dotColor,
        animation:pulse?"tp3-pulse 1s ease-in-out infinite":"none",
        boxShadow:pulse?`0 0 6px ${dotColor}`:"none"
      }}/>
      <span style={{fontFamily:SANS,fontSize:10,color:T.muted,fontWeight:600}}>
        Nueva vela de {tfLabel} abre en
      </span>
      <span style={{
        fontFamily:MONO,fontSize:13,fontWeight:700,color:textColor,
        marginLeft:"auto"
      }}>{timeText}</span>
      <style>{`@keyframes tp3-pulse{0%,100%{opacity:1}50%{opacity:0.4}}`}</style>
    </div>
  );
}

// ── MT5 Block ─────────────────────────────────────────────────────────────────
// Solo aparece cuando score >= threshold dinámico (6 si HTF+MTF alineados, 7 si no)
// y hay señal de entrada.
// Muestra los 3 precios exactos listos para copiar en MT5.
interface MT5BlockProps{
  signal:LiveSignal|null;
  score:number;
  price:number;
  refreshKey:number;  // se incrementa cuando cambia Capital o Riesgo → fuerza re-render
  htfTf:"1h"|"4h";    // para el reloj de cuenta regresiva
  d1Bias:MTFSig;      // para el override de tendencia ultra fuerte en el semáforo
  h4Bias:MTFSig;      // 4H restrictivo + override de tendencia (cambio #7)
}
// SNAPSHOT FREEZE (v7) ─────────────────────────────────────────────────────────
// El MT5Block congela TODOS sus valores (entrada, SL, TP, lotaje, capital, riskPct,
// niveles, R:R, ATR) en el instante exacto en que la señal pasa de ESPERAR → ENTRAR.
// Mientras la señal siga en ENTRAR, los valores NO se recalculan aunque cambien
// price, slPct, tpPct, capital o riskPct. Esto blinda la disciplina operativa:
// lo que Steven ve en pantalla es exactamente lo que va a pegar en MT5.
// Cuando la señal vuelve a ESPERAR, el componente desmonta y el snapshot se
// libera. Si vuelve a ENTRAR (incluso en dirección opuesta), captura uno nuevo.
type MT5Snapshot = {
  verdict:Verdict;
  isLong:boolean;
  entry:string;
  sl:string;
  tp:string;
  slPctStr:string;
  tpPctStr:string;
  capital:number;
  riskPct:number;
  lotaje:number;
  rr:number;
  atrVal:number|null;
  tpSource:string|undefined;
  structure:string|undefined;
  capturedAt:number;
};
function fmtSnapTime(ms:number):string{
  const d=new Date(ms-5*3600000);
  return`${d.getUTCHours().toString().padStart(2,"0")}:${d.getUTCMinutes().toString().padStart(2,"0")}:${d.getUTCSeconds().toString().padStart(2,"0")}`;
}

function MT5Block({signal,score,price,refreshKey,htfTf,d1Bias,h4Bias}:MT5BlockProps){
  void refreshKey;  // solo lo usamos para invalidar el render; lectura ya se hace por localStorage
  // Ref para el snapshot (debe declararse antes de cualquier early return — regla de hooks).
  const snapRef = useRef<MT5Snapshot|null>(null);

  // Arquitectura de 3 capas: lee el veredicto del engine, no recalcula.
  const isValidSignal = !!signal && signal.veredictoFinal==="ENTRAR";

  // Si la señal no es válida (ESPERAR o score insuficiente) → liberar snapshot y no mostrar nada.
  // La próxima vez que la señal entre en ENTRAR, capturará un snapshot fresco.
  if(!isValidSignal){
    snapRef.current=null;
    return null;
  }

  // ── Cálculo en vivo (solo se usa para CAPTURAR el snapshot la primera vez,
  //    o si la dirección de la señal cambió sin pasar por ESPERAR) ───────────
  const levels=signal!.levels;
  // Guard de TS: si llegamos acá, isValidSignal === true → levels NO es null por
  // construcción del motor (veredictoFinal==="ENTRAR" requiere gate R:R OK, que
  // requiere levels válidos). Este check existe solo para que TS esté contento.
  if(!levels){ snapRef.current=null; return null; }

  const isLongLive=signal!.verdict==="ENTRAR LONG";
  const atrValLive=signal!.atr;
  const entryLive = price>0?price.toFixed(2):"--";
  const slLive       = levels.slPrice.toFixed(2);
  const tpLive       = levels.tpPrice.toFixed(2);
  const slPctStrLive = `${levels.slPct.toFixed(2)}%`;
  const tpPctStrLive = `${levels.tpPct.toFixed(2)}%`;
  const capitalLive = (typeof window!=="undefined"&&parseFloat(localStorage.getItem("tp3_capital")||""))||10000;
  const riskPctLive = (typeof window!=="undefined"&&parseFloat(localStorage.getItem("tp3_risk")||""))||1;
  const slPointsLive = Math.abs(parseFloat(entryLive)-parseFloat(slLive));
  const lotajeLive = slPointsLive>0?calcLotSize(capitalLive,riskPctLive,slPointsLive):0;
  const rrLive = levels.slPct>0?(levels.tpPct/levels.slPct):0;

  // Capturar snapshot si:
  //   (a) es el primer render con señal válida (snapRef.current === null), o
  //   (b) la dirección cambió (LONG ↔ SHORT) sin pasar por ESPERAR.
  if(!snapRef.current||snapRef.current.verdict!==signal!.verdict){
    snapRef.current={
      verdict:signal!.verdict,
      isLong:isLongLive,
      entry:entryLive,
      sl:slLive,
      tp:tpLive,
      slPctStr:slPctStrLive,
      tpPctStr:tpPctStrLive,
      capital:capitalLive,
      riskPct:riskPctLive,
      lotaje:lotajeLive,
      rr:rrLive,
      atrVal:atrValLive,
      tpSource:levels?.tpSource,
      structure:levels?.structure,
      capturedAt:Date.now(),
    };
  }

  const snap=snapRef.current;
  const color=snap.isLong?T.up:T.down;

  // R:R calculado al momento del snapshot — bloquear si < 1.5
  if(snap.rr>0&&snap.rr<1.5){
    return(
      <Card style={{marginBottom:4,padding:"8px 10px",border:`1px solid ${T.down}40`,background:`${T.down}08`}}>
        <div style={{fontFamily:SANS,fontSize:9,fontWeight:700,color:T.down,marginBottom:4}}>⚠ ORDEN MT5 — R:R INVÁLIDO</div>
        <div style={{fontFamily:MONO,fontSize:9,color:T.muted}}>
          R:R calculado: <span style={{color:T.down,fontWeight:700}}>{snap.rr.toFixed(2)}:1</span> · mínimo 1.5:1
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
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <span style={{fontFamily:SANS,fontSize:9,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color}}>
            Orden MT5 · {snap.isLong?"LONG":"SHORT"}
          </span>
          <span title={`Valores fijos desde ${fmtSnapTime(snap.capturedAt)} COL — no se recalculan mientras dure la señal`}
            style={{fontFamily:MONO,fontSize:8,fontWeight:700,color:T.accent,padding:"1px 5px",borderRadius:3,
              background:`${T.accent}15`,border:`1px solid ${T.accent}40`,letterSpacing:"0.05em"}}>
            🔒 SNAPSHOT
          </span>
        </div>
      </div>

      {/* Hora de captura del snapshot */}
      <div style={{fontFamily:MONO,fontSize:8,color:T.muted,marginBottom:6,textAlign:"center"}}>
        Valores fijos desde {fmtSnapTime(snap.capturedAt)} COL · NO se recalculan
      </div>

      {/* Reloj de cuenta regresiva hasta próxima vela HTF */}
      <NextCandleClock htfTf={htfTf}/>

      {/* Semáforo adaptativo de validez de entrada (lee R:R desde el snapshot
          congelado, no del engine en vivo, para evitar inconsistencias cuando
          el engine deja de retornar levels al moverse el precio). */}
      <EntryValidityIndicator signal={signal!} price={price} htfTf={htfTf} d1Bias={d1Bias} h4Bias={h4Bias} snap={snap}/>

      {/* Los 4 valores para copiar — desde snapshot, no live */}
      {[
        {lbl:"ENTRADA",val:snap.entry,color:T.gold,hint:"market"},
        {lbl:"SL",     val:snap.sl,   color:T.down,hint:snap.slPctStr},
        {lbl:"TP",     val:snap.tp,   color:T.up,  hint:snap.tpPctStr},
        {lbl:"LOTAJE", val:snap.lotaje.toFixed(2),color:T.accent,hint:`$${snap.capital.toLocaleString()} × ${snap.riskPct}%`},
      ].map(({lbl,val,color:c,hint})=>(
        <div key={lbl} style={{display:"flex",alignItems:"center",justifyContent:"space-between",
          padding:"4px 6px",borderRadius:5,background:T.s2,marginBottom:3}}>
          <div>
            <span style={{fontFamily:MONO,fontSize:8,color:T.muted,marginRight:6}}>{lbl}</span>
            <span style={{fontFamily:MONO,fontSize:13,fontWeight:700,color:c}}>${val}</span>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:5}}>
            {/* Sub-item B.2 del handoff v13: hint hereda el color del valor de la fila (T.gold/T.down/T.up/T.accent), con bold y +1px en SL y TP para resaltar los porcentajes críticos. Aplica desktop+mobile. */}
            <span style={{fontFamily:MONO,fontSize:(lbl==="SL"||lbl==="TP")?9:8,fontWeight:(lbl==="SL"||lbl==="TP")?700:400,color:c}}>{hint}</span>
            <CopyButton value={val}/>
          </div>
        </div>
      ))}

      {/* Estructura LIVE del HTF actual — sincronizada con header y matriz lateral.
          Fix 02/06/26: antes leía snap.structure (congelado al capturar el snapshot)
          y mostraba valores desincronizados cuando el usuario cambiaba HTF sin que
          la señal pasara por ESPERAR. Ahora lee signal!.structure (live) para que
          coincida siempre con lo que se muestra arriba del cartel y en la matriz. */}
      {signal!.structure&&(
        <div style={{marginTop:4,fontFamily:MONO,fontSize:8,color:T.muted,textAlign:"center"}}>
          Estructura: {signal!.structure==="BULLISH"?"HH/HL ▲":signal!.structure==="BEARISH"?"LH/LL ▼":"NEUTRAL"}
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
  // Arquitectura de 3 capas: el umbral lo decide el engine (signal.scoreUmbral).
  const threshold=signal?signal.scoreUmbral:6;
  // CAMBIO (27/05/26):
  //  - row 0 muestra LIQUIDEZ con 3 estados (alta=ok, baja=warn, weekend=fail).
  //  - fila Score usa el score AJUSTADO (score puro + liquidezAdj) vs umbral.
  //  - footer LEE el veredicto del motor → nunca contradice al engine.
  const liquidez=signal?.liquidez;
  const liquidezAdj=signal?.liquidezAdj??0;
  const scoreAjustado=signalScore+liquidezAdj;
  type RowState="ok"|"warn"|"fail";
  const row0State:RowState =
    session==="WEEKEND" ? "fail" :
    liquidez==="alta"   ? "ok"   : "warn";
  const states:RowState[]=[
    row0State,
    // FIX 02/06/26: EMA200 sesgo fuera de alineación es "warn", NO "fail".
    // El motor lo trata como factor de score (+2 si alineado), no como gate
    // del terminal. Solo es gate opcional en BACKTEST (ema200Filter). Práctica
    // industria coincide (Smart Trail TV, EMA+RSI Decision Table V2).
    (ema200!=null&&price>0&&Math.abs(price-ema200)/ema200>0.002&&
      ((signal?.htf==="UP"&&price>ema200)||(signal?.htf==="DOWN"&&price<ema200))) ? "ok":"warn",
    // FIX 02/06/26: HTF+MTF ahora 3 estados (refleja la Capa 1 del motor):
    //   - HTF==MTF (FUERTE)        → "ok"   (verde, ✓)  — motor entra, Steven opera
    //   - HTF activo + MTF WAIT    → "warn" (amarillo, ·) — motor da MODERADA (Steven NO opera por política, pero el motor SÍ entra)
    //   - Contrarios o HTF en WAIT → "fail" (rojo, ✗)   — motor bloquea (Capa 1 detiene)
    // Antes solo distinguía 2 estados y la MODERADA aparecía igual que un bloqueo real.
    (signal!=null&&signal.htf!=="WAIT"&&signal.htf===signal.mtf) ? "ok" :
    (signal!=null&&signal.htf!=="WAIT"&&signal.mtf==="WAIT") ? "warn" : "fail",
    // FIX 02/06/26: RSI fuera de 30-70 es "warn", NO "fail". El motor lo trata
    // como factor de score (+1 si en rango), no como gate hard. Coherente con
    // práctica industria (TradingSim, QuantifiedStrategies) y con el patrón
    // de liquidez baja que también usa "warn".
    (rsi!=null&&rsi>=30&&rsi<=70) ? "ok":"warn",
    (!hasNews) ? "ok":"fail",
    (scoreAjustado>=threshold) ? "ok":"fail",
  ];
  const items=[
    session==="WEEKEND" ? "Mercado cerrado · fin de semana" :
      liquidez==="alta" ? "Liquidez alta (+1)" : "Liquidez baja (−2)",
    "EMA200 sesgo claro",
    "HTF + MTF alineados",
    `RSI ok${rsi!=null?` (${rsi.toFixed(0)})`:""}`,
    "Sin noticia 30M",
    // Fila Score: muestra la math (puro + ajuste = efectivo vs umbral)
    `Score ≥ ${threshold} (${signalScore}${liquidezAdj>=0?"+":""}${liquidezAdj}=${scoreAjustado})`
  ];
  const okCount=states.filter(s=>s==="ok").length;
  // El footer LEE el veredicto del engine (no recalcula).
  const enterMode=signal?.veredictoFinal==="ENTRAR";
  // Styling por estado de fila
  const stateBg=(st:RowState)=>st==="ok"?T.upBg:st==="warn"?T.warnBg:T.dnBg;
  const stateColor=(st:RowState)=>st==="ok"?T.up:st==="warn"?T.wait:T.down;
  const stateBorder=(st:RowState)=>st==="ok"?T.upBorder:st==="warn"?T.warnBorder:T.dnBorder;
  const stateSym=(st:RowState)=>st==="ok"?"✓":st==="warn"?"·":"✗";
  return(
    <Card style={{marginBottom:4,padding:"7px 10px"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:5}}>
        <SecTitle>Checklist XAU/USD</SecTitle>
        <span style={{fontFamily:MONO,fontSize:9,color:okCount===6?T.up:okCount>=4?T.wait:T.muted}}>{okCount}/6</span>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:2}}>
        {items.map((lbl,i)=>{
          const isNews = i===4;
          const st=states[i];
          return(
            <div key={i} style={{display:"flex",alignItems:"center",justifyContent:"space-between",
              padding:"3px 7px",borderRadius:4,fontSize:9,
              background:stateBg(st),color:stateColor(st),
              border:`1px solid ${stateBorder(st)}`}}>
              <div style={{display:"flex",alignItems:"center",gap:5}}>
                <span style={{fontSize:10,width:12,textAlign:"center",flexShrink:0}}>{stateSym(st)}</span>
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
        background:enterMode?T.upBg:T.dnBg,color:enterMode?T.up:T.down,border:`1px solid ${enterMode?T.upBorder:T.dnBorder}`}}>
        {enterMode?`OK · ${signal?.htf==="UP"?"BUSCAR LONG":"BUSCAR SHORT"}`:`${okCount}/6 indicadores · ESPERAR`}
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
    // CAMBIO (27/05/26): los textos pasaron a hablar de "mercado abierto/cerrado" y "liquidez",
    // ya no de "ventana operativa" (que dejó de bloquear). Sin horarios hardcodeados.
    LDN:{label:"LDN",sub:"Mercado abierto · liquidez alta",color:T.wait,bg:T.warnBg,border:T.warnBorder},
    NY:{label:"NY",sub:"Mercado abierto · liquidez alta",color:T.up,bg:T.upBg,border:T.upBorder},
    CLOSED:{label:"MERCADO",sub:"Mercado abierto · liquidez baja",color:T.muted,bg:T.s1,border:T.border},
    WEEKEND:{label:"FIN DE SEMANA",sub:"Mercado cerrado · fin de semana",color:T.down,bg:T.dnBg,border:T.dnBorder},
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
  hasNews:boolean;
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
    // Arquitectura de 3 capas: lee el veredicto del engine, no recalcula.
    const verdict=s?.veredictoFinal==="ENTRAR"?s?.verdict:"ESPERAR";
    const sesLbl=p.session==="LDN"?"LDN ACTIVA":p.session==="NY"?"NY ACTIVA (+OVERLAP)":p.session==="WEEKEND"?"FIN DE SEMANA":"CLOSED";
    const d1lbl=p.d1Bias==="UP"?"▲ ALCISTA":p.d1Bias==="DOWN"?"▼ BAJISTA":"- NEUTRAL";
    const fvg=s?.fvgBull?`▲ ${s.fvgBull.bot.toFixed(0)}-${s.fvgBull.top.toFixed(0)}`:s?.fvgBear?`▼ ${s.fvgBear.bot.toFixed(0)}-${s.fvgBear.top.toFixed(0)}`:"NONE";
    const struct=s?.structure==="BULLISH"?"HH/HL ▲":s?.structure==="BEARISH"?"LH/LL ▼":"NEUTRAL";
    const mtfTf=p.htfTf==="4h"?"1H":"15M";

    // Motivo del ESPERAR — mismo cálculo que VerdictCard (alineación UI ↔ clipboard).
    // Formato nuevo (28/05/26): conclusión primero, razón inmediata, dato técnico al
    // final. Sin contradicciones (FUERTE solo aparece con ENTRAR). Basado en
    // research de eye-tracking + cognitive load theory aplicado a dashboards.
    let motivoEspera="";
    if(s && s.veredictoFinal!=="ENTRAR"){
      if(s.detenidoEn==="capa1")           motivoEspera="Sin dirección clara";
      else if(s.detenidoEn==="capa2"){
        if(!s.gates?.sesion)               motivoEspera="Mercado cerrado";
        else if(!s.gates?.d1)              motivoEspera="D1 en contra";
        else if(!s.gates?.rr)              motivoEspera="R:R insuficiente";
        else if(!s.gates?.noticia)         motivoEspera="Noticia de alto impacto";
        else                               motivoEspera="Condición no cumplida";
      }
      else if(s.detenidoEn==="capa3")      motivoEspera="Señal débil";
    }
    const senalLine = s?.veredictoFinal==="ENTRAR"
      ? `🎯 ${verdict} · ${s?.strength??"-"} · Score ${p.score}/10`
      : `🎯 ESPERAR · ${motivoEspera||"sin datos"} · Score ${p.score}/10`;
    const txt=[
      `━━━ TP3 Terminal · XAU/USD ━━━`,
      `📅 ${date} ${time}`,
      `💰 Precio: $${p.price>0?p.price.toFixed(2):"--"} · ${p.connected?"TwelveData LIVE":"desconectado"}`,
      `🕐 Sesión: ${sesLbl}${next?` · ${next.label} en ${fmtCountdown(next.mins)}`:""}`,
      `⏱ Vela cierra en: ${candleMins}m`,
      `📊 Config: HTF ${p.htfTf.toUpperCase()} · MTF ${mtfTf} · LTF ${p.ltfTf.toUpperCase()}`,
      p.sigError?`⚠ Error señales: ${p.sigError}`:"",
      ``,
      senalLine,
      ``,
      `📈 MTF MATRIX:`,
      `  D1:  ${d1lbl}`,
      `  ${p.htfTf.toUpperCase()}: ${s?.htf??"WAIT"} · ${mtfTf}: ${s?.mtf??"WAIT"} · ${p.ltfTf.toUpperCase()}: ${s?.ltf??"WAIT"}`,
      `  Estructura: ${struct} · FVG: ${fvg}`,
      `  RSI: ${s?.rsi!=null?s.rsi.toFixed(0):"--"} · EMA200: ${s?.ema200!=null?s.ema200.toFixed(0):"--"} · ATR: ${s?.atr!=null?s.atr.toFixed(1):"--"}/vela`,
      ``,
      ...(s?.levels&&s.veredictoFinal==="ENTRAR"?[
        `📋 ORDEN MT5:`,
        `  ENTRADA: $${s.levels.entryPrice.toFixed(2)}`,
        `  SL:      $${s.levels.slPrice.toFixed(2)} (${s.levels.slPct.toFixed(2)}%)`,
        `  TP:      $${s.levels.tpPrice.toFixed(2)} (${s.levels.tpPct.toFixed(2)}%) [${s.levels.tpSource}]`,
        ``,
      ]:[]),
      `✅ CHECKLIST:`,
      // CAMBIO (27/05/26): la fila de sesión pasó a mostrar la LIQUIDEZ.
      `  Liquidez:          ${p.session==="WEEKEND"?"✗ Mercado cerrado":s?.liquidez==="alta"?"✓ alta (+1)":"· baja (−2)"}`,
      `  EMA200 sesgo:      ${s?.ema200!=null&&p.price>0&&Math.abs(p.price-s.ema200)/s.ema200>0.002&&((s?.htf==="UP"&&p.price>s.ema200)||(s?.htf==="DOWN"&&p.price<s.ema200))?"✓":"·"}`,
      `  HTF+MTF alineados: ${s?.htf!=="WAIT"&&s?.htf===s?.mtf?"✓":s?.htf!=="WAIT"&&s?.mtf==="WAIT"?"·":"✗"}`,
      `  RSI ok:            ${s?.rsi!=null&&s.rsi>=30&&s.rsi<=70?"✓":"·"} (${s?.rsi!=null?s.rsi.toFixed(0):"--"})`,
      `  Sin noticia:       ${!p.hasNews?"✓":"✗ HAY NOTICIA"}`,
      // Score con la math: puro + ajuste = efectivo vs umbral
      `  Score ≥ ${s?.scoreUmbral??6}:         ${(p.score+(s?.liquidezAdj??0))>=(s?.scoreUmbral??6)?"✓":"✗"} (${p.score}${(s?.liquidezAdj??0)>=0?"+":""}${s?.liquidezAdj??0}=${p.score+(s?.liquidezAdj??0)})`,
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
function VerdictCard({signal,price,score,htfTf,ltfTf,session}:{signal:LiveSignal|null;price:number;score:number;htfTf:string;ltfTf:string;session:Session}){
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
  // ── Arquitectura de 3 capas: el VerdictCard LEE la salida del engine ──
  // Ya no recalcula. signal.veredictoFinal es la decisión única.
  const verdict:Verdict=signal.veredictoFinal==="ENTRAR"?signal.verdict:"ESPERAR";
  const esEntrar=signal.veredictoFinal==="ENTRAR";

  // Motivo del ESPERAR — según en qué capa se detuvo. El VerdictCard ya no
  // "adorna" un ESPERAR con fuerza/score como si fuera señal válida.
  let motivoEspera="";
  if(!esEntrar){
    if(signal.detenidoEn==="capa1")      motivoEspera="Sin dirección clara";
    else if(signal.detenidoEn==="capa2"){
      // CAMBIO (27/05/26): la 1ª llave ahora es "mercado abierto"
      // (solo falla en weekend). El texto "fuera de ventana operativa"
      // dejó de aplicar — la hora ya no bloquea, se maneja como liquidez.
      if(!signal.gates.sesion)           motivoEspera="Mercado cerrado · fin de semana";
      else if(!signal.gates.d1)          motivoEspera="D1 en contra";
      else if(!signal.gates.rr)          motivoEspera="R:R insuficiente";
      else if(!signal.gates.noticia)     motivoEspera="Noticia de alto impacto";
      else                               motivoEspera="Condición no cumplida";
    }
    else if(signal.detenidoEn==="capa3") motivoEspera="Señal débil (score bajo)";
  }

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
            {esEntrar?(
              // Señal válida: muestra fuerza, score y estructura
              <>
                <Badge color={sc[signal.strength]}>{signal.strength}</Badge>
                <span style={{fontFamily:MONO,fontSize:10,color:T.up}}>Score {signal.score}/10</span>
                <span style={{fontFamily:MONO,fontSize:9,color:signal.structure==="BULLISH"?T.up:signal.structure==="BEARISH"?T.down:T.muted}}>{structureLabel}</span>
                {signal.fvgActive&&<Badge color={T.accent}>FVG ✓</Badge>}
              </>
            ):(
              // ESPERAR: muestra SOLO el motivo, sin adornar con fuerza/score
              <span style={{fontFamily:MONO,fontSize:10,color:T.muted}}>{motivoEspera}</span>
            )}
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


// ── MobileBottomNav (Sub-items B.6/B.7/B.8 del handoff v13) ──────────────────
// Barra de navegación inferior visible SOLO en mobile (<700px).
// 3 tabs: Veredicto / Análisis / Registro. Permite a Steven (admin) navegar
// entre las 3 secciones del terminal desde el iPhone. En desktop/tablet la
// barra está oculta y los 3 paneles se muestran lado a lado como siempre.
//
// Diseño profesional: solo texto (sin emojis), border-top 2px T.accent para
// el tab activo, color T.muted para inactivos. padding-bottom usa
// env(safe-area-inset-bottom) para no chocar con el home indicator de iOS.
type MobileTab = "veredicto" | "analisis" | "registro";
function MobileBottomNav({active,onChange}:{active:MobileTab;onChange:(t:MobileTab)=>void}){
  const tabs:{id:MobileTab;label:string}[]=[
    {id:"veredicto",label:"Veredicto"},
    {id:"analisis", label:"Análisis"},
    {id:"registro", label:"Registro"},
  ];
  return(
    <nav className="tp3-mobile-bottom-nav" style={{
      position:"fixed",bottom:0,left:0,right:0,zIndex:100,
      background:T.s1,borderTop:`1px solid ${T.border}`,
      paddingBottom:"env(safe-area-inset-bottom)",
    }}>
      <div style={{display:"flex"}}>
        {tabs.map(({id,label})=>{
          const isActive=active===id;
          return(
            <button key={id} onClick={()=>onChange(id)} style={{
              flex:1,padding:"12px 0",border:"none",background:"transparent",
              cursor:"pointer",borderTop:`2px solid ${isActive?T.accent:"transparent"}`,
              color:isActive?T.accent:T.muted,
              fontFamily:SANS,fontSize:11,fontWeight:isActive?700:600,
              letterSpacing:"0.02em",transition:"color 0.15s,border-color 0.15s",
            }}>{label}</button>
          );
        })}
      </div>
    </nav>
  );
}


// ── ROOT ──────────────────────────────────────────────────────────────────────
// ── Shadow Trading Pipeline ──────────────────────────────────────────────────
// Captura señales TEÓRICAS que el motor rechaza (D1 hard filter) o emite con
// estructura contradictoria (detector), y cierra las que alcanzaron TP/SL/24h
// (tracker). Se ejecuta al final de cada load() del motor (cada 5 min y en
// visibilitychange). Silencioso por diseño: los errores se logean a consola
// pero NUNCA propagan al flujo principal del terminal.
//
// Deduplicación: usa una key { case_type, direction, hora-UTC } para evitar
// inserts duplicados del mismo evento. El bucket horario es independiente
// del htfTf actual (la tabla NO persiste htfTf, así que rehidratar con una
// key que dependa del TF daría miss). Restricción efectiva: 1 captura por
// hora calendario UTC por case_type por dirección. Más estricto que "una
// por vela HTF" pero seguro y suficiente para los volúmenes esperados.
function shadowDedupKey(
  caseType: ShadowCaseType,
  direction: ShadowDirection,
  atMs: number,
): string {
  const d = new Date(atMs);
  d.setUTCMinutes(0, 0, 0);
  return `${caseType}-${direction}-${d.getTime()}`;
}

interface ShadowPipelineDeps {
  htfInd:      PrecomputedIndicators;
  htfIdx:      number;
  livePrice:   number;
  session:     SessionLevels;
  sessionTag:  "LDN" | "NY" | "CLOSED" | "WEEKEND";
  verdict:     LiveVerdict;
  m15Sig:      SignalDirection;
  ltfSig:      SignalDirection;
  d1Bias:      SignalDirection;
  h4Bias:      SignalDirection;
  atr:         number | null;
  htfTf:       "1h" | "4h";
  seenKeysRef: React.MutableRefObject<Set<string>>;
}

async function runShadowPipeline(deps: ShadowPipelineDeps): Promise<void> {
  const {
    htfInd, htfIdx, livePrice, session, sessionTag, verdict,
    m15Sig, ltfSig, d1Bias, h4Bias, atr, htfTf, seenKeysRef,
  } = deps;

  try {
    // ── 1. DETECTOR ───────────────────────────────────────────────────────
    if (livePrice > 0) {
      const detection = detectShadowCondition({
        verdict, m15Sig, ltfSig, d1Bias, h4Bias, atr, htfTf,
      });
      if (detection) {
        const key = shadowDedupKey(detection.caseType, detection.direction, Date.now());
        if (!seenKeysRef.current.has(key)) {
          // FIX RACE CONDITION (08/06/26): reservar la dedup key ANTES de
          // cualquier await. Antes, el add() se hacía DESPUÉS del fetch
          // exitoso, dejando un gap durante el cual otra invocación del
          // pipeline (gatillada por visibilityChange, cambio de htfTf, o
          // colisión con setInterval) podía pasar el check y disparar un
          // POST duplicado en paralelo. Resultado observado el 07/06 15:13
          // y 15:14 UTC: dos filas en BD con event_id distinto pero datos
          // idénticos. La reserva inmediata + try/finally garantiza que
          // (a) solo un POST en vuelo por key, y (b) si el POST falla,
          // se libera la reserva para reintentar en el siguiente ciclo.
          seenKeysRef.current.add(key);
          let success = false;
          try {
            const setup = calcShadowSetup(
              htfInd, htfIdx, detection.direction, livePrice, session,
            );
            if (setup) {
              // La tabla exige tp_price NOT NULL → filtrar perfiles sin TP.
              // Cada evento termina con 1 a 4 filas según cuántos perfiles
              // produjeron un nivel hipotético válido.
              const validProfiles = setup.profiles
                .filter(p => p.tpPrice != null && p.tpPrice > 0)
                .map(p => {
                  const tpDist = Math.abs((p.tpPrice as number) - setup.entry);
                  const tpPct  = (tpDist / setup.entry) * 100;
                  return {
                    tp_type:  p.type,
                    tp_price: p.tpPrice as number,
                    tp_pct:   Math.round(tpPct * 100) / 100,
                  };
                });

              if (validProfiles.length > 0) {
                // En WEEKEND el detector NO dispara (el motor exige sesión OK
                // para FUERTES), pero el mapeo queda explícito por si en el
                // futuro se relaja la regla.
                const liquidezDb: "alta" | "baja" | "weekend" =
                  sessionTag === "WEEKEND" ? "weekend" : detection.liquidez;

                const headers = await authHeaders();
                const res = await fetch("/api/shadow-trades", {
                  method: "POST",
                  headers: { "Content-Type": "application/json", ...headers },
                  body: JSON.stringify({
                    case_type:      detection.caseType,
                    direction:      detection.direction,
                    entry_price:    setup.entry,
                    sl_price:       setup.sl,
                    sl_pct:         setup.slPct,
                    score_puro:     detection.scorePuro,
                    score_ajustado: detection.scoreAjustado,
                    rsi_at_entry:   detection.rsi,
                    atr_at_entry:   detection.atr,
                    liquidez:       liquidezDb,
                    d1_bias:        detection.d1Bias,
                    profiles:       validProfiles,
                  }),
                });
                if (res.ok) {
                  success = true;
                  // eslint-disable-next-line no-console
                  console.log(
                    `[Shadow] Captured ${detection.caseType} ${detection.direction} ` +
                    `(${validProfiles.length} perfiles, key=${key})`
                  );
                } else {
                  // eslint-disable-next-line no-console
                  console.warn(`[Shadow] POST falló: ${res.status}`);
                }
              }
            }
          } finally {
            // Si NO se confirmó el insert (POST falló, setup null, o sin
            // perfiles válidos), liberar la reserva para que el próximo
            // ciclo pueda reintentar. La rama exitosa deja la key en el
            // Set, idéntico al comportamiento anterior.
            if (!success) seenKeysRef.current.delete(key);
          }
        }
      }
    }

    // ── 2. TRACKER ────────────────────────────────────────────────────────
    if (livePrice <= 0) return;
    const headers = await authHeaders();
    const openRes = await fetch("/api/shadow-trades?status=OPEN", { headers });
    if (!openRes.ok) return;
    const openTrades = await openRes.json() as Array<{
      id:          string;
      direction:   "LONG" | "SHORT";
      entry_price: number;
      tp_price:    number;
      sl_price:    number;
      created_at:  string;
    }>;
    if (!Array.isArray(openTrades) || openTrades.length === 0) return;

    for (const t of openTrades) {
      const createdMs = new Date(t.created_at).getTime();
      if (!Number.isFinite(createdMs)) continue;

      const outcome = checkShadowOutcome({
        tpPrice:   t.tp_price,
        slPrice:   t.sl_price,
        direction: t.direction,
        createdAt: createdMs,
        expiresAt: createdMs + SHADOW_EXPIRY_MS,
      }, livePrice);

      if (outcome.status === "OPEN")                             continue;
      if (outcome.hitPrice == null || outcome.closedAt == null)  continue;

      // pnl_pct con signo: positivo = a favor del trade teórico,
      // negativo = en contra. EXPIRED puede caer a cualquier lado.
      const isLong  = t.direction === "LONG";
      const moveAbs = outcome.hitPrice - t.entry_price;
      const pnlPctRaw = isLong
        ? ( moveAbs / t.entry_price) * 100
        : (-moveAbs / t.entry_price) * 100;
      const pnlPct = Math.round(pnlPctRaw * 100) / 100;

      const patchRes = await fetch("/api/shadow-trades", {
        method:  "PATCH",
        headers: { "Content-Type": "application/json", ...headers },
        body:    JSON.stringify({
          id:           t.id,
          status:       outcome.status,
          result_price: outcome.hitPrice,
          result_at:    new Date(outcome.closedAt).toISOString(),
          pnl_pct:      pnlPct,
        }),
      });
      if (patchRes.ok) {
        // eslint-disable-next-line no-console
        console.log(
          `[Shadow] Cerrado ${t.id.slice(0, 8)} → ${outcome.status} ` +
          `@ ${outcome.hitPrice.toFixed(2)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)`
        );
      } else {
        // eslint-disable-next-line no-console
        console.warn(`[Shadow] PATCH falló (${t.id.slice(0, 8)}): ${patchRes.status}`);
      }
    }
  } catch (e) {
    // Silencioso por diseño — el shadow no debe romper el terminal.
    // eslint-disable-next-line no-console
    console.warn("[Shadow] pipeline error:", e);
  }
}

export default function LiveTerminal({userId,price,connected,notifPerm,notifEnabled}:{userId:string;price:number;connected:boolean;notifPerm:"default"|"granted"|"denied";notifEnabled:boolean}){
  const[session,  setSession] = useState<Session>("CLOSED");
  const[signal,   setSignal]  = useState<LiveSignal|null>(null);
  const[ops,      setOps]     = useState<Operation[]>([]);
  const[sigError, setSigError]= useState<string|null>(null);
  const[hasNews,  setHasNews] = useState(false);
  const[d1Bias,   setD1Bias]  = useState<MTFSig>("WAIT");
  // Cambio #7 (v5): 4H como filtro restrictivo. Si va en contra del trade, resta 2 al score.
  // El override de "tendencia ultra fuerte" en el semáforo también lo lee.
  const[h4Bias,   setH4Bias]  = useState<MTFSig>("WAIT");

  const[htfTf,setHtfTf] = useState<"4h"|"1h">(()=>{ try{ const v=localStorage.getItem('tp3_htf'); return (v==="4h"||v==="1h")?v:"1h"; }catch{ return "1h"; } });
  const[ltfTf,setLtfTf] = useState<"15m"|"5m">(()=>{ try{ const v=localStorage.getItem('tp3_ltf'); return (v==="15m"||v==="5m")?v:"15m"; }catch{ return "15m"; } });
  // Nota: slPct/tpPct y sus constantes SL_OPTIONS/TP_OPTIONS removidos el 28/05/26.
  // Los sliders del UI quedaron sin efecto desde que el motor pasó a usar
  // slCapPct=0.75 hardcodeado y TP 100% estructural. Limpieza completa.
  // Claves de localStorage 'tp3_slPct' / 'tp3_tpPct' pueden quedar en el navegador
  // del usuario pero nadie las lee.

  // Cambio #4 (v5): refreshKey se incrementa cuando el usuario cambia Capital o
  // Riesgo en el CapitalRiskControl central. Esto fuerza re-render del MT5Block
  // para que recalcule el lotaje con los nuevos valores del localStorage.
  const[capRiskKey,setCapRiskKey]=useState(0);

  // ─── MOBILE TAB STATE (Sub-items B.6/B.7/B.8 del handoff v13) ─────────────
  // En mobile (<700px) solo se muestra UNO de los 3 paneles a la vez.
  // El usuario navega entre ellos con la <MobileBottomNav>.
  // En desktop/tablet este estado existe pero no afecta el render (los 3
  // paneles se muestran lado a lado por las media queries CSS).
  //
  // Regla del proyecto: default neutro + populate en useEffect para evitar
  // mismatch de hidratación (matchMedia y localStorage solo existen client-side).
  const[mobileTab,setMobileTab]=useState<MobileTab>("veredicto");
  const[isMobile,setIsMobile]=useState(false);
  useEffect(()=>{
    // Cargar el último tab persistido en localStorage
    try{
      const saved=localStorage.getItem("tp3_mobile_tab");
      if(saved==="veredicto"||saved==="analisis"||saved==="registro"){
        setMobileTab(saved);
      }
    }catch{}
    // Detectar viewport mobile con matchMedia (standard estable, sin polling)
    const mq=window.matchMedia("(max-width: 700px)");
    setIsMobile(mq.matches);
    const handler=(e:MediaQueryListEvent)=>setIsMobile(e.matches);
    mq.addEventListener("change",handler);
    return()=>mq.removeEventListener("change",handler);
  },[]);
  const handleMobileTab=(tab:MobileTab)=>{
    setMobileTab(tab);
    try{localStorage.setItem("tp3_mobile_tab",tab);}catch{}
  };

  // Ref para price — se actualiza sin disparar re-renders
  const priceRef = useRef(price);

  // Bug refresh (fix 30/05/26): flag que detecta el primer tick de precio
  // del WS. Sin esto, tras Cmd+Shift+R el primer load() arranca con
  // priceRef.current = 0 y calcula erróneamente, y como `price` no está en
  // deps del useEffect MTF, nunca se re-disparaba al llegar el primer tick.
  // Solución: cuando price > 0 por primera vez, firstPriceReady pasa de
  // false a true UNA sola vez, lo que dispara un re-run del useEffect MTF
  // ya con precio válido. Aditivo, sin riesgo.
  const [firstPriceReady, setFirstPriceReady] = useState(false);
  useEffect(() => {
    if (price > 0 && !firstPriceReady) setFirstPriceReady(true);
  }, [price, firstPriceReady]);

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

  // Arquitectura de 3 capas: el score lo calcula el engine (getLiveVerdict).
  // El terminal LEE signal.score — ya no recalcula con calcSignalScore.
  const signalScore=signal?signal.score:0;

  // ─── PUSH NOTIFICATIONS (Cambio #7) ────────────────────────────────────────
  // Detecta transición ESPERAR → ENTRAR y dispara notificación del navegador.
  // Cooldown 90s por dirección (LONG/SHORT independientes) — industry standard.
  // No filtra por R:R efectivo: el sistema es de baja frecuencia (~7/mes),
  // capturar todo es prioritario sobre selectividad.
  //
  // B.9 (04/06/26): notifPerm se lifteó a app/page.tsx y llega acá como prop.
  // B.11 (06/06/26): notifEnabled también se lifteó (silenciador local del
  // botón 🔔 del topbar, persistido en localStorage). El useEffect disparador
  // respeta ambos: dispara SOLO si notifPerm === "granted" && notifEnabled.
  // C-final (06/06/26): el banner "🔔 Alertas activas" del checklist se
  // eliminó por redundancia con el botón del topbar. requestNotif ya no llega
  // a este componente (vive solo en page.tsx para el handler del topbar).
  const lastVerdictRef=useRef<Verdict>("ESPERAR");
  const cooldownLongRef =useRef<number>(0);
  const cooldownShortRef=useRef<number>(0);

  // ── Shadow Trading: set de keys ya capturadas (deduplicación) ───────────
  // Se hidrata al montar con los trades recientes desde el API (ver useEffect
  // más abajo). Cada captura nueva exitosa agrega su key al set.
  const shadowSeenKeysRef = useRef<Set<string>>(new Set());

  // Detector de transición + disparador
  useEffect(()=>{
    if(typeof window==="undefined"||!("Notification" in window))return;
    if(notifPerm!=="granted")return;
    if(!notifEnabled)return; // B.11: respeta el silenciador local del topbar
    if(!signal)return;

    // Arquitectura de 3 capas: el veredicto lo decide el engine.
    // El terminal LEE signal.veredictoFinal — ya no recalcula score>=threshold.
    const verdict:Verdict=signal.veredictoFinal==="ENTRAR"?signal.verdict:"ESPERAR";
    const prev=lastVerdictRef.current;
    lastVerdictRef.current=verdict;

    // Solo notificar en transición ESPERAR → ENTRAR (cualquier dirección)
    if(prev!=="ESPERAR")return;
    if(verdict==="ESPERAR")return;

    // Cooldown 90 segundos por dirección
    const now=Date.now();
    const COOLDOWN_MS=90_000;
    const isLong=verdict==="ENTRAR LONG";
    const cooldownRef=isLong?cooldownLongRef:cooldownShortRef;
    if(now-cooldownRef.current<COOLDOWN_MS)return;
    cooldownRef.current=now;

    // Calcular R:R efectivo si entrara ahora (mismo cálculo que el semáforo)
    let rrEffective:number|null=null;
    let rrEmoji="";
    if(signal.levels&&price>0){
      const slDist=Math.abs(price-signal.levels.slPrice);
      const tpDist=Math.abs(signal.levels.tpPrice-price);
      if(slDist>0){
        rrEffective=tpDist/slDist;
        rrEmoji=rrEffective>=3.5?"🟢":rrEffective>=2.5?"🟡":"🔴";
      }
    }

    const dirText=isLong?"ENTRAR LONG ▲":"ENTRAR SHORT ▼";
    const priceText=`$${price.toFixed(2)}`;
    const scoreText=`Score ${signalScore}/10`;
    const rrText=rrEffective!=null?` · ${rrEmoji} R:R ${rrEffective.toFixed(1)}:1`:"";

    try{
      const n=new Notification(`🎯 TP3 · ${dirText}`,{
        body:`${priceText} · ${scoreText}${rrText}`,
        icon:"/favicon.ico",
        tag:`tp3-${verdict}`, // mismo tag → reemplaza notif previa del mismo lado
        requireInteraction:false,
        silent:false,
      });
      // Click en notif → enfocar tab
      n.onclick=()=>{
        window.focus();
        n.close();
      };
    }catch(e){
      console.error("Notif error:",e);
    }
  },[signal,signalScore,price,notifPerm,notifEnabled]);
  // ───────────────────────────────────────────────────────────────────────────

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
        // El 4H solo se fetcha aparte si htfTf no es 4h (sino ya está en htfC)
        const need4h = htfTf!=="4h";
        const results=await Promise.allSettled([
          fetchLiveCandles(htfTf,250),
          fetchLiveCandles(mtfTf,250),
          fetchLiveCandles("15m",150),
          fetchLiveCandles(ltfTf,120),
          fetchLiveCandles("1d",300),   // D1 bias — 300 para EMA200
          need4h?fetchLiveCandles("4h",250):Promise.resolve([] as Candle[]),
        ]);
        const htfC  = results[0].status==="fulfilled"?results[0].value:[];
        const mtfC  = results[1].status==="fulfilled"?results[1].value:[];
        const m15C  = results[2].status==="fulfilled"?results[2].value:[];
        const ltfC  = results[3].status==="fulfilled"?results[3].value:[];
        const d1C   = results[4].status==="fulfilled"?results[4].value:[];
        const h4C   = results[5].status==="fulfilled"?results[5].value:[];
        if(htfC.length<50||mtfC.length<50){setSigError("Datos insuficientes de Binance");return;}

        const htfInd=precompute(htfC),mtfInd=precompute(mtfC);
        const m15Ind=precompute(m15C),ltfInd=precompute(ltfC);

        // D1 bias + PDH/PDL
        let d1SigLocal:MTFSig="WAIT";
        let sessionLevels:SessionLevels={pdh:null,pdl:null,pdc:null};
        if(d1C.length>=50){
          const d1Ind=precompute(d1C);
          const{sig:d1Sig}=htfSignalAt(d1Ind,d1C.length-1);
          d1SigLocal=d1Sig;
          setD1Bias(d1Sig);
          sessionLevels=getPDHL(d1C);
        }

        // 4H bias — siempre calcular, sea filtro restrictivo o info contextual
        // Cuando htfTf==="4h", el 4H ya viene en htfC (no se vuelve a fetchear).
        let h4SigLocal:MTFSig="WAIT";
        if(htfTf==="4h"){
          // El propio HTF ya es 4H → su signal es h4
          const{sig:h4Sig}=htfSignalAt(htfInd,htfC.length-1);
          h4SigLocal=h4Sig;
        }else if(h4C.length>=50){
          const h4Ind=precompute(h4C);
          const{sig:h4Sig}=htfSignalAt(h4Ind,h4C.length-1);
          h4SigLocal=h4Sig;
        }
        setH4Bias(h4SigLocal);

        const m15Sig=m15C.length>=50?mtfSignalAt(m15Ind,m15C.length-1):"WAIT";
        const ltfSig=ltfC.length>=50?mtfSignalAt(ltfInd,ltfC.length-1):"WAIT";
        // Arquitectura de 3 capas: getLiveVerdict ahora recibe todo lo que
        // necesita para evaluar las 3 capas (Ancla, Gates, Score) por sí mismo.
        // Cap del SL hardcodeado en 0.75% (Regla 5: hardcodeo > UI dinámica).
        // tpTargetPct queda en 3 por compatibilidad con la firma, pero el motor
        // ya no lo usa (TP 100% estructural desde Estrategia 2, ver signals.ts L96).
        // Los sliders slPct/tpPct quedan SIN EFECTO sobre el motor — pendiente
        // eliminarlos del UI como tarea siguiente.
        const v=getLiveVerdict(
          htfInd,mtfInd,htfC.length-1,mtfC.length-1,priceRef.current,
          d1SigLocal,sessionLevels,0.75,3,
          m15Sig,ltfSig,h4SigLocal,session,hasNews
        );
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
          // Salida única de las 3 capas
          veredictoFinal:v.veredictoFinal,
          detenidoEn:v.detenidoEn,
          gates:v.gates,
          gatesPasan:v.gatesPasan,
          score:v.score,
          scoreUmbral:v.scoreUmbral,
          // Liquidez (CAMBIO 27/05/26)
          liquidez:v.liquidez,
          liquidezAdj:v.liquidezAdj,
          scoreAjustado:v.scoreAjustado,
        });

        // ── Shadow Trading: detector + tracker (silencioso) ─────────────────
        // No-await intencional (void): el shadow corre en background sin
        // bloquear el siguiente render. runShadowPipeline tiene su propio
        // try/catch interno, así que un error suyo nunca toca el catch del
        // load() ni dispara setSigError.
        void runShadowPipeline({
          htfInd,
          htfIdx:      htfC.length - 1,
          livePrice:   priceRef.current,
          session:     sessionLevels,
          sessionTag:  session,
          verdict:     v,
          m15Sig,
          ltfSig,
          d1Bias:      d1SigLocal,
          h4Bias:      h4SigLocal,
          atr:         atrVal,
          htfTf,
          seenKeysRef: shadowSeenKeysRef,
        });
      }catch(err){
        setSigError(err instanceof Error?err.message:"Error desconocido");
      }
    }
    load();
    // Recálculo cada 5 minutos (CAMBIO 28/05/26, antes 15 min).
    // Alineado con la vela más baja del sistema (5M) → cada cierre de vela 5M
    // se incorpora en ≤5 min en el peor caso. Consumo de rate limit:
    // 12 weight/ciclo × 12 ciclos/hora = 144 weight/hora = 2.4 weight/min,
    // que es 0.10% del límite de Binance Futures (2400 weight/min). Sin
    // riesgo de ban. El 15 min original venía del susto del 418 del backtest
    // (45 requests en burst paralelos), problema que NO aplica acá porque
    // el terminal hace polling secuencial cliente-side. Lo en tiempo real
    // (precio, semáforo, R:R live, snapshot de señal activa) NO depende
    // de este intervalo — sigue actualizándose tick a tick o cada 5s.
    const iv=setInterval(load,5*60*1000);

    // ── FIX VISIBILITYCHANGE (02/06/26) ──────────────────────────────────────
    // Chrome (y otros navegadores) congelan los setInterval de las pestañas
    // que llevan tiempo en background. Cuando el usuario vuelve a la pestaña
    // del terminal después de haber estado en otra app/pestaña, el interval
    // puede haber estado pausado varios minutos.
    //
    // Sin este listener, Steven tenía que cambiar de TF manualmente para
    // forzar un load() y ver señales actualizadas (caso documentado 01/06/26
    // 21:20 COL: señal SHORT que no apareció hasta que cambió 1H→4H→1H).
    //
    // Solución: cuando la pestaña vuelve a ser visible, disparar load()
    // inmediatamente para tener datos frescos sin tocar nada.
    const handleVisibility=()=>{
      if(document.visibilityState==="visible")load();
    };
    document.addEventListener("visibilitychange",handleVisibility);

    return()=>{
      clearInterval(iv);
      document.removeEventListener("visibilitychange",handleVisibility);
    };
  },[htfTf,ltfTf,session,hasNews,firstPriceReady]);  // slPct/tpPct sacados: el motor ya no los lee (cap SL hardcodeado en 0.75%, TP estructural). session/hasNews: gates de Capa 2. firstPriceReady (30/05/26): fix race condition Cmd+Shift+R.

  // Operaciones
  useEffect(()=>{
    if(!userId)return;
    authHeaders().then(h=>fetch("/api/operations",{headers:h}))
      .then(r=>r.json()).then(d=>{if(Array.isArray(d))setOps(d);}).catch(console.error);
  },[userId]);

  // Shadow Trading: hidratación inicial del set de keys (deduplicación)
  // Trae los últimos trades del usuario (cualquier status) y reconstruye las
  // keys con su created_at original. Evita re-insertar eventos ya capturados
  // si el usuario refresca el navegador dentro de la misma hora UTC.
  useEffect(()=>{
    if(!userId)return;
    let cancelled = false;
    (async () => {
      try {
        const headers = await authHeaders();
        const res = await fetch("/api/shadow-trades?limit=100", { headers });
        if (!res.ok) return;
        const data = await res.json() as Array<{
          case_type:  ShadowCaseType;
          direction:  ShadowDirection;
          created_at: string;
        }>;
        if (cancelled || !Array.isArray(data)) return;
        const set = new Set<string>();
        for (const t of data) {
          const ms = new Date(t.created_at).getTime();
          if (!Number.isFinite(ms)) continue;
          set.add(shadowDedupKey(t.case_type, t.direction, ms));
        }
        shadowSeenKeysRef.current = set;
      } catch (e) {
        // Silencioso — si la hidratación falla, peor caso: se inserta una
        // captura duplicada (pero no rompe nada). Mejor que bloquear el UI.
        // eslint-disable-next-line no-console
        console.warn("[Shadow] hidratación inicial falló:", e);
      }
    })();
    return () => { cancelled = true; };
  },[userId]);

  const handleSaved=useCallback((op:Operation)=>setOps(p=>[op,...p]),[]);

  const closed=ops.filter(o=>o.resultado!==null);
  const wins=closed.filter(o=>o.resultado==="TP").length;
  const wr=closed.length>0?Math.round((wins/closed.length)*100):0;
  const pnlTotal=closed.reduce((a,o)=>a+(o.pnl??0),0); // suma en dólares reales

  // Cambio #7 (v5): cuando htfTf=1h, el 4H se muestra como fila adicional
  // (filtro macro restrictivo). Cuando htfTf=4h, el 4H ya es la fila HTF.
  const mtfRows=[
    ...(htfTf==="1h"?[{key:"h4",tf:"4H",rol:"Macro filtro",sig:h4Bias} as const]:[]),
    {key:"htf",tf:htfTf.toUpperCase(),rol:"Tendencia",   sig:(signal?.htf??"WAIT") as MTFSig},
    {key:"mtf",tf:mtfTfLabel,         rol:"Confirmación",sig:(signal?.mtf??"WAIT") as MTFSig},
    {key:"m15",tf:"15M",              rol:"Refinamiento",sig:(signal?.m15??"WAIT") as MTFSig},
    {key:"ltf",tf:ltfTf.toUpperCase(),rol:"Entrada",     sig:(signal?.ltf??"WAIT") as MTFSig},
  ];

  // Indicador de penalización 4H — visible cuando el 4H está en contra del HTF actual
  const h4Penalty=signal&&signal.htf!=="WAIT"&&h4Bias!=="WAIT"&&signal.htf!==h4Bias;

  const structureColor=signal?.structure==="BULLISH"?T.up:signal?.structure==="BEARISH"?T.down:T.muted;
  const structureLabel=signal?.structure==="BULLISH"?"HH/HL ▲":signal?.structure==="BEARISH"?"LH/LL ▼":"NEUTRAL";
  const d1Color=d1Bias==="UP"?T.up:d1Bias==="DOWN"?T.down:T.muted;
  const d1Label=d1Bias==="UP"?"▲ ALCISTA":d1Bias==="DOWN"?"▼ BAJISTA":"- NEUTRAL";

  return(
    <>
      <style>{`
        @keyframes tp3blink{0%,100%{opacity:1}50%{opacity:0.5}}
        .tp3-root{display:grid;grid-template-columns:360px 1fr 360px;grid-template-rows:1fr;height:100%;overflow:hidden;}
        .tp3-sidebar{grid-column:1;grid-row:1;}
        .tp3-main{grid-column:2;grid-row:1;}
        .tp3-right{grid-column:3;grid-row:1;}
        @media(max-width:1100px){.tp3-root{grid-template-columns:1fr 300px;}.tp3-sidebar{display:none;}.tp3-main{grid-column:1;}.tp3-right{grid-column:2;}}
        @media(max-width:700px){
          /* Sub-item B.6 del handoff v13: en mobile la visibilidad de los 3 paneles depende
             del data-mobile-tab del root. Solo UNO se muestra a la vez. */
          .tp3-root{grid-template-columns:1fr;}
          .tp3-sidebar,.tp3-main,.tp3-right{display:none!important;}
          .tp3-root[data-mobile-tab="veredicto"] .tp3-main{display:flex!important;grid-column:1;grid-row:1;}
          .tp3-root[data-mobile-tab="analisis"]  .tp3-sidebar{display:flex!important;grid-column:1;grid-row:1;}
          .tp3-root[data-mobile-tab="registro"]  .tp3-right{display:flex!important;grid-column:1;grid-row:1;}
          /* Espacio inferior para que el BottomNav fijo no tape el contenido */
          .tp3-sidebar,.tp3-main,.tp3-right{
            padding-bottom:calc(60px + env(safe-area-inset-bottom))!important;
          }
        }
        /* Sub-item B.6: el BottomNav solo se muestra en mobile. */
        .tp3-mobile-bottom-nav{display:none;}
        @media(max-width:700px){.tp3-mobile-bottom-nav{display:block;}}
        /* LANDSCAPE iPhone: cuando el celular está horizontal (alto ≤500px),
           distribuir los 3 paneles equitativamente (1fr 1fr 1fr) en lugar de
           ocultar el sidebar izquierdo. Override del breakpoint max-width:1100px.
           Cubre iPhone landscape (~430px alto en PWA standalone).
           NO matchea iPad (≥820px alto) ni desktop normal. */
        @media(orientation:landscape) and (max-height:500px){
          .tp3-root{grid-template-columns:1fr 1fr 1fr!important;}
          .tp3-sidebar{display:flex!important;grid-column:1!important;grid-row:1!important;}
          .tp3-main{grid-column:2!important;grid-row:1!important;}
          .tp3-right{grid-column:3!important;grid-row:1!important;}
        }
      `}</style>

      <div className="tp3-root" data-mobile-tab={mobileTab} style={{fontFamily:SANS,color:T.text,background:T.bg}}>

        {/* ── LEFT SIDEBAR ── */}
        <div className="tp3-sidebar"
          style={{background:T.bg,borderRight:`1px solid ${T.border}`,overflowY:"auto",padding:"8px 8px",display:"flex",flexDirection:"column",height:"100%"}}>

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
                padding:"6px 0",borderBottom:`1px solid ${T.border}`,
                ...(key==="h4"&&h4Penalty?{background:`${T.down}10`}:{})}}>
                <div>
                  <span style={{fontFamily:MONO,fontSize:12,color:T.muted,fontWeight:700,minWidth:32}}>{tf}</span>
                  <span style={{fontFamily:SANS,fontSize:10,color:T.dim,marginLeft:6}}>{rol}</span>
                  {key==="h4"&&h4Penalty&&(
                    <span style={{fontFamily:MONO,fontSize:8,color:T.down,marginLeft:6,fontWeight:700}}>−2</span>
                  )}
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

            {/* SL / TP — sliders removidos el 28/05/26.
                El motor usa cap SL hardcodeado en 0.75% y TP 100% estructural.
                Los valores reales aparecen en MT5Block cuando hay señal. */}


            {/* Score + Copiar estado */}
            <div style={{marginTop:6,display:"flex",gap:4}}>
              {(()=>{
                // Arquitectura de 3 capas: umbral leído del engine.
                const sigThresh=signal?signal.scoreUmbral:6;
                const ok=signalScore>=sigThresh;
                return(
                  <div style={{flex:1,padding:"5px 8px",borderRadius:5,textAlign:"center",fontFamily:MONO,fontSize:12,fontWeight:700,
                    background:ok?T.upBg:T.s2,color:ok?T.up:T.muted,
                    border:`1px solid ${ok?T.upBorder:T.border}`}}
                    title={`Umbral requerido: ${sigThresh}/10`}>
                    Score {signalScore}/10
                  </div>
                );
              })()}
              <CopyTerminalBtn
                signal={signal} price={price} score={signalScore}
                session={session} d1Bias={d1Bias} htfTf={htfTf} ltfTf={ltfTf}
                hasNews={hasNews}
                wr={wr} totalOps={ops.length} pnlTotal={pnlTotal} connected={connected}
                sigError={sigError}
              />
            </div>
          </Card>

          {/* Sub-item B.7/B.8 del handoff v13: en mobile el Checklist se renderiza
              acá (dentro de .tp3-sidebar, junto con Fuentes + MTF Matrix) para
              que forme parte del tab Análisis. En desktop el Checklist sigue
              renderizando en .tp3-right como siempre. Componente puro sin
              estado interno: renderizarlo en posición distinta según viewport
              es seguro. */}
          {isMobile&&(
            <Checklist
              session={session} signal={signal} price={price}
              signalScore={signalScore} hasNews={hasNews}
              onToggleNews={()=>setHasNews(n=>!n)}
            />
          )}

        </div>

        {/* ── MAIN FEED ── */}
        <div className="tp3-main"
          style={{background:T.bg,overflowY:"auto",padding:"8px 8px",display:"flex",flexDirection:"column",height:"100%"}}>
          <SessionBanner session={session}/>
          <VerdictCard signal={signal} price={price} score={signalScore} htfTf={htfTf} ltfTf={ltfTf} session={session}/>
          <CapitalRiskControl onChange={()=>setCapRiskKey(k=>k+1)}/>
          <MT5Block signal={signal} score={signalScore} price={price} refreshKey={capRiskKey} htfTf={htfTf} d1Bias={d1Bias} h4Bias={h4Bias}/>
        </div>

        {/* ── RIGHT PANEL ── */}
        <div className="tp3-right"
          style={{background:T.bg,borderLeft:`1px solid ${T.border}`,
            overflowY:"auto",padding:"8px 8px",display:"flex",flexDirection:"column",height:"100%"}}>
          {/* Sub-item B.7 del handoff v13: en mobile, las Notif y el Checklist
              NO se renderizan acá. El Checklist vive en .tp3-sidebar (tab Análisis)
              cuando isMobile es true. Las Notif se moverán al topbar en sesiones
              futuras (B.9-B.11). Por ahora el tab Registro de mobile solo muestra
              el formulario Nueva Op. En desktop/tablet todo igual a hoy. */}
          {!isMobile&&(
            <>
              <Checklist
                session={session} signal={signal} price={price}
                signalScore={signalScore} hasNews={hasNews}
                onToggleNews={()=>setHasNews(n=>!n)}
              />
            </>
          )}
          {/* Cambio 07/06/26: quitado flex:1 del wrapper y fillHeight=false en
              OperationForm para que la card Nueva Op tenga altura natural en lugar
              de estirarse a llenar todo el viewport. Resuelve la asimetría visual
              donde el bloque 3 llegaba hasta el bottom mientras 1 y 2 no. Ahora los
              3 bloques terminan en su altura natural y scrollean (overflowY:auto)
              si exceden. Sin cambios para mobile (fillHeight ya era false ahí). */}
          <div style={{display:"flex",flexDirection:"column",minHeight:0}}>
            <OperationForm
              userId={userId} onSaved={handleSaved}
              fillHeight={false}
            />
          </div>
        </div>

      </div>

      {/* Sub-item B.6 del handoff v13: barra de navegación inferior fija que
          permite alternar entre Veredicto/Análisis/Registro en mobile. Solo
          visible en <700px (CSS lo controla con la clase .tp3-mobile-bottom-nav). */}
      <MobileBottomNav active={mobileTab} onChange={handleMobileTab}/>
    </>
  );
}
