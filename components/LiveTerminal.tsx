"use client";
// components/LiveTerminal.tsx — v2.2
// · Dark / Light toggle (CSS variables, persiste en localStorage)
// · Panel derecho compacto sin scroll
// · Señales reales: precompute + getLiveVerdict + mtfSignalAt
// · Score 1–10 calculado desde indicadores

import { useState, useEffect, useCallback } from "react";
import { useBinanceWS }    from "@/lib/ws/binance-ws";
import { calcOpLevels, calcLotSize } from "@/lib/engine/simulator";
import { precompute }      from "@/lib/engine/indicators";
import { getLiveVerdict, mtfSignalAt } from "@/lib/engine/signals";
import type { Candle } from "@/lib/engine/types";

// T usa referencias a CSS variables — los valores reales están en CSS_VARS
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

const CSS_VARS = `
  html[data-theme="dark"] {
    --tp3-bg:#0B0D11;--tp3-s1:#131620;--tp3-s2:#1A1E2E;--tp3-s3:#232840;--tp3-s4:#2A3050;
    --tp3-border:rgba(255,255,255,0.06);--tp3-border2:rgba(255,255,255,0.12);
    --tp3-text:#E2E8F4;--tp3-muted:#5A6478;--tp3-dim:#3A4260;
    --tp3-up:#00C896;--tp3-down:#FF3B5C;--tp3-wait:#FFB340;
    --tp3-accent:#3D8EFF;--tp3-gold:#D4AF37;
    --tp3-upBg:rgba(0,200,150,0.08);--tp3-dnBg:rgba(255,59,92,0.08);
    --tp3-upBorder:rgba(0,200,150,0.20);--tp3-dnBorder:rgba(255,59,92,0.18);
    --tp3-warnBg:rgba(255,179,64,0.08);--tp3-warnBorder:rgba(255,179,64,0.20);
  }
  html[data-theme="light"] {
    --tp3-bg:#F0F2F6;--tp3-s1:#FFFFFF;--tp3-s2:#F5F7FA;--tp3-s3:#EBEEF4;--tp3-s4:#DDE1EC;
    --tp3-border:rgba(0,0,0,0.07);--tp3-border2:rgba(0,0,0,0.14);
    --tp3-text:#111827;--tp3-muted:#6B7280;--tp3-dim:#D1D5DB;
    --tp3-up:#059669;--tp3-down:#DC2626;--tp3-wait:#D97706;
    --tp3-accent:#2563EB;--tp3-gold:#B45309;
    --tp3-upBg:rgba(5,150,105,0.08);--tp3-dnBg:rgba(220,38,38,0.08);
    --tp3-upBorder:rgba(5,150,105,0.25);--tp3-dnBorder:rgba(220,38,38,0.22);
    --tp3-warnBg:rgba(217,119,6,0.08);--tp3-warnBorder:rgba(217,119,6,0.25);
  }
  html,body{margin:0;padding:0;height:100%;overflow:hidden;background:var(--tp3-bg);}
  .tp3-theme-btn{background:transparent;border:1px solid var(--tp3-border2);border-radius:6px;
    padding:4px 10px;cursor:pointer;font-size:11px;font-weight:600;color:var(--tp3-muted);transition:all .15s;}
  .tp3-theme-btn:hover{color:var(--tp3-text);border-color:var(--tp3-muted);}
`;

const MONO = "'JetBrains Mono','Fira Code',monospace";
const SANS = "'Inter',-apple-system,sans-serif";

type Direction = "LONG"|"SHORT";
type OpsResult = "TP"|"SL"|"MANUAL"|null;
type Session   = "LDN"|"NY"|"CLOSED";
type MTFSig    = "UP"|"DOWN"|"WAIT";
type Verdict   = "ENTRAR LONG"|"ENTRAR SHORT"|"ESPERAR";
type MobileTab = "estado"|"senal"|"operar";
type Strength  = "FUERTE"|"MODERADO"|"DEBIL";
type Theme     = "dark"|"light";

