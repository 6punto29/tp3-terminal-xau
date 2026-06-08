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

// Shadow Trading — fila de la tabla shadow_trades (un trade teórico).
// Un evento se compone de 1 a 4 filas con el mismo event_id (una por perfil
// de TP). Los 4 perfiles comparten entry/sl pero tienen tp distintos.
interface ShadowTradeRow {
  id:             string;
  event_id:       string;
  case_type:      "d1_blocked"|"structure_contradicts";
  created_at:     string;
  result_at:      string|null;
  direction:      Direction;
  entry_price:    number;
  sl_price:       number;
  sl_pct:         number;
  tp_price:       number;
  tp_pct:         number;
  tp_type:        "structural"|"swing_minor"|"atr_15x"|"rr_15_fixed";
  score_puro:     number;
  score_ajustado: number;
  rsi_at_entry:   number|null;
  atr_at_entry:   number|null;
  liquidez:       "alta"|"baja"|"weekend"|null;
  d1_bias:        "UP"|"DOWN"|"WAIT"|null;
  status:         "OPEN"|"WIN"|"LOSS"|"EXPIRED";
  result_price:   number|null;
  pnl_pct:        number|null;
}

const Card=({children,style}:{children:React.ReactNode;style?:React.CSSProperties})=>(
  <div style={{background:T.s1,borderRadius:10,border:`1px solid ${T.border}`,padding:"14px 16px",...style}}>{children}</div>
);
const SecTitle=({children}:{children:React.ReactNode})=>(
  <div style={{fontFamily:SANS,fontSize:11,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:T.muted,marginBottom:10}}>{children}</div>
);

