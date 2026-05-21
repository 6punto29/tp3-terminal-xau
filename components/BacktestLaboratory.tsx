"use client";
// ─────────────────────────────────────────────────────────────────────────────
// components/BacktestLaboratory.tsx
// Three-section backtest suite for XAUUSDT.
//
// Data flow (client-side — sin límite de timeout de Vercel):
//   El navegador llama a Binance Futures directamente
//   El engine corre en el browser (igual que el HTML original)
//   /api/backtest ya no se usa desde este componente
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useCallback, useRef, createContext, useContext, useEffect } from "react";
import {
  T, MONO, SANS,
  BtCard, SelBtn, SlTpBtn, RunBtn,
  Progress, StatusLine, Th,
  EquityCurve, StatCard,
  evColor, wrColor, pnlColor, fmtPct,
} from "@/components/ui";
import { precompute }      from "@/lib/engine/indicators";
import { detectSignals }   from "@/lib/engine/signals";
import { simulateSignals, summarize, calcEV } from "@/lib/engine/simulator";
import type { BacktestResult, BacktestConfig, SimulatedTrade, Candle } from "@/lib/engine/types";

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const SL_OPTS: [string, number][] = [
  ["0.5%", 0.005], ["0.75%", 0.0075], ["1%", 0.01], ["1.5%", 0.015], ["2%", 0.02],
];
const TP_OPTS: [string, number][] = [
  ["1%", 0.01], ["1.5%", 0.015], ["2%", 0.02], ["2.5%", 0.025],
  ["3%", 0.03], ["3.5%", 0.035], ["4%", 0.04], ["4.5%", 0.045],
];
const ALL_CONFIGS: Pick<BacktestConfig, "htf" | "mtf" | "hold">[] = [
  { htf: "4h", mtf: "1h",  hold: 3  },
  { htf: "4h", mtf: "1h",  hold: 6  },
  { htf: "4h", mtf: "1h",  hold: 12 },
  { htf: "1h", mtf: "15m", hold: 3  },
  { htf: "1h", mtf: "15m", hold: 6  },
  { htf: "1h", mtf: "15m", hold: 12 },
];
const RR_TEST_CONFIGS: Pick<BacktestConfig, "htf" | "mtf" | "hold">[] = [
  { htf: "1h", mtf: "15m", hold: 6 },
  { htf: "1h", mtf: "15m", hold: 3 },
  { htf: "4h", mtf: "1h",  hold: 3 },
];
const RR_COMBOS: { sl: number; tp: number }[] = [
  { sl: 0.005,  tp: 0.01   }, { sl: 0.005,  tp: 0.015  },
  { sl: 0.005,  tp: 0.02   }, { sl: 0.005,  tp: 0.025  },
  { sl: 0.0075, tp: 0.02   }, { sl: 0.0075, tp: 0.025  },
  { sl: 0.0075, tp: 0.03   }, { sl: 0.01,   tp: 0.025  },
  { sl: 0.01,   tp: 0.03   }, { sl: 0.01,   tp: 0.04   },
  { sl: 0.015,  tp: 0.03   }, { sl: 0.015,  tp: 0.04   },
  { sl: 0.015,  tp: 0.045  }, { sl: 0.02,   tp: 0.04   },
];

// ─────────────────────────────────────────────────────────────────────────────
// RESUMEN PARA CLAUDE — context compartido entre Sections (Opción C)
// ─────────────────────────────────────────────────────────────────────────────
//
// Cada Section reporta sus resultados a este context cuando termina de correr.
// El componente <ResumenParaClaude /> arriba del laboratorio:
//   1) Muestra status visual de las 3 secciones (✓ corrida / ✗ falta)
//   2) Habilita el botón "Copiar los 3 resultados" solo cuando las 3 están listas
//   3) Genera un texto formateado listo para pasarle a Claude
//
// Section1 (manual) NO se incluye porque depende de qué config corra el usuario,
// no es una comparación canónica que Claude necesite para validar el sistema.

interface ResumenContextValue {
  // Section 2 — Comparar Configs (6 combos HTF+MTF+Hold)
  section2: { rows: TableRow[]; sl: number; tp: number } | null;
  setSection2: (v: { rows: TableRow[]; sl: number; tp: number } | null) => void;
  // Section 3 — Comparar Ratio + ATR (12 combos)
  section3: { rows: RatioAtrRow[] } | null;
  setSection3: (v: { rows: RatioAtrRow[] } | null) => void;
  // Section 4 — Comparar R:R · Mejor config automática
  section4: { rows: RRRow[]; baseLabel: string } | null;
  setSection4: (v: { rows: RRRow[]; baseLabel: string } | null) => void;
}

const ResumenContext = createContext<ResumenContextValue | null>(null);

// Hook seguro: si una Section se importa fuera del Provider, no rompe.
function useResumen(): ResumenContextValue | null {
  return useContext(ResumenContext);
}

// ─────────────────────────────────────────────────────────────────────────────
// BINANCE CLIENT-SIDE FETCH + ENGINE
// ─────────────────────────────────────────────────────────────────────────────

const BINANCE = "https://fapi.binance.com/fapi/v1/klines";
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
const SPREAD_TOTAL = 1.00; // $0.35 spread + $0.65 slippage estimado MT5

// Cambio #8 (v5): fetchCandles ahora acepta AbortSignal. Si el signal se aborta,
// las requests pendientes a Binance se cancelan inmediatamente y el bucle de
// paginación termina sin consumir más cuota de la API.
async function fetchCandles(tf: string, signal?: AbortSignal, onProgress?: (msg: string) => void): Promise<Candle[]> {
  onProgress?.(`Descargando velas ${tf.toUpperCase()}...`);
  const r = await fetch(`${BINANCE}?symbol=XAUUSDT&interval=${tf}&limit=1500`, { signal });
  const d = await r.json() as number[][];
  if (!Array.isArray(d) || !d.length) return [];
  let all = d;
  // RATE LIMIT FIX (20/05/26): delay aumentado de 350ms → 600ms para evitar 418.
  // Con 5 timeframes serializados + 600ms entre páginas, el backtest tarda más
  // pero no banea la IP.
  const PAGE_DELAY = 600;
  // Paginar hasta 8 veces hacia atrás para obtener máximo histórico disponible
  for (let p = 0; p < 8; p++) {
    if (signal?.aborted) throw new DOMException("Backtest cancelado", "AbortError");
    await delay(PAGE_DELAY);
    if (signal?.aborted) throw new DOMException("Backtest cancelado", "AbortError");
    const oldest = all[0][0];
    const date = new Date(oldest).toLocaleDateString("es-CO",{day:"2-digit",month:"short"});
    onProgress?.(`Cargando historia hasta ${date}... (${Math.round(all.length/24)} días)`);
    const rp = await fetch(
      `${BINANCE}?symbol=XAUUSDT&interval=${tf}&limit=1500&endTime=${oldest - 1}`,
      { signal }
    );
    const dp = await rp.json() as number[][];
    if (!Array.isArray(dp) || !dp.length) break;
    all = [...dp, ...all];
    if (dp.length < 100) break; // No hay más historia disponible
  }
  onProgress?.(`Total: ${all.length} velas ${tf.toUpperCase()} descargadas`);
  return all
    .map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }))
    .slice(0, -1);
}

