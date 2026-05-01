// ─────────────────────────────────────────────────────────────────────────────
// lib/engine/signals.ts
// Signal detection logic. Pure functions — no I/O, no state, no framework.
// Faithful port of original index.html lines 1960-1996.
// ─────────────────────────────────────────────────────────────────────────────

import { Candle, PrecomputedIndicators, RawSignal, SignalDirection } from "./types";

interface HTFResult {
  sig:   SignalDirection;
  em200: number | null;
}

/** HTF signal scoring — exact port of original lines 1960-1971 */
export function htfSignalAt(ind: PrecomputedIndicators, i: number): HTFResult {
  const { closes, rsi6, ema12, ema26, ema50, ema200, boll } = ind;
  const price = closes[i];
  const r     = rsi6[i];
  const b     = boll[i];
  const macd  = ema12[i] != null && ema26[i] != null ? ema12[i]! - ema26[i]! : null;
  const em200 = ema200[i];
  const em50  = ema50[i];

  let up = 0, dn = 0;
  if (r != null && b) {
    if      (r < 25 && price < b.l) up += 2;
    else if (r > 75 && price > b.u) dn += 2;
    else if (r < 30) up++;
    else if (r > 70) dn++;
  } else if (r != null) {
    r < 30 ? up++ : r > 70 ? dn++ : null;
  }
  if (macd != null)  macd > 0  ? up++ : dn++;
  if (em200 != null) price > em200 ? up++ : dn++;
  if (em50 != null)  price > em50  ? up++ : dn++;

  const sig: SignalDirection =
    up > dn && up >= 2 ? "UP" : dn > up && dn >= 2 ? "DOWN" : "WAIT";
  return { sig, em200 };
}

/** MTF confirmation signal — exact port of original lines 1988-1993 */
export function mtfSignalAt(ind: PrecomputedIndicators, i: number): SignalDirection {
  const { closes, rsi12, ema50, boll } = ind;
  const price = closes[i];
  const r     = rsi12[i];
  const b     = boll[i];
  const em50  = ema50[i];

  let up = 0, dn = 0;
  if (r != null && b) {
    if      (r < 25 && price < b.l) up += 2;
    else if (r > 75 && price > b.u) dn += 2;
    else if (r < 30) up++;
    else if (r > 70) dn++;
  } else if (r != null) {
    r < 30 ? up++ : r > 70 ? dn++ : null;
  }
  if (em50 != null) price > em50 ? up++ : dn++;

  return up > dn && up >= 2 ? "UP" : dn > up && dn >= 2 ? "DOWN" : "WAIT";
}

/** Full signal detection loop — port of original lines 1947-2000 */
export function detectSignals(
  htfCandles:  Candle[],
  mtfCandles:  Candle[],
  htfInd:      PrecomputedIndicators,
  mtfInd:      PrecomputedIndicators,
  cfg: {
    holdCandles:    number;
    sessionFilter:  boolean;
    ema200Filter:   boolean;
  }
): RawSignal[] {
  const { holdCandles, sessionFilter, ema200Filter } = cfg;

  // Build HTF→MTF time alignment map in O(N+M) — avoids O(N×M) inner loop
  const mtfMap = new Map<number, number>();
  let mj = 0;
  for (let i = 0; i < htfCandles.length; i++) {
    const t = htfCandles[i].t;
    while (mj < mtfCandles.length - 1 && mtfCandles[mj].t < t) mj++;
    mtfMap.set(i, mj);
  }

  const signals: RawSignal[] = [];

  for (let i = 50; i < htfCandles.length - holdCandles; i++) {
    // Session filter: LDN (UTC 08:00–10:00) and NY (UTC 14:30–16:30)
    if (sessionFilter) {
      const d       = new Date(htfCandles[i].t);
      const utcMin  = d.getUTCHours() * 60 + d.getUTCMinutes();
      const inLDN   = utcMin >= 480 && utcMin < 600;
      const inNY    = utcMin >= 870 && utcMin < 990;
      if (!inLDN && !inNY) continue;
    }

    const { sig: hSig, em200 } = htfSignalAt(htfInd, i);
    if (hSig === "WAIT") continue;

    if (ema200Filter && em200 != null) {
      if (hSig === "UP"   && htfInd.closes[i] < em200) continue;
      if (hSig === "DOWN" && htfInd.closes[i] > em200) continue;
    }

    const mtfIdx = mtfMap.get(i) ?? -1;
    if (mtfIdx < 30) continue;

    const mSig = mtfSignalAt(mtfInd, mtfIdx);
    if (hSig !== mSig) continue;

    const entryP =
      i + 1 < htfCandles.length ? htfCandles[i + 1].o : htfCandles[i].c;

    signals.push({
      sig:       hSig,
      entry:     entryP,
      htfFuture: htfCandles.slice(
        i + 1,
        Math.min(i + 1 + holdCandles + 2, htfCandles.length)
      ),
      date: new Date(htfCandles[i].t).toLocaleDateString("es-CO", {
        month: "2-digit",
        day:   "2-digit",
      }),
    });
  }

  return signals;
}

// ── Live MTF verdict (used by LiveTerminal without running a full backtest) ───

export interface LiveVerdict {
  htf:       SignalDirection;
  mtf:       SignalDirection;
  verdict:   "ENTRAR LONG" | "ENTRAR SHORT" | "ESPERAR";
  strength:  "FUERTE" | "MODERADO" | "DÉBIL";
  ema200:    number | null;
  rsi:       number | null;
}

export function getLiveVerdict(
  htfInd:   PrecomputedIndicators,
  mtfInd:   PrecomputedIndicators,
  htfIdx:   number,
  mtfIdx:   number
): LiveVerdict {
  const { sig: hSig, em200 } = htfSignalAt(htfInd, htfIdx);
  const mSig = mtfSignalAt(mtfInd, mtfIdx);
  const rsi  = htfInd.rsi6[htfIdx];

  let verdict: LiveVerdict["verdict"]  = "ESPERAR";
  let strength: LiveVerdict["strength"] = "DÉBIL";

  if (hSig === "UP"   && mSig === "UP")   { verdict = "ENTRAR LONG";  strength = "FUERTE";   }
  if (hSig === "DOWN" && mSig === "DOWN") { verdict = "ENTRAR SHORT"; strength = "FUERTE";   }
  if (hSig === "UP"   && mSig === "WAIT") { verdict = "ENTRAR LONG";  strength = "MODERADO"; }
  if (hSig === "DOWN" && mSig === "WAIT") { verdict = "ENTRAR SHORT"; strength = "MODERADO"; }

  return { htf: hSig, mtf: mSig, verdict, strength, ema200: em200, rsi };
}
