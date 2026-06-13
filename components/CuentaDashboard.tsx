"use client";
// components/CuentaDashboard.tsx
// Tab de cuenta: performance, historial completo y reglas de gestión.

import { useState, useEffect, Fragment } from "react";
import { supabaseBrowser } from "@/lib/db/supabase-client";
import { ScrollX } from "@/components/ui";

// ── Auth helper ───────────────────────────────────────────────────────────────
// Obtiene los headers de auth para llamar a las rutas /api/*.
// El access_token viene de la sesión activa de Supabase en el navegador.
// Si no hay sesión, retorna {} y la API responde 401.
//
// FIX TOKEN EXPIRY (08/06/26): mismo fix que LiveTerminal.tsx — chequea
// expires_at proactivamente y refresca con refreshSession() si el token
// está vencido o por vencer en <60s. Sin requests extra cuando el token
// está vigente. Aplica AUTOMÁTICAMENTE a todas las llamadas del dashboard.
async function authHeaders(): Promise<Record<string,string>> {
  let { data: { session } } = await supabaseBrowser.auth.getSession();

  if (session?.expires_at) {
    const expiresInSec = session.expires_at - Math.floor(Date.now() / 1000);
    if (expiresInSec < 60) {
      const { data, error } = await supabaseBrowser.auth.refreshSession();
      if (!error && data.session) session = data.session;
    }
  }

  const token = session?.access_token;
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
  capital_at_signal:   number|null;
  risk_pct_at_signal:  number|null;
}

// Sistema de registro automático de señales emitidas (regla #24).
// Una fila por señal que el motor emitió como veredicto ENTRAR.
// Complementario a ShadowTradeRow (que captura señales rechazadas).
interface SignalEmittedRow {
  id:              string;
  user_id:         string;
  created_at:      string;
  direction:       Direction;
  htf_tf:          "1h"|"4h";
  entry_price:     number;
  sl_price:        number;
  tp_price:        number;
  sl_pct:          number;
  rr_planned:      number;
  score_puro:      number;
  score_ajustado:  number;
  fuerza:          "FUERTE"|"MODERADA";
  htf_sig:         "UP"|"DOWN"|"WAIT";
  mtf_sig:         "UP"|"DOWN"|"WAIT";
  m15_sig:         "UP"|"DOWN"|"WAIT";
  ltf_sig:         "UP"|"DOWN"|"WAIT";
  d1_bias:         "UP"|"DOWN"|"WAIT"|null;
  h4_bias:         "UP"|"DOWN"|"WAIT"|null;
  rsi_at_entry:    number|null;
  atr_at_entry:    number|null;
  ema200_at:       number|null;
  liquidez:        "alta"|"baja"|"weekend";
  session_tag:     "LDN"|"NY"|"CLOSED"|"WEEKEND";
  fvg_active:      boolean;
  structure:       "BULLISH"|"BEARISH"|"NEUTRAL";
  has_news:        boolean;
  status:          "OPEN"|"WIN"|"LOSS"|"EXPIRED";
  result_at:       string|null;
  result_price:    number|null;
  pnl_pct:         number|null;
  r_multiple:      number|null;
  mae_price:       number|null;
  mae_pct:         number|null;
  mfe_price:       number|null;
  mfe_pct:         number|null;
  was_taken:       boolean;
  taken_op_id:     string|null;
  capital_at_signal:   number|null;
  risk_pct_at_signal:  number|null;
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
  const[reglasOpen,setReglasOpen]=useState(false);
  const[copied,setCopied]=useState(false);  // feedback visual del botón "Copiar estadísticas"

  // Shadow Trading state
  const[shadowTrades,setShadowTrades]=useState<ShadowTradeRow[]>([]);
  const[shadowLoading,setShadowLoading]=useState(true);
  const[shadowExpanded,setShadowExpanded]=useState(false);
  const[shadowCopied,setShadowCopied]=useState(false);            // feedback botón global "Copiar shadows"
  const[shadowRowCopied,setShadowRowCopied]=useState<string|null>(null); // id de fila con feedback temporal

  // Signals Emitted state (regla #24)
  const[signals,setSignals]=useState<SignalEmittedRow[]>([]);
  const[signalsLoading,setSignalsLoading]=useState(true);
  const[signalsExpanded,setSignalsExpanded]=useState(false);
  const[signalsCopied,setSignalsCopied]=useState(false);          // feedback botón global "Copiar señales"
  const[signalRowCopied,setSignalRowCopied]=useState<string|null>(null); // feedback fila individual
  const[expandedSignalId,setExpandedSignalId]=useState<string|null>(null); // detalle expandido (MAE/MFE)
  const[updatingTakenId,setUpdatingTakenId]=useState<string|null>(null);   // PATCH en vuelo

  // Fetch shadow trades al montar (endpoint separado)
  useEffect(()=>{
    if(!userId)return;
    setShadowLoading(true);
    authHeaders().then(h=>fetch("/api/shadow-trades?limit=500",{headers:h}))
      .then(r=>r.json()).then(d=>{if(Array.isArray(d))setShadowTrades(d);})
      .catch(console.error).finally(()=>setShadowLoading(false));
  },[userId]);

  // Fetch signals_emitted al montar
  useEffect(()=>{
    if(!userId)return;
    setSignalsLoading(true);
    authHeaders().then(h=>fetch("/api/signals-emitted?limit=500",{headers:h}))
      .then(r=>r.json()).then(d=>{if(Array.isArray(d))setSignals(d);})
      .catch(console.error).finally(()=>setSignalsLoading(false));
  },[userId]);

  // ═══════════════════════════════════════════════════════════════════════════
  // ESTADÍSTICAS PROFESIONALES (actualizado 30/05/26)
  // Win Rate por P&L (estándar industria): TP=WIN, SL=LOSS,
  // MANUAL clasifica por P&L (>0 win, <0 loss, =0 excluido del WR).
  // Métricas: Profit Factor, Expectancy, Avg Win/Loss, Payoff Ratio,
  // Best/Worst Trade, Sharpe Ratio, Max DD, Racha.
  // ═══════════════════════════════════════════════════════════════════════════
  // Performance se calcula desde signals_emitted con snapshot capital + riesgo
  // (Opción B, 10/06/26). El motor se valida por su universo completo de señales
  // (WIN/LOSS). Las ops manuales (tabla xau_usd) fueron eliminadas el 11/06/26.
  // Solo se cuentan filas con snapshot poblado y r_multiple no nulo.
  // signals viene de la API ordenada created_at DESC; revertimos a ASC para DD y racha.
  // ── DOS UNIVERSOS (separación 11/06/26) ──────────────────────────────────
  // El motor se valida por su universo COMPLETO de señales cerradas WIN/LOSS.
  // Métricas en % y R (Win Rate, Profit Factor, Expectancy, Racha, Sharpe) NO
  // necesitan capital → se calculan sobre TODAS las cerradas (pnl_pct/r_multiple
  // existen siempre). Métricas en DÓLARES sí necesitan el snapshot de capital+
  // riesgo → solo sobre las señales con snapshot poblado (Opción B: inventar
  // capital a las pre-snapshot deformaría la historia). Universos separados.

  // Universo MOTOR: todas las cerradas WIN/LOSS con r_multiple (orden ASC para racha/DD)
  type MotorOp = { id: string; r: number; pnlPct: number; resultado: "TP" | "SL" };
  const closedAll: MotorOp[] = signals
    .filter(s => (s.status === "WIN" || s.status === "LOSS") && s.r_multiple != null)
    .map(s => ({
      id: s.id,
      r: s.r_multiple as number,
      pnlPct: s.pnl_pct ?? 0,
      resultado: s.status === "WIN" ? "TP" : "SL",
    } as MotorOp))
    .reverse();

  // Universo DÓLARES: subconjunto con snapshot capital+riesgo (orden ASC para DD $)
  type DollarOp = { id: string; pnl: number; resultado: "TP" | "SL" };
  const closedSnap: DollarOp[] = signals
    .filter(s => (s.status === "WIN" || s.status === "LOSS")
      && s.capital_at_signal != null
      && s.risk_pct_at_signal != null
      && s.r_multiple != null)
    .map(s => {
      const dollarRisk = (s.capital_at_signal as number) * ((s.risk_pct_at_signal as number) / 100);
      return {
        id: s.id,
        pnl: (s.r_multiple as number) * dollarRisk,
        resultado: s.status === "WIN" ? "TP" : "SL",
      } as DollarOp;
    })
    .reverse();

  // ── MÉTRICAS DEL MOTOR (universo completo, en % y R) ─────────────────────
  const winOps  = closedAll.filter(o => o.resultado==="TP");
  const lossOps = closedAll.filter(o => o.resultado==="SL");
  const wins   = winOps.length;
  const losses = lossOps.length;
  const totalContados = wins + losses;
  const wr = totalContados>0 ? Math.round((wins/totalContados)*100) : 0;