async function runBacktest(cfg: BacktestConfig, signal?: AbortSignal, onProgress?: (msg: string) => void): Promise<BacktestResult> {
  // CAMBIO Fix #2 (Auditoría 20/05/26):
  // Fetcheamos también 15m, 5m y 4h para alimentar el score completo del engine.
  // Si la HTF == "4h", reutilizamos htfCandles como h4Candles (no doble fetch).
  // Si la MTF == "15m", reutilizamos mtfCandles como m15Candles.
  //
  // RATE LIMIT FIX (20/05/26):
  // Los 5 fetches en paralelo (HTF+MTF+15m+5m+4h, cada uno con hasta 9 páginas)
  // generaban 45 requests en burst a Binance → respondía 418 (IP banneada).
  // SOLUCIÓN: serializar — un fetch tras otro, no Promise.all.
  // Tarda ~2x más pero evita ban completamente.
  const needH4  = cfg.htf !== "4h";
  const needM15 = cfg.mtf !== "15m";

  const htfCandles = await fetchCandles(cfg.htf, signal, onProgress);
  const mtfCandles = await fetchCandles(cfg.mtf, signal, onProgress);
  const m15Extra   = needM15 ? await fetchCandles("15m", signal, onProgress) : [] as Candle[];
  const ltfCandles = await fetchCandles("5m",  signal, onProgress);
  const h4Extra    = needH4  ? await fetchCandles("4h",  signal, onProgress) : [] as Candle[];

  const m15Candles = cfg.mtf === "15m" ? mtfCandles : m15Extra;
  const h4Candles  = cfg.htf === "4h"  ? htfCandles : h4Extra;
  if (signal?.aborted) throw new DOMException("Backtest cancelado", "AbortError");
  if (!htfCandles.length) throw new Error("No data from Binance");
  const htfInd = precompute(htfCandles);
  const mtfInd = precompute(mtfCandles);
  const signals = detectSignals(htfCandles, mtfCandles, htfInd, mtfInd, {
    holdCandles:      cfg.hold,
    sessionFilter:    cfg.sessionFilter,
    ema200Filter:     cfg.ema200Filter,
    structureFilter:  cfg.structureFilter  ?? false,
    spread:           SPREAD_TOTAL,
    // Paso 1 — alineación con engine en vivo: pasar caps en % a la lógica estructural
    slCapPct:         cfg.slPct * 100,
    tpTargetPct:      cfg.tpPct * 100,
    // Fase A — controles experimentales (opcionales, defaults seguros)
    minRatio:         cfg.minRatio,
    atrMin:           cfg.atrMin,
  }, {
    m15Candles,
    ltfCandles,
    h4Candles,
  });
  const trades  = simulateSignals(signals, cfg.slPct, cfg.tpPct, cfg.hold);
  const summary = summarize(trades);
  const rr      = cfg.tpPct / cfg.slPct;
  const ev      = summary ? calcEV(summary.wr, rr) : 0;
  const dateFrom = htfCandles[0] ? new Date(htfCandles[0].t).toLocaleDateString("es-CO",{day:"2-digit",month:"short",year:"2-digit"}) : "?";
  const dateTo   = htfCandles[htfCandles.length-1] ? new Date(htfCandles[htfCandles.length-1].t).toLocaleDateString("es-CO",{day:"2-digit",month:"short",year:"2-digit"}) : "?";
  // Fix #5 (v4): si no hay señales, summary es null. Antes hacíamos { ...summary!, ... }
  // y el spread sobre null generaba un objeto sin total/wr/pnl/avgW/avgL → crash al
  // llamar .toFixed() en el consumer. Ahora rellenamos con ceros explícitos.
  const safeSummary = summary
    ? { ...summary, rr, ev }
    : { total: 0, wins: 0, wr: 0, pnl: 0, avgW: 0, avgL: 0, rr, ev };
  return {
    config:  cfg,
    summary: safeSummary,
    trades:  trades.slice(-50),
    htfLen:  htfCandles.length,
    label:   `${cfg.htf.toUpperCase()}+${cfg.mtf.toUpperCase()} H${cfg.hold} · ${dateFrom}→${dateTo}`,
  };
}

