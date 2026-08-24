import { snapshotLive } from "./bars";
import { bookFromDepth } from "./book";
import { COINBASE_PRODUCT, fetchBook, fetchStats, fetchTicker, parseTradeTime } from "./coinbase";
import { computeFeatureMap, retBps, rvWindow, sparkFrom, vectorFromMap, whyStrip } from "./features";
import { expectedAbsMoveBps, expectedMoveBps, updateForecasts } from "./forecasts";
import { paperStoreKind, snapshotPaper, stepPaper, setPaperMode, type MarketPx } from "./paper";
import type { PaperMode } from "./paperFees";
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
  minMoveBps: number,
  map?: Record<string, number>,
): Signal {
  const absMove = expectedAbsMoveBps(pUp, calib, map);
  const move = expectedMoveBps(pUp, calib, map);
  const probUp = pUp >= tau;
  const probDown = pUp <= 1 - tau;
  const probGated = probUp || probDown;
  const moveGated = absMove >= minMoveBps;
  let label: Signal["label"] = "NEUTRE";
  let side: Signal["side"] = "flat";
  let gated = false;
  let gate_block: Signal["gate_block"] = null;
  let why: string;
  if (!probGated) {
    gate_block = "prob";
    why = `P(↑) entre 1−τ ${fmtP(1 - tau)} et τ ${fmtP(tau)} — pas de signal`;
  } else if (!moveGated) {
    gate_block = "move";
    why = `|move| prévu ${fmtP(absMove)} bp < ${fmtP(minMoveBps)} bp — NEUTRE (coût ~1 bp)`;
  } else if (probUp) {
    label = "HAUSSIER";
    side = "up";
    gated = true;
    why = `P(↑) ${fmtP(pUp)} ≥ τ ${fmtP(tau)} et |move| ${fmtP(absMove)} ≥ ${fmtP(minMoveBps)} bp`;
  } else {
    label = "BAISSIER";
    side = "down";
    gated = true;
    why = `P(↑) ${fmtP(pUp)} ≤ 1−τ ${fmtP(1 - tau)} et |move| ${fmtP(absMove)} ≥ ${fmtP(minMoveBps)} bp`;
  }
  const confidence = side === "down" ? 1 - pUp : side === "up" ? pUp : Math.max(pUp, 1 - pUp);
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
    min_move_bps: minMoveBps,
    gate_block,
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

function featureKlines(klines: { t: number; o: number; h: number; l: number; c: number; v: number; n: number; tb: number }[]) {
  if (klines.length < 2) return klines;
  const last = klines[klines.length - 1];
  // The current second is often ticker-only (v=0). Score the last traded bar.
  if (last.n === 0 && last.v === 0) return klines.slice(0, -1);
  return klines;
}

export async function buildLive(): Promise<LiveResponse> {
  ensureSanity();
  const meta = getMeta();
  const tau = meta.tau;
  const minMove = meta.min_move_bps ?? meta.calib?.min_move_bps ?? 1.0;
  const test = meta.test;
  let error: string | null = null;
  const calib = {
    ...meta.calib,
    mean_abs_bps: meta.test?.mean_abs_move_bps ?? meta.calib?.mean_abs_bps ?? 1,
  };

  try {
    const snap = await snapshotLive();
    const klines = snap.klines;
    const book = bookFromDepth(snap.book);
    const close = snap.last || klines[klines.length - 1]?.c || 0;
    const now = snap.now;

    const featBars = featureKlines(klines);
    let signal: Signal;
    let map: Record<string, number> = {};
    if (featBars.length >= 61) {
      map = computeFeatureMap(featBars);
      const names = meta.features?.length ? meta.features : Object.keys(map);
      const x = vectorFromMap(map, names);
      const pUp = predictPUp(x);
      signal = makeSignal(pUp, close, 5, tau, calib, minMove, map);
    } else {
      signal = makeSignal(0.5, close, 5, tau, calib, minMove);
      signal.why = "amorçage Coinbase — reconstruction des barres 1s";
      signal.gated = false;
      signal.side = "flat";
      signal.label = "NEUTRE";
    }

    let signal15: Signal | null = null;
    if (is15Enabled() && featBars.length >= 61) {
      const meta15 = getMeta15();
      const names15 = meta15.features?.length ? meta15.features : meta.features;
      const x15 = vectorFromMap(map, names15);
      const p15 = predictPUp15(x15);
      const min15 = meta15.min_move_bps ?? meta15.calib?.min_move_bps ?? minMove;
      const calib15 = {
        ...meta15.calib,
        mean_abs_bps: meta15.test?.mean_abs_move_bps ?? meta15.calib?.mean_abs_bps ?? 1,
      };
      signal15 = makeSignal(p15, close, 15, meta15.tau || tau, calib15, min15, map);
    }

    const mid = book.mid || close;
    const lastBar = klines[klines.length - 1];
    const market: MarketPx = {
      now,
      mid,
      bid: book.bids[0]?.p ?? 0,
      ask: book.asks[0]?.p ?? 0,
      last: close,
      low: lastBar?.l ?? close,
      high: lastBar?.h ?? close,
      bars: klines.slice(-12).map((k) => ({ t: k.t, h: k.h, l: k.l })),
    };
    const paper = await stepPaper(market, signal);
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
      min_move_bps: minMove,
      now,
      venue: "coinbase",
      product: "BTC-USD",
      test,
      swapped_live: meta.swapped_live ?? null,
      coinbase_train: meta.coinbase_train,
    };
  } catch (err) {
    error = err instanceof Error ? err.message : "live_error";
    const close = 0;
    const signal = makeSignal(0.5, close, 5, tau, calib, minMove);
    const paper = await snapshotPaper();
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
      min_move_bps: minMove,
      now: Date.now(),
      venue: "coinbase",
      product: "BTC-USD",
      test,
      swapped_live: meta.swapped_live ?? null,
      coinbase_train: meta.coinbase_train,
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

export async function buildHealth(): Promise<HealthResponse> {
  const meta = getMeta();
  return {
    ok: true,
    kind: "lgbm",
    horizon_s: 5,
    bar_s: 1,
    tau: meta.tau,
    min_move_bps: meta.min_move_bps ?? meta.calib?.min_move_bps ?? 1.0,
    symbol: COINBASE_PRODUCT,
    venue: "coinbase",
    paper: await paperStoreKind(),
  };
}

export type ApiRequest = {
  method?: string;
  body?: string;
};

export async function handlePaper(
  req?: ApiRequest,
): Promise<{ status: number; body: unknown }> {
  const method = (req?.method || "GET").toUpperCase();
  if (method === "OPTIONS") return { status: 204, body: "" };
  if (method === "GET") return { status: 200, body: await snapshotPaper() };
  if (method === "POST") {
    let parsed: { mode?: string } = {};
    try {
      parsed = req?.body ? (JSON.parse(req.body) as { mode?: string }) : {};
    } catch {
      return { status: 400, body: { error: "json_invalide" } };
    }
    const mode = parsed.mode as PaperMode | undefined;
    if (mode !== "taker" && mode !== "maker") {
      return { status: 400, body: { error: "mode_invalide", hint: "taker | maker" } };
    }
    return { status: 200, body: await setPaperMode(mode) };
  }
  return { status: 405, body: { error: "methode" } };
}

export async function handleApi(
  path: string,
  req?: ApiRequest,
): Promise<{ status: number; body: unknown }> {
  const p = path.split("?")[0].replace(/\/$/, "") || "/";
  try {
    if (p.endsWith("/health")) return { status: 200, body: await buildHealth() };
    if (p.endsWith("/ticker")) return { status: 200, body: await buildTicker() };
    if (p.endsWith("/book")) return { status: 200, body: await buildBook() };
    if (p.endsWith("/live")) return { status: 200, body: await buildLive() };
    if (p.endsWith("/paper")) return handlePaper(req);
    return { status: 404, body: { error: "not_found" } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    return { status: 502, body: { error: msg } };
  }
}