interface Operation {
  id:string;fecha:string;direccion:Direction;
  precio_entrada:number;sl:number;tp:number;
  resultado:OpsResult;pnl:number|null;
}
interface LiveSignal {
  htf:MTFSig;mtf:MTFSig;m15:MTFSig;ltf:MTFSig;
  verdict:Verdict;strength:Strength;
  ema200:number|null;rsi:number|null;
}

const BINANCE_FUTURES = "https://fapi.binance.com/fapi/v1/klines";
async function fetchLiveCandles(tf:string,limit=250):Promise<Candle[]>{
  const r=await fetch(`${BINANCE_FUTURES}?symbol=XAUUSDT&interval=${tf}&limit=${limit}`);
  if(!r.ok)throw new Error(`Binance ${r.status} (${tf})`);
  const d=await r.json() as number[][];
  if(!Array.isArray(d)||!d.length)return[];
  return d.slice(0,-1).map(k=>({t:+k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]}));
}

function calcSignalScore(htf:MTFSig,mtf:MTFSig,m15:MTFSig,ltf:MTFSig,rsi:number|null,ema200:number|null,price:number,session:Session):number{
  let s=0;
  if(htf!=="WAIT")s+=2;                          // HTF tiene sesgo claro
  if(htf!=="WAIT"&&mtf===htf)s+=2;               // 1H confirma 4H
  if(htf!=="WAIT"&&m15===htf)s+=1;               // 15M refina dirección
  if(htf!=="WAIT"&&ltf===htf)s+=1;               // 5M entrada alineada
  if(ema200!=null&&price>0){if((htf==="UP"&&price>ema200)||(htf==="DOWN"&&price<ema200))s+=2;}
  if(rsi!=null){if((htf==="UP"&&rsi<70)||(htf==="DOWN"&&rsi>30))s+=1;}
  if(session!=="CLOSED")s+=1;
  return Math.min(s,10);
}

function getSession():Session{
  const u=new Date().getUTCHours()*60+new Date().getUTCMinutes();
  if(u>=480&&u<600)return"LDN";if(u>=870&&u<990)return"NY";return"CLOSED";
}
function getColTime():string{
  const c=new Date(Date.now()-5*3600000);
  return`${c.getUTCHours().toString().padStart(2,"0")}:${c.getUTCMinutes().toString().padStart(2,"0")} COL`;
}

const Card=({children,style}:{children:React.ReactNode;style?:React.CSSProperties})=>(
  <div style={{background:T.s1,borderRadius:8,border:`1px solid ${T.border}`,padding:"10px 12px",...style}}>{children}</div>
);
const SecTitle=({children}:{children:React.ReactNode})=>(
  <div style={{fontFamily:SANS,fontSize:9,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:T.muted,marginBottom:6}}>{children}</div>
);
const Badge=({children,color}:{children:React.ReactNode;color:string})=>(
  <span style={{fontFamily:MONO,fontSize:9,fontWeight:700,padding:"2px 7px",borderRadius:20,background:`${color}18`,color,border:`1px solid ${color}30`}}>{children}</span>
);
const MTFSigBadge=({sig}:{sig:MTFSig})=>{
  const m:Record<MTFSig,{label:string;color:string}>={
    UP:{label:"▲ UP",color:T.up},DOWN:{label:"▼ DOWN",color:T.down},WAIT:{label:"- WAIT",color:T.muted}};
  const{label,color}=m[sig];return<Badge color={color}>{label}</Badge>;
};