function cfgLabel(cfg: Pick<BacktestConfig, "htf" | "mtf" | "hold">, ema = false): string {
  return `${cfg.htf.toUpperCase()}+${cfg.mtf.toUpperCase()} H${cfg.hold}${ema ? " +EMA" : ""}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// COPY RESULT BUTTON
// ─────────────────────────────────────────────────────────────────────────────

function CopyResultBtn({ result, sl, tp, spread }: {
  result: BacktestResult; sl: number; tp: number; spread: number;
}) {
  const [copied, setCopied] = useState(false);
  const s = result.summary;
  const copy = () => {
    const date = new Date().toLocaleDateString("es-CO",{day:"2-digit",month:"2-digit",year:"2-digit"});
    // Breakdown tpSource — diagnóstico de la lógica estructural
    const tpS = s.tpSession   ?? 0;
    const tpT = s.tpStructure ?? 0;
    const tpF = s.tpFallback  ?? 0;
    const tot = s.total || 1;
    const pct = (n: number) => `${Math.round((n / tot) * 100)}%`;
    const txt = [
      `TP3 Backtest · XAUUSDT · ${date}`,
      `${result.label}`,
      `SL ${(sl*100).toFixed(2)}% · TP ${(tp*100).toFixed(2)}% · R:R ${(tp/sl).toFixed(2)}:1`,
      `Señales: ${s.total} · WR: ${s.wr}% · EV: ${((s.ev??0)>=0?"+":"")}${(s.ev??0).toFixed(2)}R`,
      `Avg Win: +${s.avgW.toFixed(2)}% · Avg Loss: ${s.avgL.toFixed(2)}%`,
      `TP origen: session ${tpS} (${pct(tpS)}) · structure ${tpT} (${pct(tpT)}) · fallback ${tpF} (${pct(tpF)})`,
      `Spread+slippage: $${spread.toFixed(2)} · Velas HTF: ${result.htfLen}`,
    ].join("\n");
    navigator.clipboard.writeText(txt).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <button onClick={copy} style={{
      fontFamily: MONO, fontSize: 9, fontWeight: 700,
      padding: "4px 10px", borderRadius: 5, cursor: "pointer",
      border: `1px solid ${copied ? T.up : T.border}`,
      background: copied ? T.upBg : T.s2,
      color: copied ? T.up : T.muted,
      transition: "all 0.2s",
      marginLeft: "auto",
    }}>
      {copied ? "✓ Copiado" : "📋 Copiar"}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// COPY TABLE BUTTON (Section 2)
// ─────────────────────────────────────────────────────────────────────────────

function CopyTableBtn({ rows, sl, tp }: { rows: TableRow[]; sl: number; tp: number }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const date = new Date().toLocaleDateString("es-CO",{day:"2-digit",month:"2-digit",year:"2-digit"});
    const header = `TP3 Comparar Configs · XAUUSDT · ${date}\nSL ${(sl*100).toFixed(2)}% · TP ${(tp*100).toFixed(2)}% · Spread+slippage $1.00\n`;
    const lines = rows.map(r =>
      `${r.label.padEnd(20)} | ${r.total} señales | WR ${r.wr}% | EV ${r.ev>=0?"+":""}${r.ev.toFixed(2)}R`
    );
    navigator.clipboard.writeText(header + lines.join("\n")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <button onClick={copy} style={{
      marginTop: 6, width: "100%",
      fontFamily: MONO, fontSize: 9, fontWeight: 700,
      padding: "5px", borderRadius: 5, cursor: "pointer",
      border: `1px solid ${copied ? T.up : T.border}`,
      background: copied ? T.upBg : T.s2,
      color: copied ? T.up : T.muted,
      transition: "all 0.2s",
    }}>
      {copied ? "✓ Copiado" : "📋 Copiar tabla completa"}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// COPY RR BUTTON (Section 3)
// ─────────────────────────────────────────────────────────────────────────────

interface RRRow extends TableRow { slPct?:number; tpPct?:number; rr?:number; }

function CopyRRBtn({ best }: { best: RRRow }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const date = new Date().toLocaleDateString("es-CO",{day:"2-digit",month:"2-digit",year:"2-digit"});
    const txt = [
      `TP3 Comparar R:R · XAUUSDT · ${date}`,
      `Óptimo: ${best.label}`,
      `SL ${(best.slPct??0).toFixed(2)}% · TP ${(best.tpPct??0).toFixed(2)}% · R:R ${(best.rr??0).toFixed(2)}:1`,
      `Señales: ${best.total} · WR: ${best.wr}% · EV: +${best.ev.toFixed(2)}R`,
      `Avg Win: +${best.avgW.toFixed(2)}% · Avg Loss: ${best.avgL.toFixed(2)}%`,
      ``,
      `→ Configura en terminal: SL ${(best.slPct??0).toFixed(2)}% · TP ${(best.tpPct??0).toFixed(2)}%`,
    ].join("\n");
    navigator.clipboard.writeText(txt).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <button onClick={copy} style={{
      fontFamily: MONO, fontSize: 9, fontWeight: 700,
      padding: "4px 10px", borderRadius: 5, cursor: "pointer",
      border: `1px solid ${copied ? T.up : T.border}`,
      background: copied ? T.upBg : T.s2,
      color: copied ? T.up : T.muted,
      transition: "all 0.2s", whiteSpace: "nowrap",
    }}>
      {copied ? "✓ Copiado" : "📋 Copiar"}
    </button>
  );
}

function TradeRow({ t }: { t: SimulatedTrade }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
      padding: "4px 6px", borderRadius: 6,
      background: T.s2, fontSize: 9,
      borderLeft: `2px solid ${t.won ? T.up : T.down}`,
    }}>
      <span style={{ fontFamily: MONO, color: t.sig === "UP" ? T.up : T.down, minWidth: 12 }}>
        {t.sig === "UP" ? "⬆" : "⬇"}
      </span>
      <span style={{ fontFamily: MONO, color: T.muted, minWidth: 36 }}>{t.date}</span>
      <span style={{ fontFamily: MONO, color: T.text, minWidth: 58 }}>
        ${t.entry.toFixed(0)}
      </span>
      <span style={{ fontFamily: SANS, color: T.muted, flex: 1 }}>
        {t.hitTP ? "TP✓" : t.hitSL ? "SL✗" : "⏱"}
      </span>
      <span style={{ fontFamily: MONO, fontWeight: 700, color: t.pct >= 0 ? T.up : T.down }}>
        {fmtPct(t.pct)}
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RESULT TABLE
// ─────────────────────────────────────────────────────────────────────────────

interface TableRow {
  label:  string;
  slPct?: number;
  tpPct?: number;
  rr?:    number;
  total:  number;
  wr:     number;
  avgW:   number;
  avgL:   number;
  pnl:    number;
  ev:     number;
}

function ResultTable({
  rows,
  showSLTP = false,
  footer,
}: {
  rows:      TableRow[];
  showSLTP?: boolean;
  footer?:   string;
}) {
  if (!rows.length) return null;

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 9 }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${T.border}` }}>
            <Th left>Config</Th>
            {showSLTP && <><Th>SL%</Th><Th>TP%</Th><Th>R:R</Th></>}
            <Th>Señales</Th>
            <Th>WR</Th>
            <Th>Avg W</Th>
            <Th>Avg L</Th>
            <Th>P&L</Th>
            <Th>EV/trade</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{
              borderBottom: `1px solid ${T.border}`,
              background: i === 0 ? T.upBg : "transparent",
            }}>
              <td style={{
                padding: "4px 5px", fontFamily: SANS,
                fontWeight: 700, color: i === 0 ? T.up : T.text,
              }}>
                {i === 0 && <span style={{ color: T.gold }}>★ </span>}
                {r.label}
              </td>
              {showSLTP && (
                <>
                  <td style={{ textAlign: "center", fontFamily: MONO, color: T.down }}>
                    {r.slPct?.toFixed(2).replace(".00", "")}%
                  </td>
                  <td style={{ textAlign: "center", fontFamily: MONO, color: T.up }}>
                    {r.tpPct?.toFixed(2).replace(".00", "")}%
                  </td>
                  <td style={{ textAlign: "center", fontFamily: MONO, color: T.wait }}>
                    {r.rr?.toFixed(2)}
                  </td>
                </>
              )}
              <td style={{ textAlign: "center", fontFamily: MONO, color: T.muted }}>
                {r.total}
              </td>
              <td style={{
                textAlign: "center", fontFamily: MONO, fontWeight: 700,
                color: wrColor(r.wr),
              }}>
                {r.wr}%
              </td>
              <td style={{ textAlign: "center", fontFamily: MONO, color: T.up }}>
                +{r.avgW.toFixed(2)}%
              </td>
              <td style={{ textAlign: "center", fontFamily: MONO, color: T.down }}>
                {r.avgL.toFixed(2)}%
              </td>
              <td style={{
                textAlign: "center", fontFamily: MONO,
                color: pnlColor(r.pnl),
              }}>
                {fmtPct(r.pnl, 1)}
              </td>
              <td style={{
                textAlign: "center", fontFamily: MONO, fontWeight: 700,
                color: evColor(r.ev),
              }}>
                {fmtPct(r.ev, 2).replace("%", "R").replace("+", "+")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {footer && (
        <div style={{
          fontFamily: SANS, fontSize: 7, color: T.muted, marginTop: 5,
        }}>{footer}</div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — TEST MANUAL
// ─────────────────────────────────────────────────────────────────────────────

function Section1() {
  // Defaults a la config validada: HTF 1H, Hold 6, SL 0.75%, TP 3%, sesión LDN+NY, EMA200 ON
  const [htf,      setHtf]    = useState("1h");
  const [hold,     setHold]   = useState(6);
  const [sess,     setSess]   = useState(true);
  const [ema200F,  setEma200] = useState(true);
  const [sl,       setSL]     = useState(0.0075);
  const [tp,       setTP]     = useState(0.03);
  // Fase A — controles experimentales para subir % estructura y filtrar mercado muerto
  // CAMBIO v6 — default 0.5× validado por backtest comparativo (+10.6% EV vs 1.5×)
  const [minRatio, setMinRatio] = useState(0.5);   // umbral TP/SL (validado óptimo)
  const [atrMin,   setAtrMin]   = useState(0);     // ATR mínimo (0 = sin filtro, óptimo)
  const [running,  setRun]    = useState(false);
  const [prog,     setProg]   = useState(0);
  const [status,   setStat]   = useState("");
  const [result,   setResult] = useState<BacktestResult | null>(null);
  // Cambio #8 (v5): AbortController por módulo para soportar cancel
  const ctrlRef = useRef<AbortController | null>(null);

  const slLabel = SL_OPTS.find((o) => o[1] === sl)?.[0] ?? "0.75%";
  const tpLabel = TP_OPTS.find((o) => o[1] === tp)?.[0] ?? "3%";

  const cancel = useCallback(() => {
    ctrlRef.current?.abort();
  }, []);

  const run = useCallback(async () => {
    // Crear nuevo AbortController para esta corrida
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setRun(true); setProg(15); setStat("Conectando a Binance Futures…"); setResult(null);
    try {
      setProg(30);
      const cfg: BacktestConfig = {
        htf, mtf: htf === "4h" ? "1h" : "15m",
        hold, slPct: sl, tpPct: tp,
        sessionFilter: sess, ema200Filter: ema200F,
        structureFilter: false,
        spread: SPREAD_TOTAL,
        // Fase A — defaults seguros si no se cambian
        minRatio,
        atrMin,
      };
      setStat("Descargando historia completa de Binance…"); setProg(60);
      const res = await runBacktest(cfg, ctrl.signal, setStat);
      setResult(res);
      const s = res.summary;
      setStat(
        `${res.htfLen} velas HTF · ${s.total} señales · ` +
        `WR ${s.wr}% · P&L ${fmtPct(s.pnl, 1)} · EV ${fmtPct(s.ev ?? 0, 2).replace("%","R")}`
      );
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        setStat("⚠ Test cancelado por el usuario");
      } else {
        setStat("⚠ " + (e instanceof Error ? e.message : "Error desconocido"));
      }
    } finally {
      setRun(false); setProg(0);
      ctrlRef.current = null;
    }
  }, [htf, hold, sl, tp, sess, ema200F]);

  const s = result?.summary;

  return (
    <BtCard>
      <div style={{
        display: "flex", alignItems: "flex-start",
        justifyContent: "space-between", marginBottom: 12,
      }}>
        <div>
          <div style={{ fontFamily: SANS, fontSize: 11, fontWeight: 700, color: T.text }}>
            Backtesting · XAUUSDT · Binance Futures
          </div>
          <div style={{ fontFamily: SANS, fontSize: 9, color: T.muted, marginTop: 2 }}>
            SL <span style={{ color: T.down }}>{slLabel}</span>
            {" "}· TP <span style={{ color: T.up }}>{tpLabel}</span>
            {" "}· R:R <span style={{ color: T.wait }}>{(tp / sl).toFixed(2)}:1</span>
          </div>
          <div style={{ fontFamily: SANS, fontSize: 8, color: T.wait, marginTop: 3 }}>
            ⚠ XAUUSDT perpetuo en Binance tiene ~5 meses de historia disponible · spread+slippage $1.00
          </div>
        </div>
        {running ? (
          <button onClick={cancel} style={{
            fontFamily: SANS, fontSize: 10, fontWeight: 700,
            padding: "5px 16px", borderRadius: 20, border: "none",
            background: `linear-gradient(135deg, ${T.down}, #FF6B6B)`,
            color: "#FFF", cursor: "pointer", whiteSpace: "nowrap",
          }}>✕ Cancelar test</button>
        ) : (
          <RunBtn onClick={run} disabled={false}>▶ Correr Test</RunBtn>
        )}
      </div>

      <div style={{
        display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap", alignItems: "center",
      }}>
        <SelBtn active={htf === "1h"} onClick={() => setHtf("1h")}>HTF 1H</SelBtn>
        <SelBtn active={htf === "4h"} onClick={() => setHtf("4h")}>HTF 4H</SelBtn>
        <span style={{ width: 8 }} />
        <SelBtn active={hold === 3}  onClick={() => setHold(3)}>Hold 3</SelBtn>
        <SelBtn active={hold === 6}  onClick={() => setHold(6)}>Hold 6</SelBtn>
        <SelBtn active={hold === 12} onClick={() => setHold(12)}>Hold 12</SelBtn>
        <span style={{ width: 8 }} />
        <SelBtn active={sess}    onClick={() => setSess(!sess)}       accentColor={T.wait}>
          LDN/NY
        </SelBtn>
        <SelBtn active={ema200F} onClick={() => setEma200(!ema200F)} accentColor={T.gold}>
          Dir EMA200
        </SelBtn>
      </div>

      <div style={{
        display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap", alignItems: "center",
      }}>
        <span style={{ fontFamily: SANS, fontSize: 8, fontWeight: 700,
          color: T.muted, letterSpacing: ".05em" }}>SL%</span>
        {SL_OPTS.map(([lbl, val]) => (
          <SlTpBtn key={val} active={sl === val} onClick={() => setSL(val)} color={T.down}>
            {lbl}
          </SlTpBtn>
        ))}
        <span style={{width:8}}/>
        <span style={{ fontFamily: SANS, fontSize: 8, fontWeight: 700,
          color: T.muted, letterSpacing: ".05em" }}>TP%</span>
        {TP_OPTS.map(([lbl, val]) => (
          <SlTpBtn key={val} active={tp === val} onClick={() => setTP(val)} color={T.up}>
            {lbl}
          </SlTpBtn>
        ))}
      </div>

      {/* Fase A — controles experimentales: ratio mínimo + filtro ATR */}
      <div style={{
        display: "flex", flexWrap: "wrap", alignItems: "center",
        gap: 4, marginBottom: 8, padding: "6px 8px",
        background: T.s2, border: `1px solid ${T.border}`, borderRadius: 6,
      }}>
        <span style={{ fontFamily: SANS, fontSize: 8, fontWeight: 700,
          color: T.accent, letterSpacing: ".06em",
          textTransform: "uppercase" }}>Ratio mín</span>
        {[
          { lbl: "1.5×", val: 1.5 },
          { lbl: "1.0×", val: 1.0 },
          { lbl: "0.5×", val: 0.5 },
        ].map(({ lbl, val }) => (
          <SlTpBtn key={lbl} active={minRatio === val} onClick={() => setMinRatio(val)} color={T.accent}>
            {lbl}
          </SlTpBtn>
        ))}
        <span style={{ width: 12 }} />
        <span style={{ fontFamily: SANS, fontSize: 8, fontWeight: 700,
          color: T.wait, letterSpacing: ".06em",
          textTransform: "uppercase" }}>ATR mín</span>
        {[
          { lbl: "OFF", val: 0 },
          { lbl: "≥10", val: 10 },
          { lbl: "≥15", val: 15 },
          { lbl: "≥20", val: 20 },
        ].map(({ lbl, val }) => (
          <SlTpBtn key={lbl} active={atrMin === val} onClick={() => setAtrMin(val)} color={T.wait}>
            {lbl}
          </SlTpBtn>
        ))}
        <span style={{ fontFamily: SANS, fontSize: 7, color: T.dim,
          marginLeft: 6 }}>
          (defaults: 0.5× / OFF — óptimo validado por backtest)
        </span>
      </div>

      <Progress pct={prog} show={running} />

      <div style={{
        display: "grid", gridTemplateColumns: "repeat(3,1fr)",
        gap: 6, marginBottom: s ? 10 : 0,
      }}>
        <StatCard label="Win Rate"  value={s ? `${s.wr}%`              : "--%"}  color={s ? wrColor(s.wr)   : T.text} />
        <StatCard label="Señales"   value={s ? s.total                  : "--"}   color={T.text} />
        <StatCard label="P&L Neto"  value={s ? fmtPct(s.pnl, 1)        : "--%"}  color={s ? pnlColor(s.pnl) : T.text} />
        <StatCard label="Ganadoras" value={s ? s.wins                   : "--"}   color={T.up}   />
        <StatCard label="Avg Win"   value={s ? `+${s.avgW.toFixed(2)}%` : "--%"}  color={T.up}   />
        <StatCard label="Avg Loss"  value={s ? `${s.avgL.toFixed(2)}%`  : "--%"}  color={T.down} />
      </div>

      {result && s && (
        <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap", alignItems:"center" }}>
          {[
            { lbl: "EV/trade", val: `${fmtPct(s.ev ?? 0, 3).replace("%", "R")}`, c: evColor(s.ev ?? 0) },
            { lbl: "R:R",      val: `${(tp / sl).toFixed(2)}:1`,                 c: T.wait   },
            { lbl: "Velas HTF",val: `${result.htfLen}`,                           c: T.accent },
          ].map(({ lbl, val, c }) => (
            <div key={lbl} style={{
              background: `${c}12`, border: `1px solid ${c}30`,
              borderRadius: 5, padding: "5px 10px",
              fontSize: 9, fontFamily: SANS, color: c,
            }}>
              {lbl}{" "}
              <span style={{ fontFamily: MONO, fontWeight: 700 }}>{val}</span>
            </div>
          ))}
          <CopyResultBtn result={result} sl={sl} tp={tp} spread={SPREAD_TOTAL} />
        </div>
      )}

      {/* Breakdown del origen del TP — diagnóstico de la lógica estructural */}
      {result && s && s.total > 0 && (
        <div style={{
          display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap",
          padding: "6px 8px", borderRadius: 6, background: T.s2,
          border: `1px solid ${T.border}`, fontSize: 9, fontFamily: SANS,
        }}>
          <span style={{ color: T.muted, fontWeight: 700, letterSpacing: ".05em",
            textTransform: "uppercase" }}>TP origen:</span>
          {(() => {
            const tpS = s.tpSession   ?? 0;
            const tpT = s.tpStructure ?? 0;
            const tpF = s.tpFallback  ?? 0;
            const tot = s.total || 1;
            const items = [
              { lbl: "session (PDH/PDL)", val: tpS, c: T.up },
              { lbl: "structure (swing)", val: tpT, c: T.accent },
              { lbl: "fallback (% fijo)", val: tpF, c: T.wait },
            ];
            return items.map(({lbl,val,c}) => (
              <span key={lbl} style={{ color: c }}>
                <span style={{ fontFamily: MONO, fontWeight: 700 }}>{val}</span>{" "}
                <span style={{ color: T.muted }}>({Math.round(val/tot*100)}%)</span>{" "}
                <span>{lbl}</span>
              </span>
            ));
          })()}
        </div>
      )}

      {result && result.trades.length > 0 && (
        <div style={{
          height: 80, background: T.s2, borderRadius: 6,
          overflow: "hidden", marginBottom: 8,
        }}>
          <EquityCurve trades={result.trades} />
        </div>
      )}

      <StatusLine msg={status || 'Presiona "Correr Test" para analizar XAUUSDT en tiempo real.'} />

      {result && result.trades.length > 0 && (
        <div style={{
          display: "flex", flexDirection: "column", gap: 3,
          maxHeight: 200, overflowY: "auto",
        }}>
          {[...result.trades].reverse().map((t, i) => (
            <TradeRow key={i} t={t} />
          ))}
        </div>
      )}
    </BtCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — COMPARAR CONFIGS
// ─────────────────────────────────────────────────────────────────────────────

function Section2() {
  const [sl,      setSL]    = useState(0.01);
  const [tp,      setTP]    = useState(0.04);
  const [running, setRun]   = useState(false);
  const [prog,    setProg]  = useState(0);
  const [status,  setStat]  = useState("");
  const [rows,    setRows]  = useState<TableRow[] | null>(null);
  // Cambio #8 (v5): AbortController por módulo
  const ctrlRef = useRef<AbortController | null>(null);

  // Reportar al ResumenContext cuando hay resultados.
  // No rompe si el componente se usa fuera del Provider (useResumen retorna null).
  const resumen = useResumen();
  useEffect(() => {
    if (!resumen) return;
    if (rows && rows.length > 0) {
      resumen.setSection2({ rows, sl, tp });
    }
  }, [rows, sl, tp, resumen]);

  const cancel = useCallback(() => {
    ctrlRef.current?.abort();
  }, []);

  const run = useCallback(async () => {
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setRun(true); setProg(5); setStat("Iniciando comparación…"); setRows(null);
    const results: TableRow[] = [];
    const total = ALL_CONFIGS.length * 2;
    let done = 0;
    let cancelled = false;

    try {
      for (const base of ALL_CONFIGS) {
        for (const ema200Filter of [false, true]) {
          if (ctrl.signal.aborted) { cancelled = true; break; }
          const lbl = cfgLabel(base, ema200Filter);
          setStat(`Simulando ${lbl}… (${done + 1}/${total})`);
          setProg(5 + Math.round((done / total) * 90));
          try {
            await delay(300);
            if (ctrl.signal.aborted) { cancelled = true; break; }
            const res = await runBacktest({
              ...base, slPct: sl, tpPct: tp,
              sessionFilter: true, ema200Filter,
              structureFilter: false, spread: SPREAD_TOTAL,
            }, ctrl.signal);
            const s = res.summary;
            if (s && s.total > 0) {
              results.push({
                label: lbl,
                total: s.total, wr: s.wr,
                avgW: s.avgW, avgL: s.avgL,
                pnl: s.pnl, ev: s.ev ?? 0,
              });
            }
          } catch (e) {
            if (e instanceof DOMException && e.name === "AbortError") {
              cancelled = true; break;
            }
            /* skip failed config */
          }
          done++;
        }
        if (cancelled) break;
      }

      results.sort((a, b) => b.ev - a.ev);
      setRows(results);
      if (cancelled) {
        setStat(`⚠ Test cancelado en ${done}/${total}` + (results.length ? ` · ${results.length} parciales` : ""));
      } else {
        const best = results[0];
        setStat(
          best
            ? `★ Mejor: ${best.label} · EV ${fmtPct(best.ev, 2).replace("%","R")} · WR ${best.wr}% · ${best.total} señales`
            : "Sin resultados — verifica conexión a Binance"
        );
      }
    } finally {
      setRun(false); setProg(0);
      ctrlRef.current = null;
    }
  }, [sl, tp]);

  return (
    <BtCard>
      <div style={{
        display: "flex", alignItems: "flex-start",
        justifyContent: "space-between", marginBottom: 10,
      }}>
        <div>
          <div style={{ fontFamily: SANS, fontSize: 11, fontWeight: 700, color: T.text }}>
            Comparar Configs · XAUUSDT
          </div>
          <div style={{ fontFamily: SANS, fontSize: 9, color: T.muted, marginTop: 2 }}>
            {ALL_CONFIGS.length * 2} configs (con/sin EMA200) · SL{" "}
            <span style={{ color: T.down }}>{(sl * 100).toFixed(sl * 100 % 1 === 0 ? 0 : 2)}%</span>
            {" "}/ TP{" "}
            <span style={{ color: T.up }}>{(tp * 100).toFixed(tp * 100 % 1 === 0 ? 0 : 2)}%</span>
          </div>
        </div>
        {running ? (
          <button onClick={cancel} style={{
            fontFamily: SANS, fontSize: 10, fontWeight: 700,
            padding: "5px 16px", borderRadius: 20, border: "none",
            background: `linear-gradient(135deg, ${T.down}, #FF6B6B)`,
            color: "#FFF", cursor: "pointer", whiteSpace: "nowrap",
          }}>✕ Cancelar test</button>
        ) : (
          <RunBtn onClick={run} disabled={false}>▶ Comparar Todo</RunBtn>
        )}
      </div>

      <div style={{
        display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap", alignItems: "center",
      }}>
        <span style={{ fontFamily: SANS, fontSize: 8, fontWeight: 700,
          color: T.muted, letterSpacing: ".05em" }}>SL%</span>
        {SL_OPTS.map(([lbl, val]) => (
          <SlTpBtn key={val} active={sl === val} onClick={() => setSL(val)} color={T.down}>
            {lbl}
          </SlTpBtn>
        ))}
        <span style={{width:8}}/>
        <span style={{ fontFamily: SANS, fontSize: 8, fontWeight: 700,
          color: T.muted, letterSpacing: ".05em" }}>TP%</span>
        {TP_OPTS.map(([lbl, val]) => (
          <SlTpBtn key={val} active={tp === val} onClick={() => setTP(val)} color={T.up}>
            {lbl}
          </SlTpBtn>
        ))}
      </div>

      <Progress pct={prog} show={running} />
      <StatusLine msg={
        status || "Sin datos · presiona Comparar Todo para procesar XAUUSDT real"
      } />

      {rows && (
        <>
          <ResultTable
            rows={rows}
            footer={`Ordenado por EV/trade · SL ${(sl * 100).toFixed(sl * 100 % 1 === 0 ? 0 : 2)}% · TP ${(tp * 100).toFixed(tp * 100 % 1 === 0 ? 0 : 2)}% · datos reales Binance Futures`}
          />
          <CopyTableBtn rows={rows} sl={sl} tp={tp} />
        </>
      )}
    </BtCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — COMPARAR RATIO + ATR
// Recorre 12 combinaciones (3 ratios × 4 ATRs) con el mismo setup base validado.
// Identifica la combinación óptima en una sola corrida.
// El número de la sección coincide con su posición física en el laboratorio.
// ─────────────────────────────────────────────────────────────────────────────

const RATIO_OPTS: { lbl: string; val: number }[] = [
  { lbl: "1.5×", val: 1.5 },
  { lbl: "1.0×", val: 1.0 },
  { lbl: "0.5×", val: 0.5 },
];
const ATR_OPTS: { lbl: string; val: number }[] = [
  { lbl: "OFF", val: 0   },
  { lbl: "≥10", val: 10  },
  { lbl: "≥15", val: 15  },
  { lbl: "≥20", val: 20  },
];

interface RatioAtrRow extends TableRow {
  minRatio: number;
  atrMin:   number;
}

// Copia tabla Section 4
function CopyRatioAtrBtn({ rows }: { rows: RatioAtrRow[] }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    const date = new Date().toLocaleDateString("es-CO",{day:"2-digit",month:"2-digit",year:"2-digit"});
    const header = `TP3 Comparar Ratio + ATR · XAUUSDT · ${date}\nBase: HTF 1H + Hold 6 + SL 0.75% + TP 3% + EMA200 ON + LDN/NY ON\n`;
    const body = rows.map(r => {
      const ratioLbl = RATIO_OPTS.find(o => o.val === r.minRatio)?.lbl ?? `${r.minRatio}×`;
      const atrLbl   = ATR_OPTS.find(o => o.val === r.atrMin)?.lbl ?? `≥${r.atrMin}`;
      return `Ratio ${ratioLbl.padEnd(4)} · ATR ${atrLbl.padEnd(3)} | ${String(r.total).padStart(3)} señales | WR ${String(r.wr).padStart(2)}% | EV ${(r.ev>=0?"+":"")}${r.ev.toFixed(2)}R`;
    }).join("\n");
    const txt = `${header}\n${body}`;
    try { await navigator.clipboard.writeText(txt); setCopied(true); setTimeout(()=>setCopied(false), 1500); }
    catch (e) { console.error(e); }
  }, [rows]);
  return (
    <button onClick={copy} style={{
      fontFamily: SANS, fontSize: 10, fontWeight: 700,
      padding: "5px 12px", borderRadius: 6, border: `1px solid ${T.border}`,
      background: copied ? T.up : T.s2, color: copied ? "#FFF" : T.text,
      cursor: "pointer", marginTop: 6,
    }}>
      {copied ? "✓ Copiado" : "📋 Copiar tabla"}
    </button>
  );
}

function Section3() {
  const [running, setRun]  = useState(false);
  const [prog,    setProg] = useState(0);
  const [status,  setStat] = useState("");
  const [rows,    setRows] = useState<RatioAtrRow[] | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);

  // Reportar al ResumenContext cuando hay resultados.
  const resumen = useResumen();
  useEffect(() => {
    if (!resumen) return;
    if (rows && rows.length > 0) {
      resumen.setSection3({ rows });
    }
  }, [rows, resumen]);

  const cancel = useCallback(() => {
    ctrlRef.current?.abort();
  }, []);

  const run = useCallback(async () => {
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setRun(true); setProg(5); setStat("Iniciando comparación Ratio + ATR…"); setRows(null);
    const results: RatioAtrRow[] = [];
    const total = RATIO_OPTS.length * ATR_OPTS.length;  // 12
    let done = 0;
    let cancelled = false;

    try {
      for (const ratio of RATIO_OPTS) {
        for (const atr of ATR_OPTS) {
          if (ctrl.signal.aborted) { cancelled = true; break; }
          const lbl = `Ratio ${ratio.lbl} · ATR ${atr.lbl}`;
          setStat(`Simulando ${lbl}… (${done + 1}/${total})`);
          setProg(5 + Math.round((done / total) * 90));
          try {
            await delay(300);
            if (ctrl.signal.aborted) { cancelled = true; break; }
            // Setup base: la config validada
            const res = await runBacktest({
              htf: "1h", mtf: "15m",
              hold: 6, slPct: 0.0075, tpPct: 0.03,
              sessionFilter: true, ema200Filter: true,
              structureFilter: false, spread: SPREAD_TOTAL,
              minRatio: ratio.val,
              atrMin:   atr.val,
            }, ctrl.signal);
            const s = res.summary;
            if (s && s.total > 0) {
              results.push({
                label: lbl,
                total: s.total, wr: s.wr,
                avgW: s.avgW, avgL: s.avgL,
                pnl: s.pnl, ev: s.ev ?? 0,
                minRatio: ratio.val, atrMin: atr.val,
              });
            }
          } catch (e) {
            if (e instanceof DOMException && e.name === "AbortError") {
              cancelled = true; break;
            }
            /* skip failed config */
          }
          done++;
        }
        if (cancelled) break;
      }

      results.sort((a, b) => b.ev - a.ev);
      setRows(results);
      if (cancelled) {
        setStat(`⚠ Test cancelado en ${done}/${total}` + (results.length ? ` · ${results.length} parciales` : ""));
      } else {
        const best = results[0];
        setStat(
          best
            ? `★ Mejor: ${best.label} · EV ${(best.ev>=0?"+":"")}${best.ev.toFixed(2)}R · WR ${best.wr}% · ${best.total} señales`
            : "Sin resultados — verifica conexión a Binance"
        );
      }
    } finally {
      setRun(false); setProg(0);
      ctrlRef.current = null;
    }
  }, []);

  return (
    <BtCard>
      <div style={{
        display: "flex", alignItems: "flex-start",
        justifyContent: "space-between", marginBottom: 10,
      }}>
        <div>
          <div style={{ fontFamily: SANS, fontSize: 11, fontWeight: 700, color: T.text }}>
            Comparar Ratio + ATR · XAUUSDT
          </div>
          <div style={{ fontFamily: SANS, fontSize: 9, color: T.muted, marginTop: 2 }}>
            12 combinaciones · base: HTF 1H + Hold 6 + SL 0.75% + TP 3% + EMA200 + LDN/NY
          </div>
        </div>
        {running ? (
          <button onClick={cancel} style={{
            fontFamily: SANS, fontSize: 10, fontWeight: 700,
            padding: "5px 16px", borderRadius: 20, border: "none",
            background: `linear-gradient(135deg, ${T.down}, #FF6B6B)`,
            color: "#FFF", cursor: "pointer", whiteSpace: "nowrap",
          }}>✕ Cancelar test</button>
        ) : (
          <RunBtn onClick={run} disabled={false}>▶ Comparar Ratio + ATR</RunBtn>
        )}
      </div>

      <Progress pct={prog} show={running} />
      <StatusLine msg={
        status || "Sin datos · presiona Comparar Ratio + ATR para procesar 12 combinaciones"
      } />

      {rows && rows.length > 0 && (
        <>
          {/* Tabla custom para Ratio + ATR */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "1fr 70px 70px 90px",
            gap: 4, marginTop: 8,
            fontFamily: MONO, fontSize: 9,
          }}>
            <div style={{ fontWeight: 700, color: T.muted, padding: "4px 6px",
              borderBottom: `1px solid ${T.border}`, textTransform: "uppercase",
              letterSpacing: ".05em" }}>Combinación</div>
            <div style={{ fontWeight: 700, color: T.muted, padding: "4px 6px",
              borderBottom: `1px solid ${T.border}`, textAlign: "right",
              textTransform: "uppercase", letterSpacing: ".05em" }}>Señales</div>
            <div style={{ fontWeight: 700, color: T.muted, padding: "4px 6px",
              borderBottom: `1px solid ${T.border}`, textAlign: "right",
              textTransform: "uppercase", letterSpacing: ".05em" }}>WR</div>
            <div style={{ fontWeight: 700, color: T.muted, padding: "4px 6px",
              borderBottom: `1px solid ${T.border}`, textAlign: "right",
              textTransform: "uppercase", letterSpacing: ".05em" }}>EV/trade</div>
            {rows.map((r, idx) => {
              const ratioLbl = RATIO_OPTS.find(o => o.val === r.minRatio)?.lbl ?? `${r.minRatio}×`;
              const atrLbl   = ATR_OPTS.find(o => o.val === r.atrMin)?.lbl ?? `≥${r.atrMin}`;
              const isBest   = idx === 0;
              const evColor  = r.ev >= 2.25 ? T.up : r.ev >= 1.5 ? T.wait : T.down;
              return (
                <React.Fragment key={`${r.minRatio}-${r.atrMin}`}>
                  <div style={{ padding: "4px 6px", color: isBest ? T.up : T.text,
                    fontWeight: isBest ? 700 : 400,
                    background: isBest ? `${T.up}10` : "transparent" }}>
                    {isBest ? "🏆 " : "   "}Ratio {ratioLbl} · ATR {atrLbl}
                  </div>
                  <div style={{ padding: "4px 6px", textAlign: "right", color: T.text,
                    background: isBest ? `${T.up}10` : "transparent" }}>{r.total}</div>
                  <div style={{ padding: "4px 6px", textAlign: "right", color: T.text,
                    background: isBest ? `${T.up}10` : "transparent" }}>{r.wr}%</div>
                  <div style={{ padding: "4px 6px", textAlign: "right", color: evColor,
                    fontWeight: 700,
                    background: isBest ? `${T.up}10` : "transparent" }}>
                    {(r.ev >= 0 ? "+" : "")}{r.ev.toFixed(2)}R
                  </div>
                </React.Fragment>
              );
            })}
          </div>
          <div style={{ fontFamily: SANS, fontSize: 8, color: T.dim, marginTop: 6 }}>
            Ordenado por EV/trade · 🏆 = combinación ganadora
          </div>
          <CopyRatioAtrBtn rows={rows} />
        </>
      )}
    </BtCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — COMPARAR R:R con mejor config
// El número de la sección coincide con su posición física en el laboratorio.
// ─────────────────────────────────────────────────────────────────────────────

function Section4() {
  const [running, setRun]  = useState(false);
  const [prog,    setProg] = useState(0);
  const [status,  setStat] = useState("");
  const [rows,    setRows] = useState<TableRow[] | null>(null);
  // Cambio #8 (v5): AbortController por módulo
  const ctrlRef = useRef<AbortController | null>(null);

  // Reportar al ResumenContext cuando hay resultados (top 5 para no saturar).
  const resumen = useResumen();
  useEffect(() => {
    if (!resumen) return;
    if (rows && rows.length > 0) {
      const best = rows[0];
      const baseLabel = best?.label ?? "?";
      // Solo top 5 — suficiente para que Claude vea el ranking
      const top5: RRRow[] = rows.slice(0, 5).map((r) => ({
        ...r,
        slPct: r.slPct,
        tpPct: r.tpPct,
        rr:    r.rr,
      }));
      resumen.setSection4({ rows: top5, baseLabel });
    }
  }, [rows, resumen]);

  const cancel = useCallback(() => {
    ctrlRef.current?.abort();
  }, []);

  const run = useCallback(async () => {
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setRun(true); setProg(5); setStat("Iniciando optimización R:R…"); setRows(null);
    const allRows: TableRow[] = [];
    const total = RR_TEST_CONFIGS.length * RR_COMBOS.length;
    let done = 0;
    let cancelled = false;

    try {
      for (const base of RR_TEST_CONFIGS) {
        for (const combo of RR_COMBOS) {
          if (ctrl.signal.aborted) { cancelled = true; break; }
          const lbl = cfgLabel(base, true);
          setStat(
            `Probando ${lbl} SL${(combo.sl * 100).toFixed(2).replace(".00", "")}% TP${(combo.tp * 100).toFixed(2).replace(".00", "")}%… (${done + 1}/${total})`
          );
          setProg(5 + Math.round((done / total) * 92));
          try {
            await delay(300);
            if (ctrl.signal.aborted) { cancelled = true; break; }
            const res = await runBacktest({
              ...base,
              slPct: combo.sl, tpPct: combo.tp,
              sessionFilter: true, ema200Filter: true,
              structureFilter: false, spread: SPREAD_TOTAL,
            }, ctrl.signal);
            const s = res.summary;
            if (s && s.total > 0) {
              allRows.push({
                label:  lbl,
                slPct:  combo.sl  * 100,
                tpPct:  combo.tp  * 100,
                rr:     combo.tp  / combo.sl,
                total:  s.total,
                wr:     s.wr,
                avgW:   s.avgW,
                avgL:   s.avgL,
                pnl:    s.pnl,
                ev:     s.ev ?? 0,
              });
            }
          } catch (e) {
            if (e instanceof DOMException && e.name === "AbortError") {
              cancelled = true; break;
            }
            /* skip */
          }
          done++;
        }
        if (cancelled) break;
      }

      allRows.sort((a, b) => b.ev - a.ev);
      const top = allRows.slice(0, 20);
      setRows(top);

      if (cancelled) {
        setStat(`⚠ Test cancelado en ${done}/${total}` + (top.length ? ` · ${top.length} parciales en tabla` : ""));
      } else {
        const best = top[0];
        const hasValidation = allRows.some(
          (r) => r.slPct === 1.5 && r.tpPct === 4
        );
        setStat(
          best
            ? `★ Óptimo: ${best.label} SL ${best.slPct?.toFixed(2).replace(".00","")}% TP ${best.tpPct?.toFixed(2).replace(".00","")}%` +
              ` · EV +${best.ev.toFixed(2)}R · WR ${best.wr}%` +
              (hasValidation ? " · ✓ SL1.5%+TP4% validado" : "")
            : "Sin resultados"
        );
      }
    } finally {
      setRun(false); setProg(0);
      ctrlRef.current = null;
    }
  }, []);

  const best = rows?.[0];
  const hasValidation = rows?.some((r) => r.slPct === 1.5 && r.tpPct === 4);

  return (
    <BtCard>
      <div style={{
        display: "flex", alignItems: "flex-start",
        justifyContent: "space-between", marginBottom: 10,
      }}>
        <div>
          <div style={{ fontFamily: SANS, fontSize: 11, fontWeight: 700, color: T.text }}>
            Comparar R:R · Mejor config automática
          </div>
          <div style={{ fontFamily: SANS, fontSize: 9, color: T.muted, marginTop: 2 }}>
            {RR_COMBOS.length} combos SL/TP × {RR_TEST_CONFIGS.length} configs · EMA200 activo · Top 20 por EV
          </div>
        </div>
        {running ? (
          <button onClick={cancel} style={{
            fontFamily: SANS, fontSize: 10, fontWeight: 700,
            padding: "5px 16px", borderRadius: 20, border: "none",
            background: `linear-gradient(135deg, ${T.down}, #FF6B6B)`,
            color: "#FFF", cursor: "pointer", whiteSpace: "nowrap",
          }}>✕ Cancelar test</button>
        ) : (
          <RunBtn onClick={run} disabled={false}>▶ Comparar R:R</RunBtn>
        )}
      </div>

      <Progress pct={prog} show={running} />
      <StatusLine msg={
        status || "Sin datos · presiona Comparar R:R para calcular el óptimo real sobre XAUUSDT"
      } />

      {best && (
        <div style={{
          marginBottom: 8, padding: "6px 10px",
          background: "rgba(0,200,150,0.06)",
          border: `1px solid ${T.upBorder}`, borderRadius: 6,
          fontFamily: SANS, fontSize: 9, color: T.up,
        }}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:6}}>
            <div>
              <span style={{ fontWeight: 700 }}>★ Óptimo absoluto:</span>{" "}
              {best.label} · SL {best.slPct?.toFixed(2).replace(".00","")}%
              {" "}· TP {best.tpPct?.toFixed(2).replace(".00","")}%
              {" "}→ EV{" "}
              <span style={{ fontFamily: MONO, fontWeight: 700 }}>
                +{best.ev.toFixed(2)}R
              </span>
              {" "}· WR{" "}
              <span style={{ fontFamily: MONO, color: wrColor(best.wr) }}>
                {best.wr}%
              </span>
              {" "}· {best.total} señales reales
            </div>
            <CopyRRBtn best={best}/>
          </div>
        </div>
      )}

      {hasValidation && (
        <div style={{
          marginBottom: 8, padding: "5px 10px",
          background: `${T.wait}12`,
          border: `1px solid ${T.wait}30`,
          borderRadius: 5, fontFamily: SANS, fontSize: 9, color: T.wait,
        }}>
          ✓ Validación pasada: SL 1.5% + TP 4% aparece en el ranking
        </div>
      )}

      {rows && (
        <>
          <ResultTable
            rows={rows}
            showSLTP
            footer={`Top 20 de ${RR_TEST_CONFIGS.length * RR_COMBOS.length} combinaciones · ordenadas por EV/trade · EMA200 activo · datos reales Binance Futures XAUUSDT`}
          />
          {best && (
            <div style={{
              marginTop:8,padding:"10px 12px",borderRadius:7,
              background:`${T.up}0A`,border:`1px solid ${T.upBorder}`,
            }}>
              <div style={{fontFamily:SANS,fontSize:9,fontWeight:700,color:T.up,marginBottom:4}}>
                ✅ Configura esto en el terminal
              </div>
              <div style={{fontFamily:MONO,fontSize:13,color:T.text,marginBottom:3}}>
                SL → <strong>{(best.slPct??0).toFixed(2)}%</strong>
                {"   "}·{"   "}
                TP → <strong>{(best.tpPct??0).toFixed(2)}%</strong>
              </div>
              <div style={{fontFamily:SANS,fontSize:9,color:T.muted}}>
                Terminal → sidebar izquierdo → botones SL% y TP% → selecciona esos valores
              </div>
            </div>
          )}
        </>
      )}
    </BtCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RESUMEN PARA CLAUDE — Componente visible arriba del laboratorio
// ─────────────────────────────────────────────────────────────────────────────

function ResumenParaClaude() {
  const ctx = useResumen();
  const [copied, setCopied] = useState(false);

  if (!ctx) return null;
  // section2 = Comparar Configs
  // section3 = Comparar Ratio + ATR
  // section4 = Comparar R:R con mejor config
  const { section2, section3, section4 } = ctx;

  const s2Ready = !!section2 && section2.rows.length > 0;
  const s3Ready = !!section3 && section3.rows.length > 0;
  const s4Ready = !!section4 && section4.rows.length > 0;
  const allReady = s2Ready && s3Ready && s4Ready;

  const missing: string[] = [];
  if (!s2Ready) missing.push("Comparar Configs");
  if (!s3Ready) missing.push("Comparar Ratio + ATR");
  if (!s4Ready) missing.push("Comparar R:R");

  const copyAll = useCallback(async () => {
    if (!allReady || !section2 || !section3 || !section4) return;
    const date = new Date().toLocaleDateString("es-CO", {
      day: "2-digit", month: "2-digit", year: "2-digit",
    });

    const SEP = "═".repeat(55);

    // ── SECCIÓN 2 — Comparar Configs ─────────────────────────────────────────
    const s2Header =
      `📊 SECTION 2 — Comparar Configs\n` +
      `SL ${(section2.sl * 100).toFixed(2)}% · TP ${(section2.tp * 100).toFixed(2)}% · Spread+slippage $1.00`;
    const s2Body = section2.rows
      .map((r) =>
        `${r.label.padEnd(22)} | ${String(r.total).padStart(3)} señales | WR ${String(r.wr).padStart(2)}% | EV ${r.ev >= 0 ? "+" : ""}${r.ev.toFixed(2)}R`
      )
      .join("\n");

    // ── SECCIÓN 3 — Comparar Ratio + ATR ─────────────────────────────────────
    const s3Header =
      `📊 SECTION 3 — Comparar Ratio + ATR (12 combos)\n` +
      `Base: HTF 1H + Hold 6 + SL 0.75% + TP 3% + EMA200 ON + LDN/NY ON`;
    const s3Body = section3.rows
      .map((r) => {
        const ratioLbl = RATIO_OPTS.find((o) => o.val === r.minRatio)?.lbl ?? `${r.minRatio}×`;
        const atrLbl = ATR_OPTS.find((o) => o.val === r.atrMin)?.lbl ?? `≥${r.atrMin}`;
        return `Ratio ${ratioLbl.padEnd(4)} · ATR ${atrLbl.padEnd(3)} | ${String(r.total).padStart(3)} señales | WR ${String(r.wr).padStart(2)}% | EV ${r.ev >= 0 ? "+" : ""}${r.ev.toFixed(2)}R`;
      })
      .join("\n");

    // ── SECCIÓN 4 — Comparar R:R ─────────────────────────────────────────────
    const s4Header =
      `📊 SECTION 4 — Comparar R:R con mejor config\n` +
      `Base: ${section4.baseLabel}`;
    const s4Body = section4.rows
      .map((r) => {
        const slStr = r.slPct != null ? `${r.slPct.toFixed(2)}%` : "?";
        const tpStr = r.tpPct != null ? `${r.tpPct.toFixed(2)}%` : "?";
        const rrStr = r.rr != null ? `${r.rr.toFixed(2)}:1` : "?";
        return `SL ${slStr.padEnd(6)} · TP ${tpStr.padEnd(6)} · R:R ${rrStr.padEnd(7)} | ${String(r.total).padStart(3)} señales | WR ${String(r.wr).padStart(2)}% | EV ${r.ev >= 0 ? "+" : ""}${r.ev.toFixed(2)}R`;
      })
      .join("\n");

    // Orden natural: Section 2 → 3 → 4 (= orden físico del laboratorio)
    const txt =
      `${SEP}\n` +
      `TP3 BACKTEST POST-FIX · XAUUSDT · ${date}\n` +
      `${SEP}\n\n` +
      `${s2Header}\n${s2Body}\n\n` +
      `${s3Header}\n${s3Body}\n\n` +
      `${s4Header}\n${s4Body}\n` +
      `${SEP}`;

    try {
      await navigator.clipboard.writeText(txt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch (e) {
      console.error(e);
    }
  }, [allReady, section2, section3, section4]);

  const StatusRow = ({ ok, label }: { ok: boolean; label: string }) => (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
      fontFamily: MONO, fontSize: 11,
      color: ok ? T.up : T.muted,
    }}>
      <span style={{ fontSize: 13, fontWeight: 700 }}>{ok ? "✓" : "○"}</span>
      <span>{label}</span>
    </div>
  );

  return (
    <BtCard>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <span style={{ fontSize: 16 }}>🎯</span>
        <span style={{
          fontFamily: SANS, fontSize: 12, fontWeight: 700,
          letterSpacing: "0.08em", textTransform: "uppercase", color: T.text,
        }}>
          Resumen para Claude
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 10 }}>
        <StatusRow ok={s2Ready} label="Comparar Configs (Sección 2)" />
        <StatusRow ok={s3Ready} label="Comparar Ratio + ATR (Sección 3)" />
        <StatusRow ok={s4Ready} label="Comparar R:R · Mejor config automática (Sección 4)" />
      </div>
      {!allReady && (
        <div style={{
          fontFamily: SANS, fontSize: 10, color: T.wait,
          marginBottom: 8, padding: "5px 8px",
          background: T.warnBg || T.s2, border: `1px solid ${T.warnBorder || T.border}`,
          borderRadius: 5,
        }}>
          Falta correr: {missing.join(", ")}
        </div>
      )}
      <button
        onClick={copyAll}
        disabled={!allReady}
        style={{
          width: "100%",
          fontFamily: SANS, fontSize: 11, fontWeight: 700,
          padding: "8px 12px", borderRadius: 6,
          border: `1px solid ${copied ? T.up : allReady ? T.accent : T.border}`,
          background: copied ? T.up : allReady ? T.accent : T.s2,
          color: copied || allReady ? "#FFF" : T.muted,
          cursor: allReady ? "pointer" : "not-allowed",
          opacity: allReady ? 1 : 0.6,
          transition: "all 0.2s",
        }}
      >
        {copied ? "✓ Copiado — pegale a Claude" : "📋 Copiar los 3 resultados"}
      </button>
    </BtCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ROOT EXPORT
// ─────────────────────────────────────────────────────────────────────────────

export default function BacktestLaboratory() {
  const [section2, setSection2] = useState<ResumenContextValue["section2"]>(null);
  const [section3, setSection3] = useState<ResumenContextValue["section3"]>(null);
  const [section4, setSection4] = useState<ResumenContextValue["section4"]>(null);

  return (
    <ResumenContext.Provider value={{
      section2, setSection2,
      section3, setSection3,
      section4, setSection4,
    }}>
      <div style={{ background: T.bg, minHeight: "100vh", fontFamily: SANS, color: T.text }}>
        <div style={{ padding: "8px 12px", maxWidth: 940, margin: "0 auto" }}>
          {/* Orden lógico = orden físico = orden numérico:
              Section1 — Manual (test individual)
              Section2 — Comparar Configs        → define qué HTF+MTF+Hold gana
              Section3 — Comparar Ratio + ATR    → define qué Ratio y ATR ganan
              Section4 — Comparar R:R            → define qué SL/TP gana */}
          <Section1 />
          <Section2 />
          <Section3 />
          <Section4 />
          {/* Resumen al final: después de correr las 3 secciones, naturalmente
              bajás scrolleando y aquí está el botón para copiar todo. */}
          <ResumenParaClaude />
        </div>
      </div>
    </ResumenContext.Provider>
  );
}
