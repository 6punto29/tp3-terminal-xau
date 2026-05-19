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
import EditOperationModal from "./EditOperationModal";

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

// Cambio #7 (v5): calcSignalScore ahora recibe h4Bias.
// Si el 4H va en contra del trade: -2 al score (filtro restrictivo).
// Si el 4H es WAIT o a favor: sin cambios.
// Asimétrico a favor del trader: bloquea trades contra estructura macro
// sin frenar setups válidos.
// Cambio #7 (v5): umbral dinámico de score.
// Si HTF + MTF están alineados (corazón del setup intacto): umbral 6.
// Si NO están alineados (componente core fallando): umbral 7 — más exigente.
// Razón: el score puede llegar a 6 sumando puntos blandos (EMA200, RSI, FVG)
// aunque el filtro principal falle. Con esto endurecemos la entrada cuando
// la estructura real no está validada.
function getScoreThreshold(htf:MTFSig,mtf:MTFSig):number{
  return (htf!=="WAIT"&&htf===mtf) ? 6 : 7;
}

function calcSignalScore(
  htf:MTFSig,mtf:MTFSig,m15:MTFSig,ltf:MTFSig,
  rsi:number|null,ema200:number|null,price:number,
  session:Session,structure:PriceStructure,fvgActive:boolean,
  h4Bias:MTFSig="WAIT"
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
  // Cambio #7 (v5): 4H restrictivo — si el 4H va en contra del trade, restar 2.
  // Caso típico que filtra: precio en zona de resistencia institucional 4H bajista
  // y el sistema da señal LONG por estructura 1H — el trade tiene baja probabilidad.
  if(htf==="UP"&&h4Bias==="DOWN")s-=2;
  if(htf==="DOWN"&&h4Bias==="UP")s-=2;
  return Math.max(0,Math.min(s,10));
}

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
const SESSION_LEN=300; // 5h en minutos

