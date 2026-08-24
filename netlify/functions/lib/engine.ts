import { snapshotLive } from "./bars";
import { bookFromDepth } from "./book";
import { COINBASE_PRODUCT, fetchBook, fetchStats, fetchTicker, parseTradeTime } from "./coinbase";
import { computeFeatureMap, retBps, rvWindow, sparkFrom, vectorFromMap, whyStrip } from "./features";
import { expectedMoveBps, updateForecasts } from "./forecasts";
import { updatePaper } from "./paper";
import { getMeta, getMeta15, is15Enabled, predictPUp, predictPUp15, verifySanity } from "./scorer";
import type { HealthResponse, LiveResponse, Signal, SparkPoint, TickerResponse } from "./types";

let sanityChecked = false;

function ensureSanity() {
  if (sanityChecked) return;
  verifySanity();
  sanityChecked = true;
}

function fmtP(x: number): string {
  return x.toFixed(3).replace(".", ",");
}

function makeSignal(
  pUp: number,
  close: number,
  horizonS: number,
  tau: number,
  calib: ReturnType<typeof getMeta>["calib"],
  meanAbsMove?: number | null,
): Signal {
  let label: Signal["label"] = "NEUTRE";
  let side: Signal["side"] = "flat";
  let gated = false;
  let why: string;
  if (pUp >= tau) {
    label = "HAUSSIER";
    side = "up";
    gated = true;
    why = `P(↑) ${fmtP(pUp)} ≥ τ ${fmtP(tau)}`;
  } else if (pUp <= 1 - tau) {
    label = "BAISSIER";
    side = "down";
    gated = true;
    why = `P(↑) ${fmtP(pUp)} ≤ 1−τ ${fmtP(1 - tau)}`;
  } else {
    why = `P(↑) entre 1−τ ${fmtP(1 - tau)} et τ ${fmtP(tau)} — pas de signal`;
  }
  const confidence = side === "down" ? 1 - pUp : side === "up" ? pUp : Math.max(pUp, 1 - pUp);
  const move = expectedMoveBps(pUp, {
    ...calib,
    mean_abs_bps: meanAbsMove ?? calib?.mean_abs_bps ?? 1,
  });
  const target_px = close * (1 + move / 1e4);
  return {
    side,
    label,
    p_up: pUp,
    confidence,
    gated,
    horizon_s: horizonS,
    why,
    close,
    tau,
    expected_move_bps: move,
    target_px,
  };
}

function markSpark(spark: SparkPoint[], forecasts: LiveResponse["forecasts"]): SparkPoint[] {
  const marks: { t: number; side: SparkPoint["side"] }[] = [];
  for (const f of forecasts) {
    if (f.horizon_s !== 5) continue;
    marks.push({ t: f.ts, side: f.side });
  }
  if (!marks.length) return spark;
  return spark.map((pt) => {
    let best: SparkPoint["side"] = pt.side;
    let bestD = 1500;
    for (const m of marks) {
      const d = Math.abs(pt.t - m.t);
      if (d < bestD) {
        bestD = d;
        best = m.side;
      }
    }
    return bestD < 1500 ? { ...pt, side: best } : pt;
  });
}

function emptyBook() {
  return {
    mid: 0,
    obi_10: 0,
    tilt: "neutre" as const,
    bids: [],
    asks: [],
    spread_bps: 0,
  };
}