// Wrapper para tablas que pueden desbordarse en mobile.
// En desktop (viewport ≥ ancho de la tabla) no se activa; en mobile permite
// scroll horizontal con sombras laterales que indican dirección del scroll.
// Técnica: background-attachment local/scroll con linear-gradients (Roma
// Komarov, CSS-Tricks 2012). Sin JS ni listeners.
const ScrollX = ({minWidth, children}: {minWidth:number; children:React.ReactNode}) => (
  <div style={{
    overflowX:"auto",
    WebkitOverflowScrolling:"touch",
    backgroundImage:`
      linear-gradient(to right, var(--tp3-s1), transparent 24px),
      linear-gradient(to left,  var(--tp3-s1), transparent 24px),
      radial-gradient(farthest-side at 0 50%,   rgba(0,0,0,0.35), transparent),
      radial-gradient(farthest-side at 100% 50%, rgba(0,0,0,0.35), transparent)
    `,
    backgroundRepeat:"no-repeat",
    backgroundColor:"var(--tp3-s1)",
    backgroundSize:"40px 100%, 40px 100%, 14px 100%, 14px 100%",
    backgroundPosition:"left center, right center, left center, right center",
    backgroundAttachment:"local, local, scroll, scroll",
  }}>
    <div style={{minWidth}}>{children}</div>
  </div>
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

  // Shadow Trading state
  const[shadowTrades,setShadowTrades]=useState<ShadowTradeRow[]>([]);
  const[shadowLoading,setShadowLoading]=useState(true);
  const[shadowExpanded,setShadowExpanded]=useState(false);
  const[shadowCopied,setShadowCopied]=useState(false);            // feedback botón global "Copiar shadows"
  const[shadowRowCopied,setShadowRowCopied]=useState<string|null>(null); // id de fila con feedback temporal

  useEffect(()=>{
    if(!userId)return;
    setLoading(true);
    authHeaders().then(h=>fetch("/api/operations",{headers:h}))
      .then(r=>r.json()).then(d=>{if(Array.isArray(d))setOps(d);})
      .catch(console.error).finally(()=>setLoading(false));
  },[userId]);

  // Fetch shadow trades al montar (independiente de ops — endpoint separado)
  useEffect(()=>{
    if(!userId)return;
    setShadowLoading(true);
    authHeaders().then(h=>fetch("/api/shadow-trades?limit=500",{headers:h}))
      .then(r=>r.json()).then(d=>{if(Array.isArray(d))setShadowTrades(d);})
      .catch(console.error).finally(()=>setShadowLoading(false));
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

  // ── SHADOW TRADING STATS ─────────────────────────────────────────────────
  // Agrupados por case_type (qué bloqueo evaluar) y por tp_type (qué perfil
  // de salida performa mejor). Eventos únicos = señales detectadas; trades
  // = eventos × perfiles válidos (1 a 4 por evento). EXPIRED se excluye del
  // WR (no llegó a TP ni a SL en 24h) pero cuenta para Avg PnL y Profit Factor.
  function calcShadowStats(rows: ShadowTradeRow[]) {
    const closed   = rows.filter(t => t.status !== "OPEN");
    const wins     = closed.filter(t => t.status === "WIN").length;
    const losses   = closed.filter(t => t.status === "LOSS").length;
    const expired  = closed.filter(t => t.status === "EXPIRED").length;
    const ofrr     = wins + losses;
    const wr       = ofrr > 0 ? Math.round((wins / ofrr) * 100) : null;
    const pnls     = closed.map(t => t.pnl_pct ?? 0).filter(p => Number.isFinite(p));
    const sumWin   = pnls.filter(p => p > 0).reduce((a,b)=>a+b, 0);
    const sumLoss  = Math.abs(pnls.filter(p => p < 0).reduce((a,b)=>a+b, 0));
    const pf       = sumLoss > 0 ? sumWin/sumLoss : null;
    const avgPnl   = pnls.length > 0 ? pnls.reduce((a,b)=>a+b, 0)/pnls.length : null;
    const bestPnl  = pnls.length > 0 ? Math.max(...pnls) : null;
    const worstPnl = pnls.length > 0 ? Math.min(...pnls) : null;
    return { total:rows.length, closed:closed.length, open:rows.length-closed.length,
             wins, losses, expired, ofrr, wr, pf, avgPnl, bestPnl, worstPnl };
  }

  const shadowEventIds      = new Set(shadowTrades.map(t => t.event_id));
  const shadowTotalEvents   = shadowEventIds.size;
  const shadowOpenCount     = shadowTrades.filter(t => t.status === "OPEN").length;

  // Por case_type — ¿el gate D1 está bloqueando trades rentables? ¿la estructura contradictoria realmente importa?
  const shadowD1Stats     = calcShadowStats(shadowTrades.filter(t => t.case_type === "d1_blocked"));
  const shadowStructStats = calcShadowStats(shadowTrades.filter(t => t.case_type === "structure_contradicts"));

  // Por tp_type — comparativa de los 4 perfiles de salida
  const shadowByTpType = {
    structural:  calcShadowStats(shadowTrades.filter(t => t.tp_type === "structural")),
    swing_minor: calcShadowStats(shadowTrades.filter(t => t.tp_type === "swing_minor")),
    atr_15x:     calcShadowStats(shadowTrades.filter(t => t.tp_type === "atr_15x")),
    rr_15_fixed: calcShadowStats(shadowTrades.filter(t => t.tp_type === "rr_15_fixed")),
  };

  // Helpers de color/formato para la sección Shadow
  const shadowPfColor = (pf:number|null): string =>
    pf == null ? T.muted : pf >= 1.5 ? T.up : pf >= 1 ? T.wait : T.down;
  const shadowWrColor = (wr:number|null): string =>
    wr == null ? T.muted : wr >= 50 ? T.up : T.down;
  const fmtPct = (p:number|null): string =>
    p == null ? "--" : (p >= 0 ? "+" : "") + p.toFixed(2) + "%";

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

  // ── Copiar shadow trades ────────────────────────────────────────────────
  // Formato profesional para pasar al análisis externo (Claude/VIP/notas).
  // Agrupa por event_id para no repetir entry/SL por cada perfil de TP.

  // Copiar TODOS los shadow trades agrupados por evento
  const copyShadowAll = async()=>{
    if(shadowTrades.length===0)return;
    const now = new Date();
    const dateStr = now.toLocaleDateString("es-CO",{day:"2-digit",month:"2-digit",year:"2-digit"});
    const timeStr = now.toLocaleTimeString("es-CO",{hour:"2-digit",minute:"2-digit",hour12:false});

    // Stats globales (reuso de calcShadowStats sobre todos)
    const all = calcShadowStats(shadowTrades);
    const wrStr = all.wr != null ? `${all.wr}%` : "--";

    // Agrupar por event_id (ordenado por fecha desc — los trades ya vienen así de la API)
    const groups = new Map<string,ShadowTradeRow[]>();
    shadowTrades.forEach(t=>{
      const arr = groups.get(t.event_id) || [];
      arr.push(t);
      groups.set(t.event_id, arr);
    });

    const lines:string[] = [
      "━━━ TP3 Shadow Trades · XAU/USD ━━━",
      `📅 ${dateStr} ${timeStr} COL · ${groups.size} eventos · ${shadowTrades.length} trades`,
      `WR global: ${wrStr} (${all.wins}W / ${all.losses}L · ${all.expired} EXPIRED · ${all.open} OPEN)`,
      "",
    ];

    let evIdx = 1;
    groups.forEach(trades=>{
      const first = trades[0]; // todos los perfiles comparten metadata del evento
      const fechaUtc = (()=>{
        try{
          const d = new Date(first.created_at);
          const dd = d.getUTCDate().toString().padStart(2,"0");
          const mm = (d.getUTCMonth()+1).toString().padStart(2,"0");
          const hh = d.getUTCHours().toString().padStart(2,"0");
          const mi = d.getUTCMinutes().toString().padStart(2,"0");
          return `${dd}/${mm} ${hh}:${mi} UTC`;
        }catch{return "--";}
      })();
      const caso = first.case_type==="d1_blocked" ? "D1 bloqueó" : "Estructura contradice";
      const liqStr = first.liquidez ? `liq. ${first.liquidez}` : "liq. ?";
      const rsiStr = first.rsi_at_entry != null ? first.rsi_at_entry.toFixed(0) : "--";
      const atrStr = first.atr_at_entry != null ? first.atr_at_entry.toFixed(2) : "--";
      const d1Str  = first.d1_bias || "--";

      lines.push(`▸ Evento ${evIdx} · ${fechaUtc}`);
      lines.push(`  Caso: ${caso} · Dirección: ${first.direction}`);
      lines.push(`  Score puro: ${first.score_puro} · Score ajustado: ${first.score_ajustado} (${liqStr})`);
      lines.push(`  RSI: ${rsiStr} · ATR: ${atrStr} · D1 bias: ${d1Str}`);
      lines.push(`  Entry: $${first.entry_price.toFixed(2)}`);
      lines.push(`  Perfiles TP:`);
      trades.forEach(t=>{
        const tpPctStr = `${t.tp_pct>=0?"+":""}${t.tp_pct.toFixed(2)}%`;
        const slPctStr = `${t.sl_pct>=0?"+":""}${t.sl_pct.toFixed(2)}%`;
        const pnlStr   = fmtPct(t.pnl_pct);
        lines.push(`    · ${t.tp_type.padEnd(12)} TP $${t.tp_price.toFixed(2)} (${tpPctStr}) · SL $${t.sl_price.toFixed(2)} (${slPctStr}) → ${t.status} ${pnlStr}`);
      });
      lines.push("");
      evIdx++;
    });

    lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━");

    try{
      await navigator.clipboard.writeText(lines.join("\n"));
      setShadowCopied(true);
      setTimeout(()=>setShadowCopied(false), 2000);
    }catch{
      // fallback silencioso
    }
  };

  // Copiar UN perfil individual (con contexto del evento)
  const copyShadowRow = async(t:ShadowTradeRow)=>{
    const fechaUtc = (()=>{
      try{
        const d = new Date(t.created_at);
        const dd = d.getUTCDate().toString().padStart(2,"0");
        const mm = (d.getUTCMonth()+1).toString().padStart(2,"0");
        const hh = d.getUTCHours().toString().padStart(2,"0");
        const mi = d.getUTCMinutes().toString().padStart(2,"0");
        return `${dd}/${mm} ${hh}:${mi} UTC`;
      }catch{return "--";}
    })();
    const caso = t.case_type==="d1_blocked" ? "D1 bloqueó" : "Estructura contradice";
    const liqStr = t.liquidez ? `liq. ${t.liquidez}` : "liq. ?";

    const text = [
      `🌒 Shadow trade (1 perfil)`,
      `${fechaUtc} · ${caso} · ${t.direction}`,
      `Score puro: ${t.score_puro} · Score ajustado: ${t.score_ajustado} (${liqStr})`,
      `Entry: $${t.entry_price.toFixed(2)} · SL: $${t.sl_price.toFixed(2)} · TP: $${t.tp_price.toFixed(2)}`,
      `Perfil: ${t.tp_type} · Status: ${t.status} · PnL: ${fmtPct(t.pnl_pct)}`,
    ].join("\n");

    try{
      await navigator.clipboard.writeText(text);
      setShadowRowCopied(t.id);
      setTimeout(()=>setShadowRowCopied(prev => prev===t.id ? null : prev), 1500);
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
    <div style={{background:T.bg,minHeight:"100%",padding:"16px 16px calc(16px + env(safe-area-inset-bottom)) 16px",overflowY:"auto"}}>
      <div style={{maxWidth:1100,margin:"0 auto",display:"flex",flexDirection:"column",gap:14}}>

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

        {/* ── Shadow Trading — counterfactual learning ─────────────────────── */}
        <Card>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10,gap:8,flexWrap:"wrap"}}>
            <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
              <div style={{fontFamily:SANS,fontSize:11,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:T.muted}}>🌒 Shadow Trading</div>
              <span style={{fontFamily:SANS,fontSize:9,color:T.dim,fontStyle:"italic"}}>
                señales teóricas — no se operan, miden costo de oportunidad
              </span>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <span style={{fontFamily:MONO,fontSize:9,color:T.muted}}>
                {shadowTotalEvents} eventos · {shadowTrades.length} trades · {shadowOpenCount} abiertos
              </span>
              <button
                onClick={copyShadowAll}
                disabled={shadowTrades.length===0}
                style={{
                  background:shadowCopied?T.upBg:T.s2,
                  border:`1px solid ${shadowCopied?T.upBorder:T.border2}`,
                  borderRadius:6,padding:"5px 10px",
                  cursor:shadowTrades.length>0?"pointer":"not-allowed",
                  fontFamily:SANS,fontSize:10,fontWeight:600,
                  color:shadowCopied?T.up:T.muted,
                  opacity:shadowTrades.length>0?1:0.4,
                  transition:"all 0.2s"
                }}>
                {shadowCopied?"✓ Copiado":"📋 Copiar shadows"}
              </button>
            </div>
          </div>

          {shadowLoading ? (
            <div style={{fontFamily:MONO,fontSize:11,color:T.muted,padding:"10px 0"}}>Cargando...</div>
          ) : shadowTrades.length === 0 ? (
            <div style={{fontFamily:SANS,fontSize:11,color:T.muted,padding:"20px 0",textAlign:"center",lineHeight:1.5}}>
              Sin señales shadow registradas todavía.<br/>
              <span style={{fontSize:10,color:T.dim}}>El sistema captura silenciosamente cuando D1 bloquea un setup 10/10 o cuando la estructura HTF contradice la dirección del trade.</span>
            </div>
          ) : (
            <>
              {/* Resumen por case_type */}
              <div style={{marginBottom:14}}>
                <div style={{fontFamily:SANS,fontSize:9,fontWeight:600,letterSpacing:"0.08em",textTransform:"uppercase",color:T.muted,marginBottom:6}}>
                  Por tipo de caso
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(280px, 1fr))",gap:8}}>
                  {[
                    {key:"d1",     label:"D1 bloqueó",            desc:"¿valió la pena bloquear?",   stats:shadowD1Stats},
                    {key:"struct", label:"Estructura contradice", desc:"¿llegan a TP completo?",     stats:shadowStructStats},
                  ].map(({key,label,desc,stats})=>(
                    <div key={key} style={{background:T.s2,borderRadius:8,padding:"10px 12px",border:`1px solid ${T.border}`}}>
                      <div style={{display:"flex",alignItems:"baseline",justifyContent:"space-between",marginBottom:6}}>
                        <div>
                          <div style={{fontFamily:SANS,fontSize:11,fontWeight:700,color:T.text}}>{label}</div>
                          <div style={{fontFamily:SANS,fontSize:8,color:T.dim,fontStyle:"italic"}}>{desc}</div>
                        </div>
                        <span style={{fontFamily:MONO,fontSize:10,color:T.muted}}>{stats.total} trades</span>
                      </div>
                      <div style={{display:"grid",gridTemplateColumns:"repeat(4, 1fr)",gap:6}}>
                        <div>
                          <div style={{fontFamily:SANS,fontSize:8,color:T.muted,marginBottom:2}}>W/L/EXP</div>
                          <div style={{fontFamily:MONO,fontSize:10,color:T.text}}>
                            <span style={{color:T.up}}>{stats.wins}</span>/<span style={{color:T.down}}>{stats.losses}</span>/<span style={{color:T.dim}}>{stats.expired}</span>
                          </div>
                        </div>
                        <div>
                          <div style={{fontFamily:SANS,fontSize:8,color:T.muted,marginBottom:2}}>WR</div>
                          <div style={{fontFamily:MONO,fontSize:11,fontWeight:700,color:shadowWrColor(stats.wr)}}>
                            {stats.wr != null ? `${stats.wr}%` : "--"}
                          </div>
                        </div>
                        <div>
                          <div style={{fontFamily:SANS,fontSize:8,color:T.muted,marginBottom:2}}>PF</div>
                          <div style={{fontFamily:MONO,fontSize:11,fontWeight:700,color:shadowPfColor(stats.pf)}}>
                            {stats.pf != null ? stats.pf.toFixed(2) : "--"}
                          </div>
                        </div>
                        <div>
                          <div style={{fontFamily:SANS,fontSize:8,color:T.muted,marginBottom:2}}>Avg PnL</div>
                          <div style={{fontFamily:MONO,fontSize:10,color:stats.avgPnl != null ? (stats.avgPnl >= 0 ? T.up : T.down) : T.muted}}>
                            {fmtPct(stats.avgPnl)}
                          </div>
                        </div>
                      </div>
                      {stats.ofrr > 0 && stats.ofrr < 30 && (
                        <div style={{fontFamily:SANS,fontSize:8,color:T.wait,fontStyle:"italic",marginTop:6}}>
                          ⚠ Sample size insuficiente ({stats.ofrr}/30) — números preliminares
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Resumen por tp_type (los 4 perfiles) */}
              <div style={{marginBottom:8}}>
                <div style={{fontFamily:SANS,fontSize:9,fontWeight:600,letterSpacing:"0.08em",textTransform:"uppercase",color:T.muted,marginBottom:6}}>
                  Por perfil de salida (TP)
                </div>
                <ScrollX minWidth={600}>
                  <div style={{display:"flex",flexDirection:"column",gap:3}}>
                    <div style={{display:"grid",gridTemplateColumns:"160px 60px 60px 60px 70px 70px 70px",gap:6,
                      padding:"4px 8px",fontFamily:SANS,fontSize:8,fontWeight:600,
                      letterSpacing:"0.06em",textTransform:"uppercase",color:T.muted,borderBottom:`1px solid ${T.border}`}}>
                      <span>Perfil</span><span>Total</span><span>WR</span><span>PF</span>
                      <span>Avg PnL</span><span>Best</span><span>Worst</span>
                    </div>
                    {[
                      {key:"structural"  as const, label:"Structural",   desc:"R:R [2,5] del motor"},
                      {key:"swing_minor" as const, label:"Swing minor",  desc:"Primer swing sin filtro"},
                      {key:"atr_15x"     as const, label:"ATR × 1.5",    desc:"Volatilidad-based"},
                      {key:"rr_15_fixed" as const, label:"R:R fijo 1.5", desc:"SL × 1.5"},
                    ].map(({key,label,desc})=>{
                      const s = shadowByTpType[key];
                      return(
                        <div key={key} style={{display:"grid",gridTemplateColumns:"160px 60px 60px 60px 70px 70px 70px",gap:6,
                          padding:"5px 8px",borderRadius:5,background:T.s2,alignItems:"center"}}>
                          <div>
                            <div style={{fontFamily:SANS,fontSize:10,fontWeight:600,color:T.text}}>{label}</div>
                            <div style={{fontFamily:SANS,fontSize:8,color:T.dim,fontStyle:"italic"}}>{desc}</div>
                          </div>
                          <span style={{fontFamily:MONO,fontSize:10,color:T.muted}}>{s.total}</span>
                          <span style={{fontFamily:MONO,fontSize:10,fontWeight:700,color:shadowWrColor(s.wr)}}>{s.wr != null ? `${s.wr}%` : "--"}</span>
                          <span style={{fontFamily:MONO,fontSize:10,fontWeight:700,color:shadowPfColor(s.pf)}}>{s.pf != null ? s.pf.toFixed(2) : "--"}</span>
                          <span style={{fontFamily:MONO,fontSize:10,color:s.avgPnl != null ? (s.avgPnl >= 0 ? T.up : T.down) : T.muted}}>{fmtPct(s.avgPnl)}</span>
                          <span style={{fontFamily:MONO,fontSize:10,color:s.bestPnl != null ? T.up : T.muted}}>{fmtPct(s.bestPnl)}</span>
                          <span style={{fontFamily:MONO,fontSize:10,color:s.worstPnl != null ? T.down : T.muted}}>{fmtPct(s.worstPnl)}</span>
                        </div>
                      );
                    })}
                  </div>
                </ScrollX>
              </div>

              {/* Toggle lista completa */}
              <button onClick={()=>setShadowExpanded(e=>!e)} style={{
                width:"100%",padding:"5px 12px",marginTop:6,
                background:T.s2,border:`1px solid ${T.border}`,borderRadius:6,
                cursor:"pointer",fontFamily:SANS,fontSize:10,color:T.muted,
                display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                <span>{shadowExpanded ? "▲ Ocultar lista completa" : "▼ Ver lista completa"}</span>
                <span style={{fontFamily:MONO,fontSize:9,color:T.dim}}>{shadowTrades.length} filas</span>
              </button>

              {shadowExpanded && (
                <ScrollX minWidth={780}>
                  <div style={{marginTop:8,display:"flex",flexDirection:"column",gap:3,maxHeight:400,overflowY:"auto"}}>
                    <div style={{display:"grid",gridTemplateColumns:"80px 100px 50px 70px 70px 70px 100px 70px 70px 28px",gap:6,
                      padding:"4px 8px",fontFamily:SANS,fontSize:8,fontWeight:600,
                      letterSpacing:"0.06em",textTransform:"uppercase",color:T.muted,
                      borderBottom:`1px solid ${T.border}`,position:"sticky",top:0,background:T.s1,zIndex:1}}>
                      <span>Fecha UTC</span><span>Tipo</span><span>Dir</span>
                      <span>Entry</span><span>SL</span><span>TP</span>
                      <span>Perfil</span><span>Status</span><span>PnL %</span>
                      <span></span>
                    </div>
                    {shadowTrades.map(t=>{
                      const fechaStr = (()=>{
                        try {
                          const d = new Date(t.created_at);
                          const dd = d.getUTCDate().toString().padStart(2,"0");
                          const mm = (d.getUTCMonth()+1).toString().padStart(2,"0");
                          const hh = d.getUTCHours().toString().padStart(2,"0");
                          const mi = d.getUTCMinutes().toString().padStart(2,"0");
                          return `${dd}/${mm} ${hh}:${mi}`;
                        } catch { return "--"; }
                      })();
                      const statusColor = t.status==="WIN" ? T.up
                        : t.status==="LOSS" ? T.down
                        : t.status==="OPEN" ? T.wait
                        : T.dim;
                      const pnlColor = t.pnl_pct != null ? (t.pnl_pct >= 0 ? T.up : T.down) : T.muted;
                      return(
                        <div key={t.id} style={{display:"grid",gridTemplateColumns:"80px 100px 50px 70px 70px 70px 100px 70px 70px 28px",gap:6,
                          padding:"5px 8px",borderRadius:5,background:T.s2,alignItems:"center",
                          borderLeft:`3px solid ${statusColor}`}}>
                          <span style={{fontFamily:MONO,fontSize:9,color:T.muted}}>{fechaStr}</span>
                          <span style={{fontFamily:MONO,fontSize:8,color:t.case_type==="d1_blocked"?T.accent:T.gold}}>
                            {t.case_type==="d1_blocked" ? "D1 block" : "Estr ≠"}
                          </span>
                          <span style={{fontFamily:MONO,fontSize:9,fontWeight:700,color:t.direction==="LONG"?T.up:T.down}}>
                            {t.direction==="LONG" ? "▲ L" : "▼ S"}
                          </span>
                          <span style={{fontFamily:MONO,fontSize:9,color:T.text}}>${t.entry_price.toFixed(2)}</span>
                          <span style={{fontFamily:MONO,fontSize:9,color:T.down}}>${t.sl_price.toFixed(2)}</span>
                          <span style={{fontFamily:MONO,fontSize:9,color:T.up}}>${t.tp_price.toFixed(2)}</span>
                          <span style={{fontFamily:MONO,fontSize:8,color:T.dim}}>{t.tp_type}</span>
                          <span style={{fontFamily:MONO,fontSize:9,fontWeight:700,color:statusColor}}>{t.status}</span>
                          <span style={{fontFamily:MONO,fontSize:9,fontWeight:700,color:pnlColor}}>{fmtPct(t.pnl_pct)}</span>
                          <button
                            onClick={()=>copyShadowRow(t)}
                            title="Copiar este perfil"
                            style={{
                              background:"none",
                              border:`1px solid ${shadowRowCopied===t.id?T.upBorder:T.border}`,
                              borderRadius:4,padding:"2px 4px",cursor:"pointer",
                              fontSize:10,color:shadowRowCopied===t.id?T.up:T.muted,lineHeight:1,
                              transition:"all 0.2s"
                          }}>
                          {shadowRowCopied===t.id?"✓":"📋"}
                        </button>
                      </div>
                    );
                  })}
                  </div>
                </ScrollX>
              )}
            </>
          )}
        </Card>

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
            <ScrollX minWidth={900}>
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
            </ScrollX>
          )}
        </Card>

      </div>
      {editingOp&&<EditOperationModal op={editingOp} onClose={()=>setEditingOp(null)} onSave={handleEditSave}/>}
    </div>
  );
}
