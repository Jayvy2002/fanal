import { snapshotLive, completedKlines } from "./bars";
import { bookFromDepth } from "./book";
import { COINBASE_PRODUCT, fetchBook, fetchStats, fetchTicker, parseTradeTime } from "./coinbase";
import { computeFeatureMap, retBps, rvWindow, sparkFrom, vectorFromMap, whyStrip } from "./features";
import { expectedAbsMoveBps, expectedMoveBps, updateForecasts } from "./forecasts";
import {
  paperStoreKind,
  snapshotPaper,
  stepPaper,
  setPaperConfig,
  type MarketPx,
} from "./paper";
import { DEFAULT_PAPER_HORIZON_S, isPaperHorizon, type PaperMode } from "./paperFees";
import { getMeta, getMeta15, getMeta60, is15Enabled, predictPUp, predictPUp15, verifySanity } from "./scorer";
import { buildSignal60, emptySignal60 } from "./signal60";
import type { HealthResponse, LiveResponse, Signal, SparkPoint, TickerResponse } from "./types";
import { adaptLiveFeatures } from "./venue";

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
  const moveGated = absMove >= minMoveBps - 1e-12;
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
  /* Belt: never report gated if |move| < min (train/serve formula must agree). */
  if (gated && absMove < minMoveBps - 1e-12) {
    gated = false;
    side = "flat";
    label = "NEUTRE";
    gate_block = "move";
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

export async function buildLive(): Promise<LiveResponse> {
  ensureSanity();
  const meta = getMeta();
  const tau = meta.tau;
  const minMove = meta.min_move_bps ?? meta.calib?.min_move_bps ?? 1.0;
  const test = meta.test;
  let error: string | null = null;
  const calib = meta.calib;

  try {
    const snap = await snapshotLive();
    const klines = snap.klines;
    const book = bookFromDepth(snap.book);
    const exchNow = snap.now;
    const wall = Date.now();
    const last = snap.last || klines[klines.length - 1]?.c || 0;
    const mid = book.mid || last;
    const featBars = completedKlines(klines, wall);

    let signal: Signal;
    let rawMap: Record<string, number> = {};
    let modelMap: Record<string, number> = {};
    if (featBars.length >= 61) {
      rawMap = computeFeatureMap(featBars);
      modelMap = adaptLiveFeatures(rawMap, meta.train_archive);
      const names = meta.features?.length ? meta.features : Object.keys(modelMap);
      const x = vectorFromMap(modelMap, names);
      const pUp = predictPUp(x);
      signal = makeSignal(pUp, mid, 5, tau, calib, minMove, modelMap);
    } else {
      signal = makeSignal(0.5, mid, 5, tau, calib, minMove);
      signal.why = "amorçage Coinbase — reconstruction des barres 1s (barre courante exclue)";
      signal.gated = false;
      signal.side = "flat";
      signal.label = "NEUTRE";
    }

    let signal15: Signal | null = null;
    if (is15Enabled() && featBars.length >= 61) {
      const meta15 = getMeta15();
      const names15 = meta15.features?.length ? meta15.features : meta.features;
      const map15 = adaptLiveFeatures(rawMap, meta15.train_archive ?? meta.train_archive);
      const x15 = vectorFromMap(map15, names15);
      const p15 = predictPUp15(x15);
      const min15 = meta15.min_move_bps ?? meta15.calib?.min_move_bps ?? minMove;
      signal15 = makeSignal(p15, mid, 15, meta15.tau || tau, meta15.calib, min15, map15);
    }

    const lastBar = klines[klines.length - 1];
    let signal60 = emptySignal60(mid, "amorçage Coinbase — reconstruction des barres 1s (barre courante exclue)");
    if (featBars.length >= 61) {
      const built = buildSignal60(rawMap, signal.p_up, mid);
      signal60 = built.signal;
    }
    const market: MarketPx = {
      now: wall,
      exch_now: exchNow,
      mid,
      bid: book.bids[0]?.p ?? 0,
      ask: book.asks[0]?.p ?? 0,
      last,
      low: lastBar?.l ?? last,
      high: lastBar?.h ?? last,
      /* 60s trade-through : assez de barres 1s (cron 1 min + horizon). */
      bars: klines.slice(-180).map((k) => ({ t: k.t, h: k.h, l: k.l })),
    };
    const paper = await stepPaper(market, { five: signal, sixty: signal60 });
    const forecasts = updateForecasts({ now: exchNow, mid, signal5: signal, signal15 });
    const spark = markSpark(sparkFrom(klines, 300), forecasts);
    const ret5 = retBps(featBars.length ? featBars : klines, 5);
    const rv60 = rvWindow(featBars.length ? featBars : klines, 60);
    const why = whyStrip(rawMap, meta.importance, [{ key: "obi_10", value: book.obi_10 }]);
    const meta60 = getMeta60();

    const t60raw = meta60.test as typeof meta60.test & {
      ungated_tau_only?: {
        gated_acc?: number | null;
        n?: number;
        coverage?: number;
        mean_abs_move_bps?: number | null;
        expectancy_maker_rt?: number | null;
        expectancy_taker_rt?: number | null;
      };
    };
    const ungated60 = t60raw.ungated_tau_only;

    return {
      signal,
      paper_signal: signal60,
      flux: { ...signal, ret_5_bps: ret5, rv_60: rv60 },
      book,
      spark,
      forecasts,
      why,
      paper,
      error,
      kind: "lgbm",
      horizon_s: 5,
      paper_horizon_s: paper.horizon_s ?? DEFAULT_PAPER_HORIZON_S,
      bar_s: 1,
      tau,
      min_move_bps: minMove,
      now: exchNow,
      venue: "coinbase",
      product: "BTC-USD",
      test,
      test_60: {
        gated_acc: t60raw.gated_acc ?? null,
        n: t60raw.n ?? 0,
        coverage: t60raw.coverage ?? 0,
        naive_last_acc: t60raw.naive_last_acc ?? 0,
        mean_abs_move_bps: t60raw.mean_abs_move_bps ?? ungated60?.mean_abs_move_bps ?? null,
        expectancy_1bp: t60raw.expectancy_1bp ?? null,
        expectancy_2bp: t60raw.expectancy_2bp ?? null,
        expectancy_maker_rt: t60raw.expectancy_maker_rt ?? ungated60?.expectancy_maker_rt ?? null,
        expectancy_taker_rt: t60raw.expectancy_taker_rt ?? ungated60?.expectancy_taker_rt ?? null,
        fallback: meta60.fallback === true,
        note: meta60.honest ?? meta60.note,
      },
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
      paper_signal: emptySignal60(close, error),
      flux: { ...signal, ret_5_bps: null, rv_60: null },
      book: emptyBook(),
      spark: [],
      forecasts: [],
      why: [],
      paper,
      error,
      kind: "lgbm",
      horizon_s: 5,
      paper_horizon_s: paper.horizon_s ?? DEFAULT_PAPER_HORIZON_S,
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
    let parsed: { mode?: string; horizonSec?: number } = {};
    try {
      parsed = req?.body ? (JSON.parse(req.body) as { mode?: string; horizonSec?: number }) : {};
    } catch {
      return { status: 400, body: { error: "json_invalide" } };
    }
    const mode = parsed.mode as PaperMode | undefined;
    const horizonSec = parsed.horizonSec;
    if (mode != null && mode !== "taker" && mode !== "maker") {
      return { status: 400, body: { error: "mode_invalide", hint: "taker | maker" } };
    }
    if (horizonSec != null && !isPaperHorizon(Number(horizonSec))) {
      return { status: 400, body: { error: "horizon_invalide", hint: "5 | 60" } };
    }
    if (mode == null && horizonSec == null) {
      return { status: 400, body: { error: "mode_invalide", hint: "taker | maker, horizonSec 5 | 60" } };
    }
    return {
      status: 200,
      body: await setPaperConfig({
        mode,
        horizonSec: horizonSec != null ? Number(horizonSec) : undefined,
      }),
    };
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
    if (p.endsWith("/paper-tick")) {
      const live = await buildLive();
      return {
        status: 200,
        body: { ok: true, tick: "paper", n: live.paper?.n ?? 0, remaining_s: live.paper?.remaining_s ?? 0 },
      };
    }
    if (p.endsWith("/paper")) return handlePaper(req);
    return { status: 404, body: { error: "not_found" } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    return { status: 502, body: { error: msg } };
  }
}