function getSession():Session{
  const now=new Date();
  const day=now.getUTCDay();
  const u=now.getUTCHours()*60+now.getUTCMinutes();
  if(day===6)return"WEEKEND";
  if(day===0&&u<1320)return"WEEKEND";
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
  // Fin de semana → próximo lunes LDN
  if(day===6){const minsToMon=(DAY-u)+DAY+ldn;return{label:"LDN Lunes",mins:minsToMon};}
  if(day===0&&u<1320){const minsToMon=(DAY-u)+ldn;return{label:"LDN Lunes",mins:minsToMon};}
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
// Semáforo adaptativo de validez de entrada.
// Evalúa 3 factores en tiempo real:
//   1. Tiempo transcurrido desde apertura de vela HTF (% sobre duración total)
//   2. R:R actual recalculado con el precio live (no el del setup original)
//   3. Alineación multi-timeframe: D1 + HTF + MTF a favor del trade
//
// Lógica:
//   · R:R < 1.0  → 🔴 NO ENTRAR (no operable)
//   · 0-15% tiempo + R:R OK     → 🟢 ENTRADA
//   · 15-35% tiempo + R:R OK    → 🟢 ENTRADA
//   · 35%+ tiempo + R:R OK + override tendencia → 🟢 ENTRADA
//   · 35%+ tiempo + R:R OK sin override → 🟡 TARDÍA
//   · R:R 1.0-1.5 (degradado) → 🟡 TARDÍA
//
// El override "tendencia ultra fuerte" requiere D1+HTF+MTF todos en la
// misma dirección del trade. (4H no se evalúa aparte hasta que el sistema
// calcule esa signal — pendiente cambio #7 de esta ronda).
function EntryValidityIndicator({
  signal, price, htfTf, d1Bias, h4Bias
}:{
  signal:LiveSignal;
  price:number;
  htfTf:"1h"|"4h";
  d1Bias:MTFSig;
  h4Bias:MTFSig;
}){
  const[,setTick]=useState(0);
  useEffect(()=>{
    const id=setInterval(()=>setTick(t=>t+1),5000);
    return()=>clearInterval(id);
  },[]);

  const isLong = signal.verdict==="ENTRAR LONG";
  const tradeDir:MTFSig = isLong?"UP":"DOWN";
  const levels = signal.levels;

  // ── R:R LIVE: calcular con el precio actual, no con el entry del setup ────
  // Si el precio se movió a favor, el R:R se degrada (TP más cerca, SL más lejos).
  // Si se movió en contra, el R:R puede mejorar pero también achicar margen.
  let rrLive=0;
  let slDist=0;
  let tpDist=0;
  if(levels&&price>0){
    if(isLong){
      slDist = price - levels.slPrice;
      tpDist = levels.tpPrice - price;
    }else{
      slDist = levels.slPrice - price;
      tpDist = price - levels.tpPrice;
    }
    rrLive = slDist>0 ? tpDist/slDist : 0;
  }

  // ── TIEMPO TRANSCURRIDO (%) en la vela HTF actual ─────────────────────────
  const now = Date.now();
  const d = new Date(now);
  let elapsedMs=0,totalMs=0;
  if(htfTf==="1h"){
    // Vela 1H: arranca a los :00 de la hora UTC actual
    const opened = new Date(d);
    opened.setUTCMinutes(0,0,0);
    elapsedMs = now - opened.getTime();
    totalMs = 60*60*1000;
  }else{
    // Vela 4H: arranca en el bloque de 4h actual (0,4,8,12,16,20 UTC)
    const opened = new Date(d);
    opened.setUTCMinutes(0,0,0);
    const currH = d.getUTCHours();
    opened.setUTCHours(Math.floor(currH/4)*4);
    elapsedMs = now - opened.getTime();
    totalMs = 4*60*60*1000;
  }
  const elapsedPct = totalMs>0 ? elapsedMs/totalMs : 0;

  // ── OVERRIDE TENDENCIA ULTRA FUERTE ────────────────────────────────────────
  // D1 + 4H + HTF + MTF todos a favor del trade. Si los 4 coinciden, ignora
  // tiempo y dispara 🟢 mientras R:R sea válido.
  // (Si htfTf==="4h", el 4H ya está implícito en signal.htf, pero igual
  // chequeamos h4Bias para consistencia.)
  const trendOverride =
    d1Bias===tradeDir &&
    h4Bias===tradeDir &&
    signal.htf===tradeDir &&
    signal.mtf===tradeDir;

  // ── DECISIÓN DEL SEMÁFORO ─────────────────────────────────────────────────
  let state:"green"|"yellow"|"red"="green";
  let label="ENTRADA VÁLIDA";
  let reason="Setup fresco";

  if(rrLive<1.0||!levels||price<=0){
    state="red";label="NO ENTRAR";
    reason=`R:R ${rrLive.toFixed(1)} · setup degradado`;
  }else if(rrLive<1.5){
    state="yellow";label="TARDÍA";
    reason=`R:R ${rrLive.toFixed(1)} · ratio degradado`;
  }else if(elapsedPct<0.15){
    state="green";label="ENTRADA VÁLIDA";
    reason=`R:R ${rrLive.toFixed(1)} · setup fresco`;
  }else if(elapsedPct<0.35){
    state="green";label="ENTRADA VÁLIDA";
    reason=`R:R ${rrLive.toFixed(1)} · vela avanzada ${Math.round(elapsedPct*100)}%`;
  }else if(trendOverride){
    state="green";label="ENTRADA VÁLIDA";
    reason=`R:R ${rrLive.toFixed(1)} · tendencia ultra fuerte (override)`;
  }else{
    state="yellow";label="TARDÍA";
    reason=`R:R ${rrLive.toFixed(1)} · vela avanzada ${Math.round(elapsedPct*100)}%`;
  }

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
  slPct:number;
  tpPct:number;
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

function MT5Block({signal,score,price,slPct,tpPct,refreshKey,htfTf,d1Bias,h4Bias}:MT5BlockProps){
  void refreshKey;  // solo lo usamos para invalidar el render; lectura ya se hace por localStorage
  // Ref para el snapshot (debe declararse antes de cualquier early return — regla de hooks).
  const snapRef = useRef<MT5Snapshot|null>(null);

  const isValidSignal = !!signal && score>=getScoreThreshold(signal.htf,signal.mtf) && signal.verdict!=="ESPERAR";

  // Si la señal no es válida (ESPERAR o score insuficiente) → liberar snapshot y no mostrar nada.
  // La próxima vez que la señal entre en ENTRAR, capturará un snapshot fresco.
  if(!isValidSignal){
    snapRef.current=null;
    return null;
  }

  // ── Cálculo en vivo (solo se usa para CAPTURAR el snapshot la primera vez,
  //    o si la dirección de la señal cambió sin pasar por ESPERAR) ───────────
  const levels=signal!.levels;
  const isLongLive=signal!.verdict==="ENTRAR LONG";
  const atrValLive=signal!.atr;
  const entryLive = price>0?price.toFixed(2):"--";
  const slLive    = levels?levels.slPrice.toFixed(2):price>0?(isLongLive?price*(1-slPct/100):price*(1+slPct/100)).toFixed(2):"--";
  const tpLive    = levels?levels.tpPrice.toFixed(2):price>0?(isLongLive?price*(1+tpPct/100):price*(1-tpPct/100)).toFixed(2):"--";
  const slPctStrLive = levels?`${levels.slPct.toFixed(2)}%`:`${slPct.toFixed(2)}%`;
  const tpPctStrLive = levels?`${levels.tpPct.toFixed(2)}%`:`${tpPct.toFixed(2)}%`;
  const capitalLive = (typeof window!=="undefined"&&parseFloat(localStorage.getItem("tp3_capital")||""))||10000;
  const riskPctLive = (typeof window!=="undefined"&&parseFloat(localStorage.getItem("tp3_risk")||""))||1;
  const slPointsLive = Math.abs(parseFloat(entryLive)-parseFloat(slLive));
  const lotajeLive = slPointsLive>0?calcLotSize(capitalLive,riskPctLive,slPointsLive):0;
  const rrLive = levels&&levels.slPct>0?(levels.tpPct/levels.slPct):0;

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

      {/* Semáforo adaptativo de validez de entrada (usa price live, no snapshot,
          porque su trabajo es indicar si SIGUE siendo válido entrar AHORA) */}
      <EntryValidityIndicator signal={signal!} price={price} htfTf={htfTf} d1Bias={d1Bias} h4Bias={h4Bias}/>

      {/* Los 4 valores para copiar — desde snapshot, no live */}
      {[
        {lbl:"ENTRADA",val:snap.entry,color:T.gold,hint:"market"},
        {lbl:"SL",     val:snap.sl,   color:T.down,hint:snap.slPctStr},
        {lbl:"TP",     val:snap.tp,   color:T.up,  hint:snap.tpSource==="session"?"PDH/PDL 🎯":snap.tpSource==="structure"?"estructura":snap.tpPctStr},
        {lbl:"LOTAJE", val:snap.lotaje.toFixed(2),color:T.accent,hint:`$${snap.capital.toLocaleString()} × ${snap.riskPct}%`},
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

      {/* Estructura que generó los niveles — desde snapshot */}
      {snap.structure&&(
        <div style={{marginTop:4,fontFamily:MONO,fontSize:8,color:T.muted,textAlign:"center"}}>
          Estructura: {snap.structure==="BULLISH"?"HH/HL ▲":snap.structure==="BEARISH"?"LH/LL ▼":"NEUTRAL"}
        </div>
      )}

      {/* R:R EFECTIVO EN VIVO — protege contra entradas con R:R degradado.
          Calcula el R:R si entrás AHORA al precio live (no al snapshot). */}
      {(()=>{
        const entryNow = price;
        if(!entryNow || entryNow<=0) return null;
        const snapSL = parseFloat(snap.sl);
        const snapTP = parseFloat(snap.tp);
        if(isNaN(snapSL)||isNaN(snapTP)) return null;
        // Distancias en $ desde el precio actual hasta SL y TP del snapshot
        const slDistNow = Math.abs(entryNow - snapSL);
        const tpDistNow = Math.abs(snapTP - entryNow);
        // Validar dirección: si entrás ahora pero el precio ya cruzó TP o SL → inválido
        const tpReached = snap.isLong ? entryNow>=snapTP : entryNow<=snapTP;
        const slReached = snap.isLong ? entryNow<=snapSL : entryNow>=snapSL;
        if(tpReached||slReached){
          return(
            <div style={{marginTop:6,padding:"6px 8px",borderRadius:6,
              background:`${T.down}12`,border:`1px solid ${T.down}40`,
              fontFamily:SANS,fontSize:10,fontWeight:700,color:T.down,textAlign:"center"}}>
              🔴 R:R inválido · precio ya superó SL/TP del snapshot · PASAR
            </div>
          );
        }
        if(slDistNow<=0) return null;
        const rrEffective = tpDistNow/slDistNow;
        // Umbrales: ≥3.5 verde, 2.5-3.5 amarillo, <2.5 rojo
        const c = rrEffective>=3.5 ? T.up : rrEffective>=2.5 ? T.wait : T.down;
        const lbl = rrEffective>=3.5 ? "ENTRADA ÓPTIMA"
                  : rrEffective>=2.5 ? "ENTRADA MARGINAL"
                  : "PASAR · R:R DEGRADADO";
        return(
          <div style={{marginTop:6,padding:"6px 8px",borderRadius:6,
            background:`${c}12`,border:`1px solid ${c}40`}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:3}}>
              <span style={{fontFamily:SANS,fontSize:8,fontWeight:700,color:T.muted,
                letterSpacing:"0.06em",textTransform:"uppercase"}}>R:R Efectivo si entrás AHORA</span>
              <span style={{fontFamily:SANS,fontSize:9,fontWeight:700,color:c}}>{lbl}</span>
            </div>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <span style={{fontFamily:MONO,fontSize:9,color:T.dim}}>
                Snapshot: ${snap.entry} (R:R {snap.rr.toFixed(1)}:1)
              </span>
              <span style={{fontFamily:MONO,fontSize:14,fontWeight:700,color:c}}>
                {rrEffective.toFixed(2)}:1
              </span>
            </div>
          </div>
        );
      })()}
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
  // Cambio #7 (v5): umbral dinámico — 6 si HTF+MTF alineados, 7 si no.
  const threshold=signal?getScoreThreshold(signal.htf,signal.mtf):6;
  const checks=[
    session==="LDN"||session==="NY",
    ema200!=null&&price>0&&Math.abs(price-ema200)/ema200>0.002&&
      ((signal?.htf==="UP"&&price>ema200)||(signal?.htf==="DOWN"&&price<ema200)),
    signal!=null&&signal.htf!=="WAIT"&&signal.htf===signal.mtf,
    rsi!=null&&rsi>=30&&rsi<=70,
    !hasNews,
    signalScore>=threshold,
  ];
  const passed=checks.filter(Boolean).length,allOk=passed===6;
  const items=["Sesion LDN/NY activa","EMA200 sesgo claro","HTF + MTF alineados",
    `RSI ok${rsi!=null?` (${rsi.toFixed(0)})`:""}`,
    "Sin noticia 30M",
    `Score >= ${threshold} (${signalScore})`];
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
    // Cambio #7 (v5): umbral dinámico
    const threshold=s?getScoreThreshold(s.htf,s.mtf):6;
    const verdict=p.score>=threshold?s?.verdict:"ESPERAR";
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
      ...(s?.levels&&p.score>=threshold?[
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
      `  Score ≥ ${threshold}:         ${p.score>=threshold?"✓":"✗"} (${p.score}/10)`,
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
  const threshold=getScoreThreshold(signal.htf,signal.mtf);
  const verdict=score>=threshold?signal.verdict:"ESPERAR";
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
            <span style={{fontFamily:MONO,fontSize:10,color:score>=threshold?T.up:T.wait}}>Score {score}/10</span>
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

// ── HistoryList ───────────────────────────────────────────────────────────────
interface HistoryListProps{
  ops:Operation[];userId:string;
  onUpdate:(id:string,resultado:"TP"|"SL"|"MANUAL")=>void;
  onEdit:(op:Operation)=>void;
  onDelete:(id:string)=>void;
  limit?:number;  // Si está presente, solo muestra las últimas N ops + contador del resto
}
function HistoryList({ops,onUpdate,onEdit,onDelete,limit}:HistoryListProps){
  // Timer Hold 6 — re-render cada minuto para countdown
  const[now,setNow]=useState(()=>Date.now());
  useEffect(()=>{
    const t=setInterval(()=>setNow(Date.now()),60_000);
    return()=>clearInterval(t);
  },[]);
  // Calcula info del timer Hold para una op abierta (resultado===null)
  // Hold 6 = 6 horas desde hora de apertura (hora_apertura_mt5 si existe, sino created_at)
  const getHoldTimer=(op:Operation)=>{
    if(op.resultado!==null)return null;
    const base=op.hora_apertura_mt5||op.created_at;
    if(!base)return null;
    const baseMs=new Date(base).getTime();
    if(isNaN(baseMs))return null;
    const limitMs=baseMs+6*60*60*1000;        // +6h
    const remainMs=limitMs-now;
    const remainMin=Math.floor(remainMs/60_000);
    if(remainMs<=0){
      // Vencido
      const overMin=Math.abs(remainMin);
      const overH=Math.floor(overMin/60);
      const overM=overMin%60;
      const overText=overH>0?`${overH}h ${overM}m`:`${overM}m`;
      return{text:`🚨 VENCIDO hace ${overText} — cerrar YA`,color:T.down,bg:T.dnBg,blink:true};
    }
    const h=Math.floor(remainMin/60);
    const m=remainMin%60;
    const timeText=h>0?`${h}h ${m}m`:`${m}m`;
    if(remainMin<=5)return{text:`🔴 Hold: ${timeText}`,color:T.down,bg:T.dnBg,blink:false};
    if(remainMin<=30)return{text:`⚠ Hold: ${timeText}`,color:T.wait,bg:T.s2,blink:false};
    return{text:`⏱ Hold: ${timeText}`,color:T.muted,bg:T.s2,blink:false};
  };
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
        const holdTimer=getHoldTimer(op);
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
              borderRadius:(op.resultado!=null||holdTimer)?"6px 6px 0 0":"6px",
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
            {/* Timer Hold — solo si op abierta (sin resultado) */}
            {holdTimer&&(
              <div style={{display:"flex",alignItems:"center",gap:6,padding:"4px 10px",
                borderRadius:"0 0 6px 6px",background:holdTimer.bg,
                borderLeft:`2px solid ${holdTimer.color}`,
                fontFamily:MONO,fontSize:9,fontWeight:700,color:holdTimer.color,
                animation:holdTimer.blink?"tp3blink 1s ease-in-out infinite":"none"}}>
                {holdTimer.text}
              </div>
            )}
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
  // Cambio #7 (v5): 4H como filtro restrictivo. Si va en contra del trade, resta 2 al score.
  // El override de "tendencia ultra fuerte" en el semáforo también lo lee.
  const[h4Bias,   setH4Bias]  = useState<MTFSig>("WAIT");

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
    ?calcSignalScore(signal.htf,signal.mtf,signal.m15,signal.ltf,signal.rsi,signal.ema200,price,session,signal.structure,signal.fvgActive,h4Bias)
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
        let sessionLevels:SessionLevels={pdh:null,pdl:null};
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

  const handleEditSave=useCallback(async(updated:{id:string;direccion:Direction;precio_entrada:number;sl:number;tp:number;lotaje:number|null;resultado:OpsResult;pnl:number|null;hora_apertura_mt5:string|null})=>{
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
          .tp3-root{grid-template-columns:1fr;}
          .tp3-sidebar{display:none!important;}
          .tp3-right{display:none!important;}
          .tp3-main{grid-column:1;grid-row:1;}
        }
      `}</style>

      <div className="tp3-root" style={{fontFamily:SANS,color:T.text,background:T.bg}}>
        {editingOp&&<EditOperationModal op={editingOp} onClose={()=>setEditingOp(null)} onSave={handleEditSave}/>}

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
              {(()=>{
                const sigThresh=signal?getScoreThreshold(signal.htf,signal.mtf):6;
                const ok=signalScore>=sigThresh;
                return(
                  <div style={{flex:1,padding:"5px 8px",borderRadius:5,textAlign:"center",fontFamily:MONO,fontSize:12,fontWeight:700,
                    background:ok?T.upBg:T.s2,color:ok?T.up:T.muted,
                    border:`1px solid ${ok?T.upBorder:T.border}`}}
                    title={`Umbral requerido: ${sigThresh}/10 ${sigThresh===7?"(HTF+MTF no alineados)":"(HTF+MTF alineados)"}`}>
                    Score {signalScore}/10
                  </div>
                );
              })()}
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
          <MT5Block signal={signal} score={signalScore} price={price} slPct={slPct} tpPct={tpPct} refreshKey={capRiskKey} htfTf={htfTf} d1Bias={d1Bias} h4Bias={h4Bias}/>
          <Card>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:7}}>
              <SecTitle>Historial XAU/USD</SecTitle>
              <span style={{fontFamily:MONO,fontSize:9,color:T.muted}}>{ops.length} ops</span>
            </div>
            <HistoryList ops={ops} userId={userId} onUpdate={handleUpdate} onEdit={setEditingOp} onDelete={handleDelete} limit={3}/>
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