  // Profit Factor en R: suma R ganados / |suma R perdidos|
  const sumRWin  = winOps.reduce((a,o)=>a+o.r, 0);
  const sumRLoss = Math.abs(lossOps.reduce((a,o)=>a+o.r, 0));
  const profitFactor = sumRLoss>0 ? sumRWin/sumRLoss : null;

  // Expectancy en R: promedio de r_multiple de todas las cerradas
  const expectancy = totalContados>0
    ? closedAll.reduce((a,o)=>a+o.r, 0)/totalContados
    : null;

  // Avg R en ganadoras / perdedoras (para Payoff Ratio)
  const avgRWin  = wins>0   ? sumRWin/wins   : null;
  const avgRLoss = losses>0 ? sumRLoss/losses : null;
  const rrReal = (avgRWin!=null && avgRLoss!=null && avgRLoss>0) ? avgRWin/avgRLoss : null;

  // ── MÉTRICAS DE CALIDAD sobre R (SQN, Desv R, Sharpe, Sortino) ──────────
  // Se muestran desde n≥2 pero son PRELIMINARES hasta ~30 señales (muestra chica).
  const nR = closedAll.length;
  const meanR = expectancy ?? 0;                       // = expectancy (media de R)
  // Desviación estándar muestral (N-1) de R — base del SQN (es un t-stat)
  const stdR = nR>=2
    ? Math.sqrt(closedAll.reduce((a,o)=>a+Math.pow(o.r-meanR,2),0)/(nR-1))
    : null;
  // SQN = √N × expectancy / desv(R) — calidad del sistema (Van Tharp)
  const sqn = (stdR!=null && stdR>0) ? Math.sqrt(nR)*meanR/stdR : null;
  // Sharpe por trade = expectancy / desv(R) poblacional
  const sdRpop = nR>=2 ? Math.sqrt(closedAll.reduce((a,o)=>a+Math.pow(o.r-meanR,2),0)/nR) : null;
  const sharpe = (sdRpop!=null && sdRpop>0) ? meanR/sdRpop : null;
  // Sortino por trade = expectancy / desviación a la baja (solo R<0, target 0)
  const downsideDev = nR>=2
    ? Math.sqrt(closedAll.reduce((a,o)=>a+(o.r<0?Math.pow(o.r,2):0),0)/nR)
    : null;
  const sortino = (downsideDev!=null && downsideDev>0) ? meanR/downsideDev : null;
  const calidadPrelim = nR < 30;   // bandera muestra chica (SQN/Sharpe/Sortino)

  // Racha actual (sobre universo completo)
  let racha=0;
  let rachaType:"WIN"|"LOSS"|null=null;
  for(let i=closedAll.length-1;i>=0;i--){
    const tipo = closedAll[i].resultado==="TP" ? "WIN" : "LOSS";
    if(i===closedAll.length-1){ rachaType=tipo; racha=1; }
    else if(tipo===rachaType){ racha++; }
    else break;
  }
  const alertaDoblePerdida = rachaType==="LOSS" && racha>=2;

  // ── MÉTRICAS EN DÓLARES (solo señales con snapshot) ──────────────────────
  const snapCount = closedSnap.length;
  const winSnap  = closedSnap.filter(o => o.resultado==="TP");
  const lossSnap = closedSnap.filter(o => o.resultado==="SL");
  const pnlTotal = closedSnap.reduce((a,o)=>a+(o.pnl??0), 0);
  const sumWins   = winSnap.reduce((a,o)=>a+(o.pnl??0), 0);
  const sumLosses = Math.abs(lossSnap.reduce((a,o)=>a+(o.pnl??0), 0));
  const avgWin  = winSnap.length>0  ? sumWins/winSnap.length   : null;
  const avgLoss = lossSnap.length>0 ? sumLosses/lossSnap.length : null;

  const pnls = closedSnap.map(o=>o.pnl??0);
  const bestTrade  = pnls.length>0 ? Math.max(...pnls) : null;
  const worstTrade = pnls.length>0 ? Math.min(...pnls) : null;

  // Max drawdown en dólares (sobre las con snapshot)
  let peak=0,dd=0,maxDD=0,cum=0;
  for(const op of closedSnap){
    cum+=(op.pnl??0);
    if(cum>peak)peak=cum;
    dd=peak-cum;
    if(dd>maxDD)maxDD=dd;
  }

  // Recovery Factor = ganancia neta $ / max drawdown $ (qué tan bien se recupera)
  const recoveryFactor = maxDD>0 ? pnlTotal/maxDD : null;

  // MAE promedio de las GANADORAS (% en contra, direccional desde precios):
  // cuánto "aguante" necesitan las ganadoras antes de funcionar → calibración de SL.
  const winnersMaePct = signals
    .filter(s => s.status==="WIN" && s.mae_price!=null)
    .map(s => {
      const adv = s.direction==="LONG"
        ? (s.entry_price - (s.mae_price as number)) / s.entry_price * 100
        : ((s.mae_price as number) - s.entry_price) / s.entry_price * 100;
      return Math.max(0, adv);
    });
  const maeWinAvg = winnersMaePct.length>0
    ? winnersMaePct.reduce((a,v)=>a+v,0)/winnersMaePct.length
    : null;

  // Helpers de formato
  const fmtNum = (n:number|null, suffix=""):string => n==null?"--":n.toFixed(2)+suffix;
  const fmtMoney = (n:number|null):string => {
    if(n==null) return "--";
    return (n>=0?"+$":"-$")+Math.abs(n).toFixed(0);
  };

  // Métricas del MOTOR en % y R; las en DÓLARES vienen del subconjunto con snapshot (snapCount señales).
  // Detalle de Performance — los titulares (P&L/Expectancy/Win Rate/Payoff Ratio) se arman aparte en el render
  const stats=[
    {l:"Profit Factor", v:fmtNum(profitFactor),                 c:profitFactor==null?T.muted:profitFactor>=1.5?T.up:profitFactor>=1?T.wait:T.down},
    {l:"Wins",     v:`${wins}`,                            c:T.up},
    {l:"Losses",    v:`${losses}`,                          c:T.down},
    {l:"Avg Win $",     v:fmtMoney(avgWin),                     c:avgWin==null?T.muted:T.up},
    {l:"Avg Loss $",    v:avgLoss==null?"--":`-$${avgLoss.toFixed(0)}`, c:avgLoss==null?T.muted:T.down},
    {l:"Best $",        v:fmtMoney(bestTrade),                  c:bestTrade==null?T.muted:bestTrade>=0?T.up:T.down},
    {l:"Worst $",       v:fmtMoney(worstTrade),                 c:worstTrade==null?T.muted:worstTrade>=0?T.up:T.down},
    {l:"Max DD $",      v:snapCount>0?(maxDD>0?`-$${maxDD.toFixed(0)}`:"$0"):"--", c:maxDD>0?T.down:T.muted},
    {l:"Streak",         v:racha>0?`${racha} ${rachaType==="WIN"?"✓":"✗"}`:"--",
     c:rachaType==="WIN"?T.up:rachaType==="LOSS"?T.down:T.muted},
  ];