// CHECKLIST
interface ChecklistProps{session:Session;signal:LiveSignal|null;price:number;signalScore:number;hasNews:boolean;}
function Checklist({session,signal,price,signalScore,hasNews}:ChecklistProps){
  const ema200=signal?.ema200??null,rsi=signal?.rsi??null;
  const checks=[
    session!=="CLOSED",
    ema200!=null&&price>0&&Math.abs(price-ema200)/ema200>0.002,
    signal!=null&&signal.htf!=="WAIT"&&signal.htf===signal.mtf,
    rsi!=null&&rsi>=30&&rsi<=70,
    !hasNews,
    signalScore>=6,
  ];
  const passed=checks.filter(Boolean).length,allOk=passed===6;
  const items=["Sesion LDN/NY activa","EMA200 sesgo claro","HTF + MTF alineados",
    `RSI ok${rsi!=null?` (${rsi.toFixed(0)})`:""}`, "Sin noticia 30M",`Score >= 6 (${signalScore})`];
  return(
    <Card style={{marginBottom:4,padding:"7px 10px"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:5}}>
        <SecTitle>Checklist XAU/USD</SecTitle>
        <span style={{fontFamily:MONO,fontSize:9,color:allOk?T.up:passed>=4?T.wait:T.muted}}>{passed}/6</span>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:2}}>
        {items.map((lbl,i)=>(
          <div key={i} style={{display:"flex",alignItems:"center",gap:5,padding:"3px 7px",borderRadius:4,fontSize:9,
            background:checks[i]?T.upBg:T.dnBg,color:checks[i]?T.up:T.down,
            border:`1px solid ${checks[i]?T.upBorder:T.dnBorder}`}}>
            <span style={{fontSize:10,width:12,textAlign:"center",flexShrink:0}}>{checks[i]?"✓":"✗"}</span>
            {lbl}
          </div>
        ))}
      </div>
      <div style={{marginTop:5,padding:"5px",borderRadius:5,textAlign:"center",fontSize:9,fontFamily:MONO,fontWeight:700,
        background:allOk?T.upBg:T.dnBg,color:allOk?T.up:T.down,border:`1px solid ${allOk?T.upBorder:T.dnBorder}`}}>
        {allOk?`OK - ${signal?.htf==="UP"?"BUSCAR LONG":"BUSCAR SHORT"}`:`${passed}/6 condiciones - ESPERAR`}
      </div>
    </Card>
  );
}

