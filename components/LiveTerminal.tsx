"use client";
// components/LiveTerminal.tsx — v2.2
// · Dark / Light toggle (CSS variables, persiste en localStorage)
// · Panel derecho compacto sin scroll
// · Señales reales: precompute + getLiveVerdict + mtfSignalAt
// · Score 1–10 calculado desde indicadores

import { useState, useEffect, useCallback } from "react";
import { calcOpLevels, calcLotSize } from "@/lib/engine/simulator";
import { precompute }      from "@/lib/engine/indicators";
import { getLiveVerdict, mtfSignalAt } from "@/lib/engine/signals";
import type { Candle } from "@/lib/engine/types";

// T usa CSS variables definidas en globals.css
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

type Direction = "LONG"|"SHORT";
type OpsResult = "TP"|"SL"|"MANUAL"|null;
type Session   = "LDN"|"NY"|"CLOSED";
type MTFSig    = "UP"|"DOWN"|"WAIT";
type Verdict   = "ENTRAR LONG"|"ENTRAR SHORT"|"ESPERAR";
type Strength  = "FUERTE"|"MODERADO"|"DEBIL";

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
function getNextSession():{label:string;mins:number}{
  const u=new Date().getUTCHours()*60+new Date().getUTCMinutes();
  const DAY=1440;
  // LDN starts UTC 480, NY starts UTC 870
  if(u<480){return{label:"LDN Open",mins:480-u};}
  if(u>=600&&u<870){return{label:"NY Open",mins:870-u};}
  // after NY (>=990) or between 0-480 next day
  const minsToLdnTomorrow=u>=990?DAY-u+480:480-u;
  return{label:"LDN mañana",mins:minsToLdnTomorrow};
}
function fmtCountdown(mins:number):string{
  const h=Math.floor(mins/60),m=mins%60;
  return h>0?`${h}h ${m}m`:`${m}m`;
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
interface OpFormProps{livePrice:number;userId:string;onSaved:(op:Operation)=>void;fillHeight?:boolean;slPct?:number;tpPct?:number;}
function OperationForm({livePrice,userId,onSaved,fillHeight,slPct=1,tpPct=4}:OpFormProps){
  const[dir,setDir]=useState<Direction>("LONG");
  const[entry,setEntry]=useState("");const[sl,setSL]=useState("");const[tp,setTP]=useState("");
  const[capital,setCap]=useState("");const[riskPct,setRisk]=useState("1");
  const[saving,setSaving]=useState(false);
  useEffect(()=>{
    const e=parseFloat(entry);if(!e||e<=0){setSL("");setTP("");return;}
    const{sl:slv,tp:tpv}=calcOpLevels(e,dir,slPct/100,tpPct/100);setSL(slv.toFixed(2));setTP(tpv.toFixed(2));
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
        <div><label style={{...lbl,color:T.down}}>SL ({slPct}%)</label>
          <input type="number" value={sl} placeholder="SL" onChange={e=>setSL(e.target.value)} style={inp}/></div>
        <div><label style={{...lbl,color:T.up}}>TP ({tpPct}%)</label>
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
  const[next,setNext]=useState<{label:string;mins:number}|null>(null);
  useEffect(()=>{
    setClock(getColTime());
    if(session==="CLOSED")setNext(getNextSession());
    const iv=setInterval(()=>{
      setClock(getColTime());
      if(session==="CLOSED")setNext(getNextSession());
    },60000);
    return()=>clearInterval(iv);
  },[session]);
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
          {session==="CLOSED"&&next&&(
            <div style={{fontFamily:MONO,fontSize:9,color:T.accent,marginTop:2}}>
              ⏱ {next.label} en {fmtCountdown(next.mins)}
            </div>
          )}
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

  // Solo mostrar ENTRAR si score >= 6, si no ESPERAR siempre
  const verdict = score >= 6 ? signal.verdict : "ESPERAR";

  const vMap:Record<Verdict,{color:string;border:string}>={
    "ENTRAR LONG":{color:T.up,border:T.up},"ENTRAR SHORT":{color:T.down,border:T.down},"ESPERAR":{color:T.muted,border:T.dim}};
  const{color,border}=vMap[verdict];
  const sc:Record<Strength,string>={FUERTE:T.up,MODERADO:T.wait,DEBIL:T.muted};
  return(
    <Card style={{borderLeft:`3px solid ${border}`,marginBottom:6}}>
      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:8,gap:8}}>
        <div>
          <div style={{fontFamily:SANS,fontSize:8,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:T.muted,marginBottom:4}}>Signal MTF · XAU/USD</div>
          <div style={{fontFamily:MONO,fontSize:24,fontWeight:700,lineHeight:1,letterSpacing:-1,color}}>
            {verdict==="ENTRAR LONG"?"▲ ENTRAR LONG":verdict==="ENTRAR SHORT"?"▼ ENTRAR SHORT":"- ESPERAR"}
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
export default function LiveTerminal({userId,price,connected}:{userId:string;price:number;connected:boolean}){
  const[session,   setSession]  = useState<Session>("CLOSED");
  const[signal,    setSignal]   = useState<LiveSignal|null>(null);
  const[ops,       setOps]      = useState<Operation[]>([]);
  const[sigError,  setSigError] = useState<string|null>(null);

  // Configuración ajustable
  const SL_OPTIONS = [0.5,0.75,1,1.5,2,2.5,3,3.5,4];
  const TP_OPTIONS = [0.5,0.75,1,1.5,2,2.5,3,3.5,4];
  const[htfTf, setHtfTf] = useState<"4h"|"1h">("4h");
  const[ltfTf, setLtfTf] = useState<"15m"|"5m">("15m");
  const[slPct, setSlPct] = useState(1);
  const[tpPct, setTpPct] = useState(4);

  // Cuando cambia HTF, el LTF se ajusta automático
  const handleHtfChange = (tf: "4h"|"1h") => {
    setHtfTf(tf);
    if(tf === "1h") setLtfTf("5m"); // 1H→15M→5M
    else setLtfTf("15m");            // 4H→1H→15M
  };

  // MTF siempre es el nivel intermedio fijo
  const mtfTfLabel = htfTf === "4h" ? "1H" : "15M";

  // LTF opciones según HTF
  const ltfOptions: {value:"15m"|"5m"; label:string}[] = htfTf === "4h"
    ? [{value:"15m",label:"15M"},{value:"5m",label:"5M"}]
    : [{value:"5m", label:"5M"}]; // cuando HTF=1H, solo 5M tiene sentido

  const signalScore=signal?calcSignalScore(signal.htf,signal.mtf,signal.m15,signal.ltf,signal.rsi,signal.ema200,price,session):0;

  useEffect(()=>{
    setSession(getSession());
    const iv=setInterval(()=>setSession(getSession()),30000);return()=>clearInterval(iv);
  },[]);

  useEffect(()=>{
    async function load(){
      setSigError(null);
      try{
        const mtfTf = htfTf === "4h" ? "1h" : "15m";
        const[htfC,mtfC,m15C,ltfC]=await Promise.all([
          fetchLiveCandles(htfTf,250),
          fetchLiveCandles(mtfTf,250),
          fetchLiveCandles("15m",150),
          fetchLiveCandles(ltfTf,120)]);
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
      }
    }
    load();const iv=setInterval(load,15*60*1000);return()=>clearInterval(iv);
  },[htfTf,ltfTf]);

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
    {key:"htf", tf:htfTf.toUpperCase(), rol:"Tendencia",    sig:(signal?.htf??"WAIT") as MTFSig},
    {key:"mtf", tf:mtfTfLabel,          rol:"Confirmación", sig:(signal?.mtf??"WAIT") as MTFSig},
    {key:"m15", tf:"15M",               rol:"Refinamiento", sig:(signal?.m15??"WAIT") as MTFSig},
    {key:"ltf", tf:ltfTf.toUpperCase(), rol:"Entrada",      sig:(signal?.ltf??"WAIT") as MTFSig},
  ];

  return(
    <>
      <style>{`
        .tp3-root{display:grid;grid-template-columns:320px 1fr 320px;grid-template-rows:1fr;height:100%;overflow:hidden;}
        .tp3-sidebar{grid-column:1;grid-row:1;}
        .tp3-main{grid-column:2;grid-row:1;}
        .tp3-right{grid-column:3;grid-row:1;}
        @media(max-width:1100px){.tp3-root{grid-template-columns:1fr 280px;}.tp3-sidebar{display:none;}.tp3-main{grid-column:1;}.tp3-right{grid-column:2;}}
        @media(max-width:700px){
          .tp3-root{grid-template-columns:1fr;}
          .tp3-sidebar{display:none!important;}
          .tp3-right{display:none!important;}
          .tp3-main{grid-column:1;grid-row:1;}
        }
      `}</style>

      <div className="tp3-root" style={{fontFamily:SANS,color:T.text,background:T.bg}}>

        {/* LEFT SIDEBAR */}
        <div className="tp3-sidebar"
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
                  <div style={{width:5,height:5,borderRadius:"50%",background:connected?T.up:T.muted}}/>
                  <span style={{fontFamily:MONO,fontSize:8,color:connected?T.up:T.muted}}>{connected?"LIVE":"OFF"}</span>
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

            {/* HTF selector */}
            <div style={{display:"flex",gap:3,marginBottom:6}}>
              {(["4h","1h"] as const).map(tf=>(
                <button key={tf} onClick={()=>handleHtfChange(tf)} style={{
                  flex:1,padding:"3px 0",borderRadius:5,
                  border:`1px solid ${htfTf===tf?T.gold:T.border}`,
                  background:htfTf===tf?"rgba(212,175,55,0.12)":T.s2,
                  color:htfTf===tf?T.gold:T.muted,
                  fontFamily:MONO,fontSize:9,fontWeight:700,cursor:"pointer",
                }}>{tf.toUpperCase()}</button>
              ))}
              {ltfOptions.map(({value,label})=>(
                <button key={value} onClick={()=>setLtfTf(value)} style={{
                  flex:1,padding:"3px 0",borderRadius:5,
                  border:`1px solid ${ltfTf===value?T.accent:T.border}`,
                  background:ltfTf===value?`${T.accent}18`:T.s2,
                  color:ltfTf===value?T.accent:T.muted,
                  fontFamily:MONO,fontSize:9,fontWeight:700,cursor:"pointer",
                }}>{label}</button>
              ))}
            </div>

            {/* Señales por TF */}
            {mtfRows.map(({key,tf,rol,sig})=>(
              <div key={key} style={{display:"flex",alignItems:"center",justifyContent:"space-between",
                padding:"5px 0",borderBottom:key!=="ltf"?`1px solid ${T.border}`:undefined}}>
                <div>
                  <span style={{fontFamily:MONO,fontSize:10,color:T.muted,fontWeight:700,minWidth:28}}>{tf}</span>
                  <span style={{fontFamily:SANS,fontSize:8,color:T.dim,marginLeft:5}}>{rol}</span>
                </div>
                <MTFSigBadge sig={sig}/>
              </div>
            ))}

            {/* SL / TP */}
            <div style={{marginTop:7,paddingTop:6,borderTop:`1px solid ${T.border}`}}>
              <div style={{display:"flex",alignItems:"center",gap:4,marginBottom:4}}>
                <span style={{fontFamily:SANS,fontSize:8,color:T.muted,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.06em",minWidth:16}}>SL</span>
                <div style={{display:"flex",flexWrap:"wrap",gap:2}}>
                  {SL_OPTIONS.map(v=>(
                    <button key={v} onClick={()=>setSlPct(v)} style={{
                      padding:"2px 4px",borderRadius:4,
                      border:`1px solid ${slPct===v?T.down:T.border}`,
                      background:slPct===v?"rgba(255,59,92,0.12)":T.s2,
                      color:slPct===v?T.down:T.muted,
                      fontFamily:MONO,fontSize:8,fontWeight:700,cursor:"pointer",
                    }}>{v}%</button>
                  ))}
                </div>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:4}}>
                <span style={{fontFamily:SANS,fontSize:8,color:T.muted,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.06em",minWidth:16}}>TP</span>
                <div style={{display:"flex",flexWrap:"wrap",gap:2}}>
                  {TP_OPTIONS.map(v=>(
                    <button key={v} onClick={()=>setTpPct(v)} style={{
                      padding:"2px 4px",borderRadius:4,
                      border:`1px solid ${tpPct===v?T.up:T.border}`,
                      background:tpPct===v?"rgba(0,200,150,0.12)":T.s2,
                      color:tpPct===v?T.up:T.muted,
                      fontFamily:MONO,fontSize:8,fontWeight:700,cursor:"pointer",
                    }}>{v}%</button>
                  ))}
                </div>
              </div>
            </div>

            {/* Score */}
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
        <div className="tp3-main"
          style={{background:T.bg,overflowY:"auto",padding:"8px 10px",display:"flex",flexDirection:"column"}}>
          <SessionBanner session={session}/>
          <VerdictCard signal={signal} price={price} score={signalScore}/>
          <Card>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:7}}>
              <SecTitle>Historial XAU/USD</SecTitle>
              <span style={{fontFamily:MONO,fontSize:9,color:T.muted}}>{ops.length} ops</span>
            </div>
            <HistoryList ops={ops} userId={userId} onUpdate={handleUpdate}/>
          </Card>
        </div>

        {/* RIGHT PANEL */}
        <div className="tp3-right"
          style={{background:T.bg,borderLeft:`1px solid ${T.border}`,
            overflow:"hidden",padding:"8px 8px",display:"flex",flexDirection:"column",height:"100%"}}>
          <Checklist session={session} signal={signal} price={price} signalScore={signalScore} hasNews={false}/>
          <div style={{flex:1,display:"flex",flexDirection:"column",minHeight:0}}>
            <OperationForm livePrice={price} userId={userId} onSaved={handleSaved} fillHeight slPct={slPct} tpPct={tpPct}/>
          </div>
        </div>

      </div>
    </>
  );
}