export async function buildLive(): Promise<LiveResponse> {
  ensureSanity();
  const meta = getMeta();
  const tau = meta.tau;
  const test = meta.test;
  let error: string | null = null;

  try {
    const snap = await snapshotLive();
    const klines = snap.klines;
    const book = bookFromDepth(snap.book);
    const close = snap.last || klines[klines.length - 1]?.c || 0;
    const now = snap.now;

    let signal: Signal;
    let map: Record<string, number> = {};
    if (klines.length >= 61) {
      map = computeFeatureMap(klines);
      const names = meta.features?.length ? meta.features : Object.keys(map);
      const x = vectorFromMap(map, names);
      const pUp = predictPUp(x);
      signal = makeSignal(pUp, close, 5, tau, meta.calib, meta.test?.mean_abs_move_bps);
    } else {
      signal = makeSignal(0.5, close, 5, tau, meta.calib);
      signal.why = "amorçage Coinbase — reconstruction des barres 1s";
      signal.gated = false;
      signal.side = "flat";
      signal.label = "NEUTRE";
    }

    let signal15: Signal | null = null;
    if (is15Enabled() && klines.length >= 61) {
      const meta15 = getMeta15();
      const names15 = meta15.features?.length ? meta15.features : meta.features;
      const x15 = vectorFromMap(map, names15);
      const p15 = predictPUp15(x15);
      signal15 = makeSignal(p15, close, 15, meta15.tau || tau, meta15.calib, meta15.test?.mean_abs_move_bps);
    }

    const mid = book.mid || close;
    const paper = updatePaper(now, mid, signal);
    const forecasts = updateForecasts({ now, mid, signal5: signal, signal15 });
    const spark = markSpark(sparkFrom(klines, 300), forecasts);
    const ret5 = retBps(klines, 5);
    const rv60 = rvWindow(klines, 60);
    const why = whyStrip(map, meta.importance, [{ key: "obi_10", value: book.obi_10 }]);

    return {
      signal,
      flux: { ...signal, ret_5_bps: ret5, rv_60: rv60 },
      book,
      spark,
      forecasts,
      why,
      paper,
      error,
      kind: "lgbm",
      horizon_s: 5,
      bar_s: 1,
      tau,
      now,
      venue: "coinbase",
      product: "BTC-USD",
      test,
    };
  } catch (err) {
    error = err instanceof Error ? err.message : "live_error";
    const close = 0;
    const signal = makeSignal(0.5, close, 5, tau, meta.calib);
    const paper = updatePaper(Date.now(), 0, { ...signal, gated: false, side: "flat", label: "NEUTRE" });
    return {
      signal,
      flux: { ...signal, ret_5_bps: null, rv_60: null },
      book: emptyBook(),
      spark: [],
      forecasts: [],
      why: [],
      paper,
      error,
      kind: "lgbm",
      horizon_s: 5,
      bar_s: 1,
      tau,
      now: Date.now(),
      venue: "coinbase",
      product: "BTC-USD",
      test,
    };
  }
}

export async function buildTicker(): Promise<TickerResponse> {
  const [t, s] = await Promise.all([fetchTicker(), fetchStats()]);
  const last = +t.price;
  const open = +s.open;
  const change = last - open;
  const change_pct = open > 0 ? (change / open) * 100 : 0;
  return {
    symbol: COINBASE_PRODUCT,
    last,
    change,
    change_pct,
    high: +s.high,
    low: +s.low,
    volume: +s.volume,
    ts: parseTradeTime(t.time),
  };
}

export async function buildBook() {
  const depth = await fetchBook(2);
  return bookFromDepth(depth);
}

export function buildHealth(): HealthResponse {
  const meta = getMeta();
  return {
    ok: true,
    kind: "lgbm",
    horizon_s: 5,
    bar_s: 1,
    tau: meta.tau,
    symbol: COINBASE_PRODUCT,
    venue: "coinbase",
    paper: "memory",
  };
}

export async function handleApi(
  path: string,
): Promise<{ status: number; body: unknown }> {
  const p = path.split("?")[0].replace(/\/$/, "") || "/";
  try {
    if (p.endsWith("/health")) return { status: 200, body: buildHealth() };
    if (p.endsWith("/ticker")) return { status: 200, body: await buildTicker() };
    if (p.endsWith("/book")) return { status: 200, body: await buildBook() };
    if (p.endsWith("/live")) return { status: 200, body: await buildLive() };
    return { status: 404, body: { error: "not_found" } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    return { status: 502, body: { error: msg } };
  }
}