// OPERATION FORM
interface OpFormProps{livePrice:number;userId:string;onSaved:(op:Operation)=>void;fillHeight?:boolean;}
function OperationForm({livePrice,userId,onSaved,fillHeight}:OpFormProps){
  const[dir,setDir]=useState<Direction>("LONG");
  const[entry,setEntry]=useState("");const[sl,setSL]=useState("");const[tp,setTP]=useState("");
  const[capital,setCap]=useState("");const[riskPct,setRisk]=useState("1");
  const[saving,setSaving]=useState(false);
  useEffect(()=>{
    const e=parseFloat(entry);if(!e||e<=0){setSL("");setTP("");return;}
    const{sl:slv,tp:tpv}=calcOpLevels(e,dir,0.015,0.04);setSL(slv.toFixed(2));setTP(tpv.toFixed(2));
  },[entry,dir]);
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
        <button onClick={fillLive} style={{fontFamily:SANS,fontSize:9,fontWeight:700,
          background:T.s3,border:`1px solid ${T.border2}`,borderRadius:5,padding:"2px 7px",color:T.gold,cursor:"pointer"}}>
          ${livePrice>0?livePrice.toFixed(2):"--"} Usar
        </button>
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
        <div><label style={{...lbl,color:T.down}}>SL (1.5%)</label>
          <input type="number" value={sl} placeholder="SL" onChange={e=>setSL(e.target.value)} style={inp}/></div>
        <div><label style={{...lbl,color:T.up}}>TP (4.0%)</label>
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
          {l:"R:R",v:rr>0?`${rr.toFixed(1)}:1`:"--",c:rr>=2?T.up:T.wait},
          {l:"Lotes",v:lotSize>0?`${lotSize.toFixed(2)}`:"--",c:T.gold},
          {l:"Riesgo",v:dollarR>0?`$${dollarR.toFixed(0)}`:"--",c:T.down},
          {l:"Ganar",v:gainPts>0?`$${(gainPts*100).toFixed(0)}`:"--",c:T.up},
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

// SESSION BANNER
function SessionBanner({session}:{session:Session}){
  const[clock,setClock]=useState("--");
  useEffect(()=>{setClock(getColTime());const iv=setInterval(()=>setClock(getColTime()),30000);return()=>clearInterval(iv);},[]);
  const m:Record<Session,{label:string;sub:string;color:string;bg:string;border:string}>={
    LDN:{label:"LDN",sub:"3:00 AM - 5:00 AM Colombia · ACTIVA",color:T.wait,bg:T.warnBg,border:T.warnBorder},
    NY:{label:"NY OPEN",sub:"9:30 AM - 11:30 AM Colombia · ACTIVA",color:T.up,bg:T.upBg,border:T.upBorder},
    CLOSED:{label:"MERCADO",sub:"Fuera de ventana operativa",color:T.muted,bg:T.s1,border:T.border},
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
        </div>
      </div>
      <div style={{fontFamily:MONO,fontSize:11,color:T.muted}}>{clock}</div>
    </div>
  );
}

// VERDICT CARD
function VerdictCard({signal,price,score}:{signal:LiveSignal|null;price:number;score:number}){
  if(!signal)return(
    <Card style={{marginBottom:6}}>
      <div style={{fontFamily:MONO,fontSize:11,color:T.muted,textAlign:"center",padding:"8px 0"}}>Cargando señal...</div>
    </Card>
  );
  const vMap:Record<Verdict,{color:string;border:string}>={
    "ENTRAR LONG":{color:T.up,border:T.up},"ENTRAR SHORT":{color:T.down,border:T.down},"ESPERAR":{color:T.muted,border:T.dim}};
  const{color,border}=vMap[signal.verdict];
  const sc:Record<Strength,string>={FUERTE:T.up,MODERADO:T.wait,DEBIL:T.muted};
  return(
    <Card style={{borderLeft:`3px solid ${border}`,marginBottom:6}}>
      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:8,gap:8}}>
        <div>
          <div style={{fontFamily:SANS,fontSize:8,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:T.muted,marginBottom:4}}>Signal MTF · XAU/USD</div>
          <div style={{fontFamily:MONO,fontSize:24,fontWeight:700,lineHeight:1,letterSpacing:-1,color}}>
            {signal.verdict==="ENTRAR LONG"?"▲ ENTRAR LONG":signal.verdict==="ENTRAR SHORT"?"▼ ENTRAR SHORT":"- ESPERAR"}
          </div>
          <div style={{marginTop:5,display:"flex",alignItems:"center",gap:6}}>
            <Badge color={sc[signal.strength]}>{signal.strength}</Badge>
            <span style={{fontFamily:MONO,fontSize:10,color:score>=6?T.up:T.wait}}>Score {score}/10</span>
          </div>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontFamily:MONO,fontSize:20,fontWeight:700,color:T.gold,lineHeight:1}}>${price>0?price.toFixed(2):"--"}</div>
          <div style={{marginTop:4}}><Badge color={T.accent}>XAU/USD</Badge></div>
          {signal.ema200!=null&&<div style={{marginTop:4,fontFamily:MONO,fontSize:9,color:T.muted}}>EMA200 {signal.ema200.toFixed(0)}</div>}
        </div>
      </div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        {[
          {label:"HTF 4H", sig:signal.htf},
          {label:"MTF 1H", sig:signal.mtf},
          {label:"15M",    sig:signal.m15},
          {label:"LTF 5M", sig:signal.ltf},
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

// HISTORY LIST
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

// ROOT
export default function LiveTerminal({userId}:{userId:string}){
  const ws=useBinanceWS("xauusdt","1m");
  const[session,setSession]=useState<Session>("CLOSED");
  const[signal,setSignal]=useState<LiveSignal|null>(null);
  const[ops,setOps]=useState<Operation[]>([]);
  const[mobileTab,setMobileTab]=useState<MobileTab>("senal");
  const[sigError,setSigError]=useState<string|null>(null);
  const[theme,setTheme]=useState<Theme>("dark");

  // Aplicar tema en <html> y persistir
  useEffect(()=>{
    const saved=localStorage.getItem("tp3-theme") as Theme|null;
    const initial=saved??"dark";
    setTheme(initial);
    document.documentElement.setAttribute("data-theme",initial);
  },[]);

  const toggleTheme=()=>{
    const next:Theme=theme==="dark"?"light":"dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme",next);
    localStorage.setItem("tp3-theme",next);
  };

  const signalScore=signal?calcSignalScore(signal.htf,signal.mtf,signal.m15,signal.ltf,signal.rsi,signal.ema200,ws.price,session):0;

  useEffect(()=>{
    setSession(getSession());
    const iv=setInterval(()=>setSession(getSession()),30000);return()=>clearInterval(iv);
  },[]);

  useEffect(()=>{
    async function load(){
      setSigError(null);
      try{
        const[htfC,mtfC,m15C,ltfC]=await Promise.all([
          fetchLiveCandles("4h",250),fetchLiveCandles("1h",250),
          fetchLiveCandles("15m",150),fetchLiveCandles("5m",120)]);
        if(htfC.length<50||mtfC.length<50){setSigError("Datos insuficientes de Binance");return;}
        const htfInd=precompute(htfC),mtfInd=precompute(mtfC);
        const m15Ind=precompute(m15C),ltfInd=precompute(ltfC);
        const v=getLiveVerdict(htfInd,mtfInd,htfC.length-1,mtfC.length-1);
        const m15Sig=m15C.length>=50?mtfSignalAt(m15Ind,m15C.length-1):"WAIT";
        const ltfSig=ltfC.length>=50?mtfSignalAt(ltfInd,ltfC.length-1):"WAIT";
        setSignal({htf:v.htf,mtf:v.mtf,m15:m15Sig,ltf:ltfSig,verdict:v.verdict,
          strength:v.strength as Strength,ema200:v.ema200,rsi:v.rsi});
      }catch(err){
        setSigError(err instanceof Error?err.message:"Error desconocido");
        console.error("loadLiveSignals:",err);
      }
    }
    load();const iv=setInterval(load,5*60*1000);return()=>clearInterval(iv);
  },[]);

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
    {tf:"4H", rol:"Tendencia",    sig:(signal?.htf??"WAIT") as MTFSig},
    {tf:"1H", rol:"Confirmación", sig:(signal?.mtf??"WAIT") as MTFSig},
    {tf:"15M",rol:"Refinamiento", sig:(signal?.m15??"WAIT") as MTFSig},
    {tf:"5M", rol:"Entrada",      sig:(signal?.ltf??"WAIT") as MTFSig},
  ];

  return(
    <>
      <style>{`
        ${CSS_VARS}
        .tp3-root{display:grid;grid-template-columns:210px 1fr 300px;grid-template-rows:44px 1fr;height:100vh;overflow:hidden;}
        .tp3-topbar{grid-column:1/-1;grid-row:1;}
        .tp3-sidebar{grid-column:1;grid-row:2;}
        .tp3-main{grid-column:2;grid-row:2;}
        .tp3-right{grid-column:3;grid-row:2;}
        @media(max-width:1100px){.tp3-root{grid-template-columns:1fr 280px;}.tp3-sidebar{display:none;}.tp3-main{grid-column:1;}.tp3-right{grid-column:2;}}
        @media(max-width:700px){
          .tp3-root{grid-template-columns:1fr;grid-template-rows:44px 1fr;}
          .tp3-sidebar{display:none!important;}
          .tp3-right{display:none!important;}
          .tp3-main{grid-column:1;grid-row:2;}
        }
      `}</style>

      <div className="tp3-root" style={{fontFamily:SANS,color:T.text,background:T.bg}}>

        {/* TOPBAR */}
        <div className="tp3-topbar" style={{display:"flex",alignItems:"center",justifyContent:"space-between",
          padding:"0 16px",background:T.s1,borderBottom:`1px solid ${T.border}`,height:44,zIndex:10}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <div style={{width:7,height:7,borderRadius:"50%",background:ws.connected?T.up:T.muted,
              boxShadow:ws.connected?"0 0 0 3px rgba(0,200,150,0.15)":undefined}}/>
            <span style={{fontFamily:MONO,fontSize:14,fontWeight:700,letterSpacing:3,color:T.text}}>TP3</span>
            <span style={{color:T.dim}}>·</span>
            <span style={{fontSize:12,color:T.muted}}>XAU/USD Terminal</span>
          </div>
          <div style={{display:"flex",gap:10,alignItems:"center"}}>
            <span style={{fontFamily:MONO,fontSize:13,fontWeight:700,color:T.gold}}>{ws.price>0?`$${ws.price.toFixed(2)}`:"--"}</span>
            {ws.change24h!==0&&<span style={{fontFamily:MONO,fontSize:11,color:ws.change24h>=0?T.up:T.down}}>{ws.change24h>=0?"+":""}{ws.change24h.toFixed(2)}%</span>}
            <div style={{fontFamily:SANS,fontSize:9,fontWeight:700,padding:"3px 8px",borderRadius:4,
              background:ws.connected?T.upBg:T.dnBg,color:ws.connected?T.up:T.down,
              border:`1px solid ${ws.connected?T.upBorder:T.dnBorder}`}}>
              {ws.connected?"LIVE":"RECONECTANDO..."}
            </div>
            <button className="tp3-theme-btn" onClick={toggleTheme} style={{fontFamily:SANS,padding:"4px 8px",fontSize:16,lineHeight:1}}>
              {theme==="dark"?"☀":"◑"}
            </button>
            <button className="tp3-theme-btn" onClick={async()=>{
              const{createClient}=await import("@supabase/supabase-js");
              const sb=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
              await sb.auth.signOut();
              window.location.href="/login";
            }} style={{fontFamily:SANS,fontSize:11,padding:"4px 10px"}}>
              Salir
            </button>
          </div>
        </div>

        {/* LEFT SIDEBAR */}
        <div className={`tp3-sidebar${mobileTab==="estado"?" mob-active":""}`}
          style={{background:T.bg,borderRight:`1px solid ${T.border}`,overflowY:"auto",padding:"8px 6px",display:"flex",flexDirection:"column"}}>
          <Card style={{marginBottom:6}}>
            <SecTitle>Fuentes de Datos</SecTitle>
            <div style={{display:"flex",flexDirection:"column",gap:4}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"4px 7px",borderRadius:5,background:T.s2}}>
                <div>
                  <div style={{fontFamily:SANS,fontSize:9,fontWeight:700,color:T.text}}>Precio en vivo</div>
                  <div style={{fontFamily:MONO,fontSize:8,color:T.muted}}>TwelveData · WS tick</div>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:5}}>
                  <div style={{width:5,height:5,borderRadius:"50%",background:ws.connected?T.up:T.muted}}/>
                  <span style={{fontFamily:MONO,fontSize:8,color:ws.connected?T.up:T.muted}}>{ws.connected?"LIVE":"OFF"}</span>
                </div>
              </div>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"4px 7px",borderRadius:5,background:T.s2}}>
                <div>
                  <div style={{fontFamily:SANS,fontSize:9,fontWeight:700,color:T.text}}>Señales MTF</div>
                  <div style={{fontFamily:MONO,fontSize:8,color:T.muted}}>Binance Futures · REST 5m</div>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:5}}>
                  <div style={{width:5,height:5,borderRadius:"50%",background:signal?T.up:T.muted}}/>
                  <span style={{fontFamily:MONO,fontSize:8,color:signal?T.up:T.muted}}>{signal?"LIVE":"..."}</span>
                </div>
              </div>
            </div>
            {sigError&&<div style={{marginTop:6,padding:"4px 8px",borderRadius:5,background:T.dnBg,border:`1px solid ${T.dnBorder}`,fontFamily:MONO,fontSize:9,color:T.down}}>! {sigError}</div>}
          </Card>
          <Card style={{marginBottom:6}}>
            <SecTitle>MTF Matrix</SecTitle>
            {mtfRows.map(({tf,rol,sig})=>(
              <div key={tf} style={{display:"flex",alignItems:"center",justifyContent:"space-between",
                padding:"5px 0",borderBottom:tf!=="5M"?`1px solid ${T.border}`:undefined}}>
                <div>
                  <span style={{fontFamily:MONO,fontSize:10,color:T.muted,fontWeight:700,minWidth:28}}>{tf}</span>
                  <span style={{fontFamily:SANS,fontSize:8,color:T.dim,marginLeft:5}}>{rol}</span>
                </div>
                <MTFSigBadge sig={sig}/>
              </div>
            ))}
            <div style={{marginTop:6,padding:"4px 8px",borderRadius:5,textAlign:"center",fontFamily:MONO,fontSize:10,fontWeight:700,
              background:signalScore>=6?T.upBg:T.s2,color:signalScore>=6?T.up:T.muted,
              border:`1px solid ${signalScore>=6?T.upBorder:T.border}`}}>Score {signalScore}/10</div>
          </Card>
          <Card>
            <SecTitle>Cuenta</SecTitle>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:4}}>
              {[
                {l:"WR",v:`${wr}%`,c:wr>=50?T.up:T.down},{l:"Ops",v:`${ops.length}`,c:T.text},
                {l:"P&L",v:`${pnlTotal>=0?"+":""}${pnlTotal.toFixed(1)}%`,c:pnlTotal>=0?T.up:T.down},
                {l:"Wins",v:`${wins}`,c:T.up},
              ].map(({l,v,c})=>(
                <div key={l} style={{background:T.s2,borderRadius:5,padding:"6px 7px"}}>
                  <div style={{fontSize:7,fontWeight:600,letterSpacing:"0.06em",textTransform:"uppercase",color:T.muted,marginBottom:2}}>{l}</div>
                  <div style={{fontFamily:MONO,fontSize:13,fontWeight:700,color:c}}>{v}</div>
                </div>
              ))}
            </div>
          </Card>
        </div>

        {/* MAIN FEED */}
        <div className={`tp3-main${mobileTab==="senal"?" mob-active":""}`}
          style={{background:T.bg,overflowY:"auto",padding:"8px 10px",display:"flex",flexDirection:"column"}}>
          <SessionBanner session={session}/>
          <VerdictCard signal={signal} price={ws.price} score={signalScore}/>
          <Card>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:7}}>
              <SecTitle>Historial XAU/USD</SecTitle>
              <span style={{fontFamily:MONO,fontSize:9,color:T.muted}}>{ops.length} ops</span>
            </div>
            <HistoryList ops={ops} userId={userId} onUpdate={handleUpdate}/>
          </Card>
        </div>

        {/* RIGHT PANEL — llena toda la altura sin scroll */}
        <div className={`tp3-right${mobileTab==="operar"?" mob-active":""}`}
          style={{background:T.bg,borderLeft:`1px solid ${T.border}`,
            overflow:"hidden",padding:"8px 8px",display:"flex",flexDirection:"column",height:"100%"}}>
          <Checklist session={session} signal={signal} price={ws.price} signalScore={signalScore} hasNews={false}/>
          <div style={{flex:1,display:"flex",flexDirection:"column",minHeight:0}}>
            <OperationForm livePrice={ws.price} userId={userId} onSaved={handleSaved} fillHeight/>
          </div>
        </div>

        {/* MOBILE TABS — eliminados */}

      </div>
    </>
  );
}