  // Calidad y riesgo (avanzado) — métricas nuevas. SQN/Sharpe/Sortino preliminares <30.
  const calidadStats=[
    {l:"SQN",             v:sqn==null?"--":sqn.toFixed(2),         c:sqn==null?T.muted:calidadPrelim?T.muted:sqn>=2?T.up:sqn>=1?T.wait:T.down,             sub:sqn==null?"":calidadPrelim?`n=${nR} · prelim.`:"calidad del sistema"},
    {l:"Std Dev (R)",         v:stdR==null?"--":`${stdR.toFixed(2)}R`,  c:T.text,                                                                              sub:"dispersión de R"},
    {l:"Sharpe",          v:sharpe==null?"--":sharpe.toFixed(2),    c:sharpe==null?T.muted:calidadPrelim?T.muted:sharpe>=1?T.up:sharpe>=0?T.wait:T.down,    sub:calidadPrelim?`n=${nR} · prelim.`:""},
    {l:"Sortino",         v:sortino==null?"--":sortino.toFixed(2),  c:sortino==null?T.muted:calidadPrelim?T.muted:sortino>=1?T.up:sortino>=0?T.wait:T.down, sub:"vs Sharpe"},
    {l:"Recovery Factor", v:recoveryFactor==null?"--":recoveryFactor.toFixed(2), c:recoveryFactor==null?T.muted:recoveryFactor>=1?T.up:recoveryFactor>=0.5?T.wait:T.down, sub:"neto / max DD"},
    {l:"Avg MAE (win)",  v:maeWinAvg==null?"--":`${maeWinAvg.toFixed(2)}%`,     c:T.text,                                                                  sub:"aguante de ganadoras"},
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
    // METRICAS EN R (base-R) -- estandar profesional para sistemas de riesgo
    // fijo (1% por trade): Profit Factor y Expectancy se miden en R, no en %
    // de precio. R = pnl_pct / sl_pct = cuanto se gano/perdio en multiplos del
    // riesgo. Solo sobre WIN/LOSS; las EXPIRED quedan afuera (Triple Barrier,
    // igual que el P&L $). Antes PF/Avg iban en % y contradecian al $; ahora
    // todo (PF, Expectancy, Best/Worst $, P&L $) cuenta la misma historia.
    const wlRows = closed.filter(t =>
      (t.status === "WIN" || t.status === "LOSS") && t.sl_pct > 0 && t.pnl_pct != null);
    const rs = wlRows.map(t => (t.pnl_pct as number) / t.sl_pct);
    const expectancyR = rs.length > 0 ? rs.reduce((a,b)=>a+b, 0) / rs.length : null;  // media de R = expectancy (Van Tharp)
    const sumRwin  = rs.filter(r => r > 0).reduce((a,b)=>a+b, 0);
    const sumRloss = Math.abs(rs.filter(r => r < 0).reduce((a,b)=>a+b, 0));
    const pf       = sumRloss > 0 ? sumRwin / sumRloss : null;                        // PF en R = ganancia R bruta / |perdida R bruta|
    // P&L $, Best $ y Worst $: R x riesgo en dolares (capital x risk%). Solo
    // filas WIN/LOSS con snapshot de capital/riesgo valido; pre-snapshot se
    // ignoran. Si ninguna aplica, null.
    const wlSnap = wlRows.filter(t => t.capital_at_signal != null && t.risk_pct_at_signal != null);
    const dollars = wlSnap.map(t => {
      const r = (t.pnl_pct as number) / t.sl_pct;
      const dollarRisk = (t.capital_at_signal as number) * ((t.risk_pct_at_signal as number) / 100);
      return r * dollarRisk;
    });
    const pnlDollar   = dollars.length > 0 ? dollars.reduce((a,b)=>a+b, 0) : null;
    const bestDollar  = dollars.length > 0 ? Math.max(...dollars) : null;
    const worstDollar = dollars.length > 0 ? Math.min(...dollars) : null;
    return { total:rows.length, closed:closed.length, open:rows.length-closed.length,
             wins, losses, expired, ofrr, wr, pf, expectancyR, bestDollar, worstDollar, pnlDollar };
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
  // Formateadores R y $ (las metricas del shadow ahora viven en base-R / dolares)
  const fmtR = (r:number|null): string =>
    r == null ? "--" : (r >= 0 ? "+" : "") + r.toFixed(2) + "R";
  const fmtDollar = (d:number|null): string =>
    d == null ? "--" : (d >= 0 ? "+" : "-") + "$" + Math.abs(d).toFixed(0);

  // Base capital/riesgo del shadow — leída del snapshot REAL de las filas
  // (NO hardcodeada). Si todas las filas con snapshot comparten la misma
  // base, la muestra ("base $10K · 1%"); si varían, "base mixta"; si
  // ninguna tiene snapshot, null (no se muestra el chip). Así el chip
  // nunca miente si cambia el capital/riesgo a futuro.
  const shadowBaseLabel: string|null = (()=>{
    const snap = shadowTrades.filter(t => t.capital_at_signal != null && t.risk_pct_at_signal != null);
    if (snap.length === 0) return null;
    const pairs = new Set(snap.map(t => `${t.capital_at_signal}|${t.risk_pct_at_signal}`));
    if (pairs.size > 1) return "base mixta";
    const cap  = snap[0].capital_at_signal as number;
    const risk = snap[0].risk_pct_at_signal as number;
    const capStr = cap >= 1000 ? `$${(cap/1000).toFixed(cap % 1000 === 0 ? 0 : 1)}K` : `$${cap.toFixed(0)}`;
    return `base ${capStr} · ${risk}%`;
  })();

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
      "📊 RENDIMIENTO DEL MOTOR (universo completo)",
      `  Win Rate:       ${totalContados>0?`${wr}% (${wins}W / ${losses}L · ${totalContados} cerradas)`:"--"}`,
      `  Profit Factor:  ${fmtNum(profitFactor)}${profitFactor!=null?(profitFactor>=1.5?" ✓ profesional":profitFactor>=1?" ⚠ marginal":" ✗ pierde"):""}`,
      `  Expectancy:     ${expectancy==null?"--":`${expectancy>=0?"+":""}${expectancy.toFixed(2)}R/trade`}`,
      `  Payoff Ratio:   ${fmtNum(rrReal)}`,
      `  Streak:         ${racha>0?`${racha} ${rachaType==="WIN"?"✓":"✗"}`:"--"}${alertaDoblePerdida?"  ⚠️ 2+ LOSS seguidas":""}`,
      "",
      `📐 CALIDAD Y RIESGO${calidadPrelim?"  (preliminar hasta ~30 señales)":""}`,
      `  SQN:             ${sqn==null?"--":sqn.toFixed(2)}${calidadPrelim&&sqn!=null?`  (n=${nR}, preliminar)`:""}`,
      `  Std Dev (R):     ${stdR==null?"--":`${stdR.toFixed(2)}R`}`,
      `  Sharpe:          ${sharpe==null?"--":sharpe.toFixed(2)}`,
      `  Sortino:         ${sortino==null?"--":sortino.toFixed(2)}`,
      `  Recovery Factor: ${recoveryFactor==null?"--":recoveryFactor.toFixed(2)}`,
      `  Avg MAE (win):   ${maeWinAvg==null?"--":`${maeWinAvg.toFixed(2)}%`}`,
      "",
      `💵 DÓLARES (${snapCount} señal${snapCount===1?"":"es"} con snapshot capital+riesgo)`,
      snapCount>0
        ? `  P&L Total:      ${fmtMoney(pnlTotal)}`
        : `  P&L Total:      -- (señales viejas sin snapshot, se pueblan al cerrar nuevas)`,
      `  Avg Win:        ${fmtMoney(avgWin)}  ·  Avg Loss:  ${avgLoss==null?"--":`-$${avgLoss.toFixed(0)}`}`,
      `  Best:           ${fmtMoney(bestTrade)}  ·  Worst:  ${fmtMoney(worstTrade)}`,
      `  Max DD:         ${snapCount>0?(maxDD>0?`-$${maxDD.toFixed(0)}`:"$0"):"--"}`,
      "",
      "📉 SEÑALES",
      `  Total:          ${signals.length}  ·  Abiertas: ${signals.filter(s=>s.status==="OPEN").length}  ·  Cerradas: ${totalContados}`,
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
          const dd = d.getDate().toString().padStart(2,"0");
          const mm = (d.getMonth()+1).toString().padStart(2,"0");
          const hh = d.getHours().toString().padStart(2,"0");
          const mi = d.getMinutes().toString().padStart(2,"0");
          return `${dd}/${mm} ${hh}:${mi} COL`;
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
        const dd = d.getDate().toString().padStart(2,"0");
        const mm = (d.getMonth()+1).toString().padStart(2,"0");
        const hh = d.getHours().toString().padStart(2,"0");
        const mi = d.getMinutes().toString().padStart(2,"0");
        return `${dd}/${mm} ${hh}:${mi} COL`;
      }catch{return "--";}
    })();
    const caso = t.case_type==="d1_blocked" ? "D1 bloqueó" : "Estructura contradice";
    const liqStr = t.liquidez ? `liq. ${t.liquidez}` : "liq. ?";

    const text = [
      `🌒 Shadow trade (1 perfil)`,
      `${fechaUtc} · ${caso} · ${t.direction}`,
      `Score puro: ${t.score_puro} · Score ajustado: ${t.score_ajustado} (${liqStr})`,
      `RSI: ${t.rsi_at_entry!=null?t.rsi_at_entry.toFixed(0):"--"} · ATR: ${t.atr_at_entry!=null?t.atr_at_entry.toFixed(2):"--"} · D1 bias: ${t.d1_bias||"--"}`,
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

  // ── Signals Emitted: cálculo de las 5 stats ───────────────────────────────
  // Win Rate, Profit Factor, Expectancy, R-multiple promedio, Capture Ratio.
  // Solo se computan con signals CERRADAS (status != OPEN). Si no hay
  // suficiente data, las stats devuelven null (la UI muestra "--").
  function calcSignalsStats(rows: SignalEmittedRow[]) {
    const closed = rows.filter(s => s.status !== "OPEN");
    const wins   = closed.filter(s => s.status === "WIN");
    const losses = closed.filter(s => s.status === "LOSS");
    const total  = closed.length;

    // Win Rate: estándar industria → wins / (wins+losses), expired excluidos
    const wrBase = wins.length + losses.length;
    const winRate = wrBase > 0 ? (wins.length / wrBase) * 100 : null;

    // Profit Factor: suma de pnl_pct positivos / abs(suma de pnl_pct negativos)
    let grossWin = 0, grossLoss = 0;
    for (const s of closed) {
      const p = s.pnl_pct ?? 0;
      if (p > 0) grossWin  += p;
      if (p < 0) grossLoss += Math.abs(p);
    }
    const profitFactor = grossLoss > 0
      ? grossWin / grossLoss
      : (grossWin > 0 ? Infinity : null);

    // Expectancy y R-multiple avg: promedio de r_multiple (incluye expired)
    const withR = closed.filter(s => s.r_multiple !== null);
    const expectancy = withR.length > 0
      ? withR.reduce((acc, s) => acc + (s.r_multiple ?? 0), 0) / withR.length
      : null;
    const rMultipleAvg = expectancy; // Mismo cálculo, mostrar en 2 formatos

    // Capture Ratio: % del MFE capturado en los WIN (cuánto del movimiento aprovechó)
    const winsWithMfe = wins.filter(s => (s.mfe_pct ?? 0) > 0 && (s.pnl_pct ?? 0) > 0);
    const captureRatio = winsWithMfe.length > 0
      ? winsWithMfe.reduce((acc, s) => acc + ((s.pnl_pct ?? 0) / (s.mfe_pct ?? 1)), 0) / winsWithMfe.length * 100
      : null;

    return { total, wins: wins.length, losses: losses.length, winRate, profitFactor, expectancy, rMultipleAvg, captureRatio };
  }

  // ── Copy señales (todas las del usuario, agrupadas por fecha desc) ─────────
  // Contexto del setup de una señal (para los copies): RSI/ATR/sesión/estructura/bias/noticia
  function signalContextLine(s:SignalEmittedRow):string {
    const rsi  = s.rsi_at_entry!=null ? s.rsi_at_entry.toFixed(0) : "--";
    const atr  = s.atr_at_entry!=null ? s.atr_at_entry.toFixed(2) : "--";
    const estr = s.structure==="BULLISH"?"alcista":s.structure==="BEARISH"?"bajista":"neutral";
    const d1   = s.d1_bias ?? "--";
    const h4   = s.h4_bias ?? "--";
    return `RSI ${rsi} · ATR ${atr} · ${s.session_tag}/${s.liquidez} · estructura ${estr} · D1 ${d1} · H4 ${h4}${s.has_news?" · ⚠ NOTICIA":""}`;
  }

  const copySignalsAll = async()=>{
    if (signals.length === 0) return;
    const lines: string[] = [];
    lines.push("☀️ Señales Emitidas — TP3 motor (regla #24)");
    lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━");
    lines.push(`Total: ${signals.length} · Tomadas: ${signals.filter(s=>s.was_taken).length}`);
    lines.push("");

    for (const s of signals) {
      const fechaUtc = (()=>{
        try{
          const d = new Date(s.created_at);
          const dd = d.getDate().toString().padStart(2,"0");
          const mm = (d.getMonth()+1).toString().padStart(2,"0");
          const hh = d.getHours().toString().padStart(2,"0");
          const mi = d.getMinutes().toString().padStart(2,"0");
          return `${dd}/${mm} ${hh}:${mi} COL`;
        }catch{return "--";}
      })();
      const pnlStr = s.pnl_pct !== null ? `${s.pnl_pct >= 0 ? "+" : ""}${s.pnl_pct.toFixed(2)}%` : "OPEN";
      const rStr = s.r_multiple !== null ? `R=${s.r_multiple >= 0 ? "+" : ""}${s.r_multiple.toFixed(2)}` : "R=?";
      const tomada = s.was_taken ? "☑" : "☐";

      lines.push(`${fechaUtc} · ${s.direction} ${s.fuerza} · ${s.htf_tf.toUpperCase()} · score ${s.score_puro}/10 (aj: ${s.score_ajustado})`);
      lines.push(`  Entry $${s.entry_price.toFixed(2)} · SL $${s.sl_price.toFixed(2)} · TP $${s.tp_price.toFixed(2)} · R:R ${s.rr_planned.toFixed(2)}`);
      lines.push(`  Status: ${s.status} · P&L: ${pnlStr} · ${rStr} · Tomada: ${tomada}`);
      lines.push(`  ${signalContextLine(s)}`);
      if (s.mae_price !== null || s.mfe_price !== null) {
        const maeStr = s.mae_pct !== null ? `${s.mae_pct.toFixed(2)}%` : "?";
        const mfeStr = s.mfe_pct !== null ? `${s.mfe_pct.toFixed(2)}%` : "?";
        lines.push(`  MAE ${maeStr} · MFE ${mfeStr}`);
      }
      lines.push("");
    }
    lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━");

    try{
      await navigator.clipboard.writeText(lines.join("\n"));
      setSignalsCopied(true);
      setTimeout(()=>setSignalsCopied(false), 2000);
    }catch{
      // fallback silencioso
    }
  };

  // ── Copy señal individual ──
  const copySignalRow = async(s:SignalEmittedRow)=>{
    const fechaUtc = (()=>{
      try{
        const d = new Date(s.created_at);
        const dd = d.getDate().toString().padStart(2,"0");
        const mm = (d.getMonth()+1).toString().padStart(2,"0");
        const hh = d.getHours().toString().padStart(2,"0");
        const mi = d.getMinutes().toString().padStart(2,"0");
        return `${dd}/${mm} ${hh}:${mi} COL`;
      }catch{return "--";}
    })();
    const pnlStr = s.pnl_pct !== null ? `${s.pnl_pct >= 0 ? "+" : ""}${s.pnl_pct.toFixed(2)}%` : "OPEN";
    const rStr = s.r_multiple !== null ? `R=${s.r_multiple >= 0 ? "+" : ""}${s.r_multiple.toFixed(2)}` : "R=?";
    const maeStr = s.mae_pct !== null ? `${s.mae_pct.toFixed(2)}%` : "--";
    const mfeStr = s.mfe_pct !== null ? `${s.mfe_pct.toFixed(2)}%` : "--";
    const tomada = s.was_taken ? "☑ Sí" : "☐ No";

    const text = [
      `☀️ Señal emitida (TP3 motor)`,
      `${fechaUtc} · ${s.direction} ${s.fuerza} · ${s.htf_tf.toUpperCase()}`,
      `Score puro ${s.score_puro}/10 · ajustado ${s.score_ajustado}`,
      `Entry $${s.entry_price.toFixed(2)} · SL $${s.sl_price.toFixed(2)} · TP $${s.tp_price.toFixed(2)} · R:R ${s.rr_planned.toFixed(2)}`,
      `Status: ${s.status} · P&L: ${pnlStr} · ${rStr}`,
      `${signalContextLine(s)}`,
      `MAE: ${maeStr} · MFE: ${mfeStr}`,
      `Tomada: ${tomada}`,
    ].join("\n");

    try{
      await navigator.clipboard.writeText(text);
      setSignalRowCopied(s.id);
      setTimeout(()=>setSignalRowCopied(prev => prev===s.id ? null : prev), 1500);
    }catch{
      // fallback silencioso
    }
  };

  // ── Toggle was_taken con PATCH al API (optimistic update) ─────────────────
  const toggleWasTaken = async(sig: SignalEmittedRow) => {
    if (updatingTakenId === sig.id) return;
    setUpdatingTakenId(sig.id);
    const prevVal = sig.was_taken;
    const newVal  = !prevVal;

    // Optimistic update local
    setSignals(prev => prev.map(s => s.id === sig.id ? {...s, was_taken: newVal} : s));

    try {
      const headers = await authHeaders();
      const res = await fetch("/api/signals-emitted", {
        method:  "PATCH",
        headers: { "Content-Type": "application/json", ...headers },
        body:    JSON.stringify({ id: sig.id, was_taken: newVal }),
      });
      if (!res.ok) {
        // Revert
        setSignals(prev => prev.map(s => s.id === sig.id ? {...s, was_taken: prevVal} : s));
      }
    } catch {
      // Revert silencioso
      setSignals(prev => prev.map(s => s.id === sig.id ? {...s, was_taken: prevVal} : s));
    } finally {
      setUpdatingTakenId(null);
    }
  };

  // Reglas de gestión (actualizado 30/05/26)
  // - Eliminada "Máx 2 ops por sesión" (decisión del usuario, depende de capital)
  // - "2 SL seguidos" pasa a advertencia visual (no obligación absoluta)
  // - Sesión actualizada: ya no es gate, solo afecta liquidez (+1/−2 score)
  // - Aclaración: el toggle "Sin noticia" es manual del usuario
  // - Veredicto ENTRAR del motor reemplaza "6 condiciones verde"
  const reglas=[
    {icn:"🧭",txt:"3 capas — la señal pasa las tres en orden o no sale"},
    {icn:"1️⃣",txt:"Ancla: dirección en 1H + 15M. FUERTE si coinciden, MODERADA si 15M en espera"},
    {icn:"2️⃣",txt:"Gates (las 4 deben pasar): mercado abierto · D1 a favor · R:R ≥ 2 · sin noticia"},
    {icn:"3️⃣",txt:"Score ≥ 6: suman marcos / EMA200 / RSI 30-70 / estructura / FVG · resta 4H en contra · liquidez ±"},
    {icn:"🎯",txt:"TP/SL: SL = swing más cercano (tope 0.75%) · TP = nivel real (PDH/PDL, swings, pivotes) con R:R 2–5"},
  ];

  return(
    <div style={{background:T.bg,minHeight:"100%",padding:"16px 16px calc(16px + env(safe-area-inset-bottom)) 16px",overflowY:"auto"}}>
      <div style={{maxWidth:1100,margin:"0 auto",display:"flex",flexDirection:"column",gap:14}}>

        {/* Cómo decide el motor — colapsable */}
        <div style={{position:"relative"}}>
          <button
            onClick={()=>setReglasOpen(o=>!o)}
            style={{width:"100%",display:"flex",alignItems:"center",gap:8,padding:"5px 12px",
              borderRadius:7,background:T.s1,border:`1px solid ${T.border}`,cursor:"pointer",
              fontFamily:SANS,fontSize:10,color:T.muted,textAlign:"left"}}>
            <span style={{color:T.gold,fontWeight:700}}>Cómo decide el motor</span>
            <span>Ancla → Gates → Score ≥ 6 · R:R 2–5</span>
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

        {/* ── Señales Abiertas — héroe: posiciones vivas del motor ──────────── */}
        <Card style={{border:`1px solid ${T.border2}`,borderRadius:12}}>
          {(() => {
            const open = signals.filter(s => s.status === "OPEN");
            return <>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10,gap:8,flexWrap:"wrap"}}>
                <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                  <div style={{fontFamily:SANS,fontSize:13,fontWeight:700,letterSpacing:"0.08em",textTransform:"uppercase",color:T.text}}>🔵 Señales Abiertas</div>
                  <span style={{fontFamily:SANS,fontSize:9,color:T.dim,fontStyle:"italic"}}>lo que el motor tiene vivo ahora</span>
                </div>
                {open.length > 0 && (
                  <span style={{fontFamily:MONO,fontSize:10,color:T.muted,background:T.s2,border:`1px solid ${T.border}`,borderRadius:20,padding:"3px 10px"}}>
                    {open.length} abierta{open.length===1?"":"s"}
                  </span>
                )}
              </div>

              {signalsLoading ? (
                <div style={{fontFamily:MONO,fontSize:11,color:T.muted,padding:"10px 0"}}>Cargando…</div>
              ) : open.length === 0 ? (
                <div style={{display:"flex",alignItems:"center",gap:10,background:T.s2,border:`1px solid ${T.border}`,borderRadius:10,padding:"14px"}}>
                  <span style={{width:8,height:8,borderRadius:"50%",background:T.muted,opacity:0.5}} />
                  <span style={{fontFamily:MONO,fontSize:11,color:T.muted}}>El motor no tiene posiciones vivas ahora.</span>
                </div>
              ) : (
                <div style={{display:"flex",flexDirection:"column",gap:10}}>
                  {open.map(s => {
                    const isLong = s.direction === "LONG";
                    const entry  = s.entry_price;
                    const slDistPct = s.sl_pct;                    // % entry→SL
                    const tpDistPct = s.sl_pct * s.rr_planned;     // % entry→TP
                    const span = slDistPct + tpDistPct;
                    const entryPos = span > 0 ? (slDistPct / span) * 100 : 50;
                    // excursión a favor / en contra, DIRECCIONAL, desde precios reales
                    const favPct = s.mfe_price != null
                      ? (isLong ? (s.mfe_price - entry) : (entry - s.mfe_price)) / entry * 100 : null;
                    const advPct = s.mae_price != null
                      ? (isLong ? (entry - s.mae_price) : (s.mae_price - entry)) / entry * 100 : null;
                    const mfePos = (favPct != null && span > 0) ? Math.min(100, entryPos + Math.max(0, favPct) / span * 100) : entryPos;
                    const maePos = (advPct != null && span > 0) ? Math.max(0, entryPos - Math.max(0, advPct) / span * 100) : entryPos;
                    const showFav = (favPct ?? -Infinity) >= (advPct ?? -Infinity);
                    const horas = (() => {
                      try {
                        const ms = Date.now() - new Date(s.created_at).getTime();
                        const h = Math.floor(ms / 3600000);
                        const mi = Math.floor((ms % 3600000) / 60000);
                        if (h >= 24) return `${Math.floor(h/24)}d ${h%24}h`;
                        if (h >= 1)  return `${h}h`;
                        return `${mi}m`;
                      } catch { return "--"; }
                    })();
                    const dirColor  = isLong ? T.up : T.down;
                    const dirBg     = isLong ? T.upBg : T.dnBg;
                    const dirBorder = isLong ? T.upBorder : T.dnBorder;
                    const hasBar = favPct != null || advPct != null;
                    return (
                      <div key={s.id} style={{background:T.s2,border:`1px solid ${T.border}`,borderRadius:10,padding:"12px 14px"}}>
                        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,flexWrap:"wrap",marginBottom:hasBar?10:0}}>
                          <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                            <span style={{fontFamily:MONO,fontSize:12,fontWeight:700,letterSpacing:"0.05em",color:dirColor,background:dirBg,border:`1px solid ${dirBorder}`,borderRadius:6,padding:"3px 9px"}}>{s.direction}</span>
                            <span style={{fontFamily:MONO,fontSize:10,color:T.muted,display:"flex",gap:12,flexWrap:"wrap"}}>
                              <span><span style={{color:T.text,fontWeight:600}}>Entry</span> {entry.toFixed(2)}</span>
                              <span style={{color:T.down}}>SL {s.sl_price.toFixed(2)}</span>
                              <span style={{color:T.up}}>TP {s.tp_price.toFixed(2)}</span>
                            </span>
                          </div>
                          <span style={{fontFamily:MONO,fontSize:10,color:T.muted,display:"flex",gap:12,flexWrap:"wrap"}}>
                            <span>Score <span style={{color:T.text,fontWeight:600}}>{s.score_ajustado}</span></span>
                            <span>R:R <span style={{color:T.text,fontWeight:600}}>{s.rr_planned.toFixed(1)}</span></span>
                            <span><span style={{color:T.text,fontWeight:600}}>{horas}</span> abierta</span>
                          </span>
                        </div>
                        {hasBar && (
                          <>
                            <div style={{position:"relative",height:34}}>
                              <div style={{position:"absolute",top:6,width:1,height:20,background:T.dim,left:"0%"}} />
                              <div style={{position:"absolute",top:0,fontFamily:MONO,fontSize:8,color:T.muted,left:"0%"}}>SL</div>
                              <div style={{position:"absolute",top:6,width:1,height:20,background:T.dim,left:`${entryPos}%`}} />
                              <div style={{position:"absolute",top:0,fontFamily:MONO,fontSize:8,color:T.muted,left:`${entryPos}%`,transform:"translateX(-50%)"}}>Entry</div>
                              <div style={{position:"absolute",top:6,width:1,height:20,background:T.dim,left:"100%"}} />
                              <div style={{position:"absolute",top:0,fontFamily:MONO,fontSize:8,color:T.muted,left:"100%",transform:"translateX(-100%)"}}>TP</div>
                              <div style={{position:"absolute",top:13,left:0,right:0,height:6,background:T.s3,borderRadius:3}} />
                              {showFav
                                ? <div style={{position:"absolute",top:13,height:6,borderRadius:3,background:T.up,left:`${entryPos}%`,width:`${Math.max(0, mfePos-entryPos)}%`}} />
                                : <div style={{position:"absolute",top:13,height:6,borderRadius:3,background:T.down,left:`${maePos}%`,width:`${Math.max(0, entryPos-maePos)}%`}} />}
                            </div>
                            <div style={{fontFamily:MONO,fontSize:10,marginTop:6}}>
                              {showFav
                                ? <><span style={{color:T.up}}>+{Math.max(0, favPct ?? 0).toFixed(1)}% a favor</span> <span style={{color:T.muted}}>(MFE)</span></>
                                : <><span style={{color:T.down}}>-{Math.max(0, advPct ?? 0).toFixed(1)}% en contra</span> <span style={{color:T.muted}}>(MAE)</span></>}
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>;
          })()}
        </Card>

        {/* ── Señales Emitidas — captura motor (regla #24) ──────────────────── */}
        <Card>
          {(() => {
            const stats        = calcSignalsStats(signals);
            const takenCount   = signals.filter(s => s.was_taken).length;
            const takeRatePct  = signals.length > 0 ? (takenCount / signals.length) * 100 : 0;
            const openCount    = signals.filter(s => s.status === "OPEN").length;

            return <>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10,gap:8,flexWrap:"wrap"}}>
                <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                  <div style={{fontFamily:SANS,fontSize:11,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:T.muted}}>☀️ Señales Emitidas</div>
                  <span style={{fontFamily:SANS,fontSize:9,color:T.dim,fontStyle:"italic"}}>
                    señales que el motor emitió como ENTRAR — empíricas
                  </span>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontFamily:MONO,fontSize:9,color:T.muted}}>
                    {signals.length} total · {takenCount} tomadas ({takeRatePct.toFixed(0)}%) · {openCount} abiertas
                  </span>
                  <button
                    onClick={copySignalsAll}
                    disabled={signals.length===0}
                    style={{
                      background:signalsCopied?T.upBg:T.s2,
                      border:`1px solid ${signalsCopied?T.upBorder:T.border2}`,
                      borderRadius:6,padding:"5px 10px",
                      cursor:signals.length>0?"pointer":"not-allowed",
                      fontFamily:SANS,fontSize:10,fontWeight:600,
                      color:signalsCopied?T.up:T.muted,
                      opacity:signals.length>0?1:0.4,
                      transition:"all 0.2s"
                    }}>
                    {signalsCopied?"✓ Copiado":"📋 Copiar señales"}
                  </button>
                </div>
              </div>

              {signalsLoading ? (
                <div style={{fontFamily:MONO,fontSize:11,color:T.muted,padding:"10px 0"}}>Cargando…</div>
              ) : signals.length === 0 ? (
                <div style={{fontFamily:MONO,fontSize:11,color:T.muted,padding:"10px 0",fontStyle:"italic"}}>
                  Sin señales registradas todavía. El motor las captura automáticamente cuando emite veredicto ENTRAR.
                </div>
              ) : (
                <>
                  {/* Toggle expandir tabla */}
                  <button onClick={()=>setSignalsExpanded(e=>!e)} style={{
                    width:"100%",display:"flex",alignItems:"center",gap:6,padding:"5px 8px",
                    borderRadius:5,background:T.s2,border:`1px solid ${T.border}`,cursor:"pointer",
                    fontFamily:SANS,fontSize:10,color:T.muted,textAlign:"left",marginBottom:signalsExpanded?12:0
                  }}>
                    <span style={{flex:1}}>
                      {signalsExpanded ? "Ocultar lista de señales" : `Ver lista completa de señales (${stats.total} cerradas · ${openCount} abiertas)`}
                    </span>
                    <span style={{fontSize:9}}>{signalsExpanded?"▲":"▼"}</span>
                  </button>

                  {/* Tabla con scroll horizontal — visible solo expandida */}
                  {signalsExpanded && (
                    <ScrollX minWidth={840}>
                      <table style={{width:"100%",borderCollapse:"collapse",fontFamily:MONO,fontSize:10}}>
                        <thead>
                          <tr style={{borderBottom:`1px solid ${T.border}`,color:T.muted}}>
                            <th style={{textAlign:"left",padding:"6px 8px",fontWeight:600}}>Fecha</th>
                            <th style={{textAlign:"left",padding:"6px 8px",fontWeight:600}}>Dir</th>
                            <th style={{textAlign:"right",padding:"6px 8px",fontWeight:600}}>Entry</th>
                            <th style={{textAlign:"right",padding:"6px 8px",fontWeight:600}}>SL</th>
                            <th style={{textAlign:"right",padding:"6px 8px",fontWeight:600}}>TP</th>
                            <th style={{textAlign:"right",padding:"6px 8px",fontWeight:600}}>Score</th>
                            <th style={{textAlign:"center",padding:"6px 8px",fontWeight:600}}>Status</th>
                            <th style={{textAlign:"right",padding:"6px 8px",fontWeight:600}}>P&L</th>
                            <th style={{textAlign:"right",padding:"6px 8px",fontWeight:600}}>R</th>
                            <th style={{textAlign:"center",padding:"6px 8px",fontWeight:600}}>Tomada</th>
                            <th style={{textAlign:"center",padding:"6px 8px",fontWeight:600}}></th>
                          </tr>
                        </thead>
                        <tbody>
                          {signals.map(s => {
                            const fecha = (()=>{
                              try{
                                const d = new Date(s.created_at);
                                const dd = d.getDate().toString().padStart(2,"0");
                                const mm = (d.getMonth()+1).toString().padStart(2,"0");
                                const hh = d.getHours().toString().padStart(2,"0");
                                const mi = d.getMinutes().toString().padStart(2,"0");
                                return `${dd}/${mm} ${hh}:${mi}`;
                              }catch{return "--";}
                            })();
                            const dirColor = s.direction === "LONG" ? T.up : T.down;
                            const pnlColor = s.pnl_pct === null ? T.muted : s.pnl_pct >= 0 ? T.up : T.down;
                            const rColor   = s.r_multiple === null ? T.muted : s.r_multiple >= 0 ? T.up : T.down;
                            const statusColor =
                              s.status === "WIN"     ? T.up
                            : s.status === "LOSS"    ? T.down
                            : s.status === "EXPIRED" ? T.gold
                            :                          T.muted;
                            const isExpanded = expandedSignalId === s.id;
                            const rowCopied  = signalRowCopied === s.id;
                            const isUpdating = updatingTakenId === s.id;

                            return <Fragment key={s.id}>
                              <tr
                                style={{
                                  borderBottom:`1px solid ${T.border2}`,
                                  cursor:"pointer",
                                  background:isExpanded ? T.s2 : "transparent",
                                  transition:"background 0.15s",
                                }}
                                onClick={()=>setExpandedSignalId(prev => prev === s.id ? null : s.id)}
                              >
                                <td style={{padding:"6px 8px",color:T.text,whiteSpace:"nowrap"}}>{fecha}</td>
                                <td style={{padding:"6px 8px",color:dirColor,fontWeight:700}}>{s.direction}</td>
                                <td style={{padding:"6px 8px",textAlign:"right",color:T.text}}>${s.entry_price.toFixed(2)}</td>
                                <td style={{padding:"6px 8px",textAlign:"right",color:T.muted}}>${s.sl_price.toFixed(2)}</td>
                                <td style={{padding:"6px 8px",textAlign:"right",color:T.muted}}>${s.tp_price.toFixed(2)}</td>
                                <td style={{padding:"6px 8px",textAlign:"right",color:T.text}}>{s.score_puro}/10</td>
                                <td style={{padding:"6px 8px",textAlign:"center",color:statusColor,fontWeight:600}}>{s.status}</td>
                                <td style={{padding:"6px 8px",textAlign:"right",color:pnlColor}}>
                                  {s.pnl_pct === null ? "--" : `${s.pnl_pct >= 0 ? "+" : ""}${s.pnl_pct.toFixed(2)}%`}
                                </td>
                                <td style={{padding:"6px 8px",textAlign:"right",color:rColor}}>
                                  {s.r_multiple === null ? "--" : `${s.r_multiple >= 0 ? "+" : ""}${s.r_multiple.toFixed(2)}`}
                                </td>
                                <td style={{padding:"6px 8px",textAlign:"center"}}>
                                  <button
                                    onClick={(e)=>{e.stopPropagation(); toggleWasTaken(s);}}
                                    disabled={isUpdating}
                                    style={{
                                      background:"transparent",
                                      border:"none",
                                      cursor:isUpdating ? "wait" : "pointer",
                                      fontSize:13,
                                      color:s.was_taken ? T.up : T.muted,
                                      opacity:isUpdating ? 0.4 : 1,
                                      padding:0,
                                    }}
                                    title={s.was_taken ? "Marcada como TOMADA — click para desmarcar" : "Click para marcar como tomada"}
                                  >
                                    {s.was_taken ? "☑" : "☐"}
                                  </button>
                                </td>
                                <td style={{padding:"6px 8px",textAlign:"center"}}>
                                  <button
                                    onClick={(e)=>{e.stopPropagation(); copySignalRow(s);}}
                                    style={{
                                      background:rowCopied ? T.upBg : "transparent",
                                      border:`1px solid ${rowCopied ? T.upBorder : T.border2}`,
                                      borderRadius:4,
                                      cursor:"pointer",
                                      padding:"2px 6px",
                                      fontSize:10,
                                      color:rowCopied ? T.up : T.muted,
                                      transition:"all 0.15s",
                                    }}
                                    title="Copiar señal individual"
                                  >
                                    {rowCopied ? "✓" : "📋"}
                                  </button>
                                </td>
                              </tr>
                              {isExpanded && (
                                <tr style={{background:T.s2}}>
                                  <td colSpan={11} style={{padding:"8px 12px",borderBottom:`1px solid ${T.border2}`}}>
                                    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(160px, 1fr))",gap:8,fontSize:10}}>
                                      <div>
                                        <div style={{color:T.dim,marginBottom:2}}>MAE (peor en contra)</div>
                                        <div style={{color:T.down,fontWeight:600}}>
                                          {s.mae_price === null ? "--" : `$${s.mae_price.toFixed(2)} (${s.mae_pct !== null ? `${s.mae_pct.toFixed(2)}%` : "--"})`}
                                        </div>
                                      </div>
                                      <div>
                                        <div style={{color:T.dim,marginBottom:2}}>MFE (mejor a favor)</div>
                                        <div style={{color:T.up,fontWeight:600}}>
                                          {s.mfe_price === null ? "--" : `$${s.mfe_price.toFixed(2)} (${s.mfe_pct !== null ? `${s.mfe_pct.toFixed(2)}%` : "--"})`}
                                        </div>
                                      </div>
                                      <div>
                                        <div style={{color:T.dim,marginBottom:2}}>R:R planeado</div>
                                        <div style={{color:T.text,fontWeight:600}}>{s.rr_planned.toFixed(2)}</div>
                                      </div>
                                      <div>
                                        <div style={{color:T.dim,marginBottom:2}}>Score ajustado · liquidez</div>
                                        <div style={{color:T.text,fontWeight:600}}>
                                          {s.score_ajustado} · {s.liquidez}
                                        </div>
                                      </div>
                                      <div>
                                        <div style={{color:T.dim,marginBottom:2}}>Fuerza · htf_tf</div>
                                        <div style={{color:T.text,fontWeight:600}}>{s.fuerza} · {s.htf_tf}</div>
                                      </div>
                                      <div>
                                        <div style={{color:T.dim,marginBottom:2}}>TFs (htf/mtf/m15/ltf)</div>
                                        <div style={{color:T.text,fontWeight:600}}>{s.htf_sig}/{s.mtf_sig}/{s.m15_sig}/{s.ltf_sig}</div>
                                      </div>
                                      {s.rsi_at_entry !== null && (
                                        <div>
                                          <div style={{color:T.dim,marginBottom:2}}>RSI · ATR @ entry</div>
                                          <div style={{color:T.text,fontWeight:600}}>{s.rsi_at_entry.toFixed(1)} · {s.atr_at_entry !== null ? s.atr_at_entry.toFixed(1) : "--"}</div>
                                        </div>
                                      )}
                                      <div>
                                        <div style={{color:T.dim,marginBottom:2}}>Session · FVG · Noticia</div>
                                        <div style={{color:T.text,fontWeight:600}}>
                                          {s.session_tag} · {s.fvg_active ? "✓" : "✗"} · {s.has_news ? "✓" : "✗"}
                                        </div>
                                      </div>
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </Fragment>;
                          })}
                        </tbody>
                      </table>
                    </ScrollX>
                  )}
                </>
              )}
            </>;
          })()}
        </Card>

        {/* Stats grid — Performance XAU/USD (reordenado 12/06/26: bloque MOTOR arriba — Señales Emitidas → Performance → Shadow Trading) */}
        <Card>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10,gap:8,flexWrap:"wrap"}}>
            <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
              <div style={{fontFamily:SANS,fontSize:11,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:T.muted}}>Performance XAU/USD</div>
              <span style={{fontFamily:MONO,fontSize:9,color:T.dim}}>{signals.length} señales · {signals.filter(s=>s.status==="OPEN").length} abiertas</span>
            </div>
            <button
              onClick={copyStats}
              disabled={closedAll.length===0}
              style={{
                background:copied?T.upBg:T.s2,
                border:`1px solid ${copied?T.upBorder:T.border2}`,
                borderRadius:6,padding:"5px 10px",
                cursor:closedAll.length>0?"pointer":"not-allowed",
                fontFamily:SANS,fontSize:10,fontWeight:600,
                color:copied?T.up:T.muted,
                opacity:closedAll.length>0?1:0.4,
                transition:"all 0.2s"
              }}>
              {copied?"✓ Copiado":"📋 Copiar estadísticas"}
            </button>
          </div>
          {signalsLoading?(
            <div style={{fontFamily:MONO,fontSize:11,color:T.muted,padding:"10px 0"}}>Cargando...</div>
          ):(
            <>
              {/* Titulares -- 4 numeros clave, uniformes (mismo tamano/forma).
                  Desktop: fila de 4. Mobile: se reacomodan a 2x2. La frase de
                  Win Rate baja debajo asi el % nunca queda solo sin contexto. */}
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(150px, 1fr))",gap:8,marginBottom:8}}>
                <div style={{background:T.s2,borderRadius:10,padding:"12px 14px"}}>
                  <div style={{fontFamily:SANS,fontSize:9,fontWeight:600,letterSpacing:"0.08em",textTransform:"uppercase",color:T.muted,marginBottom:5}}>P&amp;L $</div>
                  <div style={{fontFamily:MONO,fontSize:24,fontWeight:700,lineHeight:1,color:snapCount===0?T.muted:pnlTotal>=0?T.up:T.down}}>{snapCount>0?fmtMoney(pnlTotal):"--"}</div>
                </div>
                <div style={{background:T.s2,borderRadius:10,padding:"12px 14px"}}>
                  <div style={{fontFamily:SANS,fontSize:9,fontWeight:600,letterSpacing:"0.08em",textTransform:"uppercase",color:T.muted,marginBottom:5}}>Expectancy</div>
                  <div style={{fontFamily:MONO,fontSize:24,fontWeight:700,lineHeight:1,color:expectancy==null?T.muted:expectancy>0?T.up:T.down}}>{expectancy==null?"--":`${expectancy>=0?"+":""}${expectancy.toFixed(2)}R`}</div>
                </div>
                <div style={{background:T.s2,borderRadius:10,padding:"12px 14px"}}>
                  <div style={{fontFamily:SANS,fontSize:9,fontWeight:600,letterSpacing:"0.08em",textTransform:"uppercase",color:T.muted,marginBottom:5}}>Win Rate</div>
                  <div style={{fontFamily:MONO,fontSize:24,fontWeight:700,lineHeight:1,color:T.text}}>{totalContados>0?`${wr}%`:"--"}</div>
                </div>
                <div style={{background:T.s2,borderRadius:10,padding:"12px 14px"}}>
                  <div style={{fontFamily:SANS,fontSize:9,fontWeight:600,letterSpacing:"0.08em",textTransform:"uppercase",color:T.muted,marginBottom:5}}>Payoff Ratio</div>
                  <div style={{fontFamily:MONO,fontSize:24,fontWeight:700,lineHeight:1,color:rrReal==null?T.muted:rrReal>=2?T.up:rrReal>=1?T.wait:T.down}}>{rrReal==null?"--":`${rrReal.toFixed(2)}×`}</div>
                </div>
              </div>
              {rrReal!=null && totalContados>0 && (
                <div style={{fontFamily:SANS,fontSize:10,color:T.muted,lineHeight:1.4,marginBottom:8}}>
                  Gana {wins} de cada {totalContados}, pero cada ganadora pesa <span style={{color:T.up,fontWeight:600}}>{rrReal.toFixed(2)}×</span> una perdedora.
                </div>
              )}
              {/* Calidad y riesgo (avanzado) — métricas nuevas */}
              <div style={{fontFamily:SANS,fontSize:9,fontWeight:600,letterSpacing:"0.08em",textTransform:"uppercase",color:T.dim,margin:"10px 0 6px"}}>Calidad y riesgo</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(120px, 1fr))",gap:8}}>
                {calidadStats.map(({l,v,c,sub})=>(
                  <div key={l} style={{background:T.s2,borderRadius:8,padding:"9px 12px"}}>
                    <div style={{fontFamily:SANS,fontSize:9,fontWeight:600,letterSpacing:"0.08em",textTransform:"uppercase",color:T.muted,marginBottom:4}}>{l}</div>
                    <div style={{fontFamily:MONO,fontSize:16,fontWeight:700,color:c}}>{v}</div>
                    {sub?<div style={{fontFamily:MONO,fontSize:8,color:T.dim,marginTop:3}}>{sub}</div>:null}
                  </div>
                ))}
              </div>
              {calidadPrelim && (
                <div style={{fontFamily:MONO,fontSize:9,color:T.dim,fontStyle:"italic",marginTop:6}}>
                  SQN / Sharpe / Sortino son preliminares hasta ~30 señales. El SQN sube solo si el edge es real.
                </div>
              )}
              {/* Operaciones — lo de siempre */}
              <div style={{fontFamily:SANS,fontSize:9,fontWeight:600,letterSpacing:"0.08em",textTransform:"uppercase",color:T.dim,margin:"12px 0 6px"}}>Operaciones</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(120px, 1fr))",gap:8}}>
                {stats.map(({l,v,c})=>(
                  <div key={l} style={{background:T.s2,borderRadius:8,padding:"9px 12px"}}>
                    <div style={{fontFamily:SANS,fontSize:9,fontWeight:600,letterSpacing:"0.08em",
                      textTransform:"uppercase",color:T.muted,marginBottom:4}}>{l}</div>
                    <div style={{fontFamily:MONO,fontSize:16,fontWeight:700,color:c}}>{v}</div>
                  </div>
                ))}
              </div>
            </>
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
              {shadowBaseLabel && (
                <span style={{fontFamily:MONO,fontSize:9,fontWeight:700,color:T.gold,
                  background:T.s3,border:`1px solid ${T.border2}`,
                  borderRadius:5,padding:"3px 7px",letterSpacing:"0.04em"}}>
                  {shadowBaseLabel}
                </span>
              )}
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
                          <div style={{fontFamily:SANS,fontSize:8,color:T.muted,marginBottom:2}}>Expect.</div>
                          <div style={{fontFamily:MONO,fontSize:10,color:stats.expectancyR != null ? (stats.expectancyR >= 0 ? T.up : T.down) : T.muted}}>
                            {fmtR(stats.expectancyR)}
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
                <ScrollX minWidth={680}>
                  <div style={{display:"flex",flexDirection:"column",gap:3}}>
                    <div style={{display:"grid",gridTemplateColumns:"160px 60px 60px 60px 70px 70px 70px 80px",gap:6,
                      padding:"4px 8px",fontFamily:SANS,fontSize:8,fontWeight:600,
                      letterSpacing:"0.06em",textTransform:"uppercase",color:T.muted,borderBottom:`1px solid ${T.border}`}}>
                      <span>Perfil</span><span>Total</span><span>WR</span><span>PF</span>
                      <span>Expect.</span><span>Best $</span><span>Worst $</span><span>P&L $</span>
                    </div>
                    {[
                      {key:"structural"  as const, label:"Structural",   desc:"R:R [2,5] del motor"},
                      {key:"swing_minor" as const, label:"Swing minor",  desc:"Primer swing sin filtro"},
                      {key:"atr_15x"     as const, label:"ATR × 1.5",    desc:"Volatilidad-based"},
                      {key:"rr_15_fixed" as const, label:"R:R fijo 1.5", desc:"SL × 1.5"},
                    ].map(({key,label,desc})=>{
                      const s = shadowByTpType[key];
                      return(
                        <div key={key} style={{display:"grid",gridTemplateColumns:"160px 60px 60px 60px 70px 70px 70px 80px",gap:6,
                          padding:"5px 8px",borderRadius:5,background:T.s2,alignItems:"center"}}>
                          <div>
                            <div style={{fontFamily:SANS,fontSize:10,fontWeight:600,color:T.text}}>{label}</div>
                            <div style={{fontFamily:SANS,fontSize:8,color:T.dim,fontStyle:"italic"}}>{desc}</div>
                          </div>
                          <span style={{fontFamily:MONO,fontSize:10,color:T.muted}}>{s.total}</span>
                          <span style={{fontFamily:MONO,fontSize:10,fontWeight:700,color:shadowWrColor(s.wr)}}>{s.wr != null ? `${s.wr}%` : "--"}</span>
                          <span style={{fontFamily:MONO,fontSize:10,fontWeight:700,color:shadowPfColor(s.pf)}}>{s.pf != null ? s.pf.toFixed(2) : "--"}</span>
                          <span style={{fontFamily:MONO,fontSize:10,color:s.expectancyR != null ? (s.expectancyR >= 0 ? T.up : T.down) : T.muted}}>{fmtR(s.expectancyR)}</span>
                          <span style={{fontFamily:MONO,fontSize:10,color:s.bestDollar != null ? (s.bestDollar >= 0 ? T.up : T.down) : T.muted}}>{fmtDollar(s.bestDollar)}</span>
                          <span style={{fontFamily:MONO,fontSize:10,color:s.worstDollar != null ? (s.worstDollar >= 0 ? T.up : T.down) : T.muted}}>{fmtDollar(s.worstDollar)}</span>
                          <span style={{fontFamily:MONO,fontSize:10,fontWeight:700,color:s.pnlDollar == null ? T.muted : s.pnlDollar >= 0 ? T.up : T.down}}>
                            {s.pnlDollar == null ? "--" : (s.pnlDollar >= 0 ? "+" : "-") + "$" + Math.abs(s.pnlDollar).toFixed(0)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </ScrollX>
              </div>

              {/* Resumen al pie — perfil representativo (Structural = exit
                  real del motor). NO suma los 4 perfiles (serían 4
                  estrategias distintas → número falso). 100% display: lee
                  shadowByTpType.structural ya calculado, no toca BD ni motor. */}
              {(()=>{
                const s = shadowByTpType.structural;
                return (
                  <div style={{background:T.s2,border:`1px solid ${T.border2}`,borderRadius:10,padding:14,marginTop:16,marginBottom:8}}>
                    <div style={{display:"flex",alignItems:"baseline",justifyContent:"space-between",gap:8,flexWrap:"wrap",marginBottom:4}}>
                      <div style={{fontFamily:SANS,fontSize:11,fontWeight:700,color:T.text}}>
                        Resumen shadow · perfil de salida <span style={{color:T.accent}}>Structural</span> <span style={{fontWeight:400,color:T.muted}}>(R:R del motor)</span>
                      </div>
                      {shadowBaseLabel && (
                        <span style={{fontFamily:MONO,fontSize:9,fontWeight:700,color:T.gold}}>{shadowBaseLabel}</span>
                      )}
                    </div>
                    <div style={{fontFamily:SANS,fontSize:9,color:T.muted,marginBottom:10}}>
                      Incluye las 2 causas (<span style={{color:T.accent}}>D1 bloqueó</span> + <span style={{color:T.gold}}>Estructura contradice</span>) medidas con la salida del motor.
                    </div>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(5, 1fr)",gap:10}}>
                      <div>
                        <div style={{fontFamily:SANS,fontSize:8,color:T.muted,textTransform:"uppercase",letterSpacing:"0.04em",marginBottom:3}}>P&L $</div>
                        <div style={{fontFamily:MONO,fontSize:16,fontWeight:700,color:s.pnlDollar==null?T.muted:s.pnlDollar>=0?T.up:T.down}}>
                          {s.pnlDollar==null ? "--" : (s.pnlDollar>=0?"+":"-")+"$"+Math.abs(s.pnlDollar).toFixed(0)}
                        </div>
                      </div>
                      <div>
                        <div style={{fontFamily:SANS,fontSize:8,color:T.muted,textTransform:"uppercase",letterSpacing:"0.04em",marginBottom:3}}>Win Rate</div>
                        <div style={{fontFamily:MONO,fontSize:16,fontWeight:700,color:shadowWrColor(s.wr)}}>
                          {s.wr != null ? `${s.wr}%` : "--"}
                        </div>
                      </div>
                      <div>
                        <div style={{fontFamily:SANS,fontSize:8,color:T.muted,textTransform:"uppercase",letterSpacing:"0.04em",marginBottom:3}}>PF</div>
                        <div style={{fontFamily:MONO,fontSize:16,fontWeight:700,color:shadowPfColor(s.pf)}}>
                          {s.pf != null ? s.pf.toFixed(2) : "--"}
                        </div>
                      </div>
                      <div>
                        <div style={{fontFamily:SANS,fontSize:8,color:T.muted,textTransform:"uppercase",letterSpacing:"0.04em",marginBottom:3}}>Expectancy</div>
                        <div style={{fontFamily:MONO,fontSize:16,fontWeight:700,color:s.expectancyR!=null?(s.expectancyR>=0?T.up:T.down):T.muted}}>
                          {fmtR(s.expectancyR)}
                        </div>
                      </div>
                      <div>
                        <div style={{fontFamily:SANS,fontSize:8,color:T.muted,textTransform:"uppercase",letterSpacing:"0.04em",marginBottom:3}}>W/L/EXP</div>
                        <div style={{fontFamily:MONO,fontSize:13,fontWeight:700,color:T.text}}>
                          <span style={{color:T.up}}>{s.wins}</span>/<span style={{color:T.down}}>{s.losses}</span>/<span style={{color:T.dim}}>{s.expired}</span>
                        </div>
                      </div>
                    </div>
                    {s.ofrr === 0 ? (
                      <div style={{fontFamily:SANS,fontSize:9,color:T.muted,fontStyle:"italic",marginTop:10}}>
                        Sin WIN/LOSS cerradas en Structural todavía — el resumen se completa cuando cierren.
                      </div>
                    ) : s.ofrr < 30 ? (
                      <div style={{fontFamily:SANS,fontSize:9,color:T.wait,fontStyle:"italic",marginTop:10}}>
                        ⚠ n={s.ofrr} cerradas · preliminar — el shadow recién arranca, no es conclusión.
                      </div>
                    ) : null}
                    <div style={{fontFamily:SANS,fontSize:9,color:T.dim,fontStyle:"italic",marginTop:8,lineHeight:1.5}}>
                      Se muestra solo el perfil de salida <b style={{color:T.muted}}>Structural</b> (el R:R real del motor) como "la" línea del shadow. Los otros 3 perfiles de la tabla de arriba son <b style={{color:T.muted}}>salidas alternativas</b> del mismo setup — no se suman.
                    </div>
                  </div>
                );
              })()}

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
                      <span>Fecha COL</span><span>Tipo</span><span>Dir</span>
                      <span>Entry</span><span>SL</span><span>TP</span>
                      <span>Perfil</span><span>Status</span><span>PnL %</span>
                      <span></span>
                    </div>
                    {shadowTrades.map(t=>{
                      const fechaStr = (()=>{
                        try {
                          const d = new Date(t.created_at);
                          const dd = d.getDate().toString().padStart(2,"0");
                          const mm = (d.getMonth()+1).toString().padStart(2,"0");
                          const hh = d.getHours().toString().padStart(2,"0");
                          const mi = d.getMinutes().toString().padStart(2,"0");
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

      </div>
    </div>
  );
}
