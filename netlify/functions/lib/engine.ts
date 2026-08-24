import { snapshotLive, completedKlines } from "./bars";
import { bookFromDepth } from "./book";
import { COINBASE_PRODUCT, fetchStats, fetchTicker, parseTradeTime } from "./coinbase";
import { computeFeatureMap, retBps, rvWindow, sparkFrom, vectorFromMap, whyStrip, WARMUP_BARS } from "./features";
import {
  expectedAbsMoveBps,
  expectedMoveBps,
  pathFromHeads,
  updateForecasts,
} from "./forecasts";
import {
  DEFAULT_FEE_SCHEDULE,
  FEE_SCHEDULES,
  HORIZON_S,
  MAKER_RT_BPS,
  TAKER_RT_BPS,
  type PaperMode,
} from "./paperFees";
import { paperStoreKind, snapshotPaper, stepPaper, setPaperMode, type MarketPx } from "./paper";
import { getHeadCalib, getMeta, listHorizons, predictPUpAt, verifySanity } from "./scorer";
import type { HeadPoint, HealthResponse, LiveResponse, PathPoint, Signal, TickerResponse } from "./types";

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
  calib: ReturnType<typeof getHeadCalib>,
  minMoveBps: number,
  map?: Record<string, number>,
  horizonM = 15,
): Signal {
  const absMove = expectedAbsMoveBps(pUp, calib, map, horizonM);
  const move = expectedMoveBps(pUp, calib, map, horizonM);
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
    why = `P(↑ ${horizonM}m) entre 1−τ ${fmtP(1 - tau)} et τ ${fmtP(tau)} — pas de signal`;
  } else if (!moveGated) {
    gate_block = "move";
    why =
      `|move| prévu ${horizonM}m ${fmtP(absMove)} bp < aller-retour faiseur ${fmtP(minMoveBps)} bp — NEUTRE`;
  } else if (probUp) {
    label = "HAUSSIER";
    side = "up";
    gated = true;
    why = `P(↑ ${horizonM}m) ${fmtP(pUp)} ≥ τ ${fmtP(tau)} et |move| ${fmtP(absMove)} ≥ ${fmtP(minMoveBps)} bp`;
  } else {
    label = "BAISSIER";
    side = "down";
    gated = true;
    why = `P(↑ ${horizonM}m) ${fmtP(pUp)} ≤ 1−τ ${fmtP(1 - tau)} et |move| ${fmtP(absMove)} ≥ ${fmtP(minMoveBps)} bp`;
  }
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

function markSpark(spark: ReturnType<typeof sparkFrom>, forecasts: LiveResponse["forecasts"]) {
  const marks: { t: number; side: (typeof spark)[0]["side"] }[] = [];
  for (const f of forecasts) {
    if (f.horizon_s !== HORIZON_S) continue;
    marks.push({ t: f.ts, side: f.side });
  }
  if (!marks.length) return spark;
  return spark.map((pt) => {
    let best: (typeof spark)[0]["side"] = pt.side;
    let bestD = 90_000;
    for (const m of marks) {
      const d = Math.abs(pt.t - m.t);
      if (d < bestD) {
        bestD = d;
        best = m.side;
      }
    }
    return bestD < 90_000 ? { ...pt, side: best } : pt;
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

function feeBlock() {
  const s = DEFAULT_FEE_SCHEDULE;
  const alt = FEE_SCHEDULES.exchange_60_40;
  return {
    product: s.product,
    schedule: s.label,
    taker_bps: s.taker_bps,
    maker_bps: s.maker_bps,
    maker_rt_bps: MAKER_RT_BPS,
    taker_rt_bps: TAKER_RT_BPS,
    caveat: s.caveat,
    links: s.links,
    alternate: `${alt.label} : ${alt.taker_bps}/${alt.maker_bps} bp`,
  };
}

function emptyLive(error: string | null, paper: Awaited<ReturnType<typeof snapshotPaper>>): LiveResponse {
  const meta = getMeta();
  const tau = meta.tau ?? 0.58;
  const minMove = meta.min_move_bps ?? MAKER_RT_BPS;
  const signal = makeSignal(0.5, 0, HORIZON_S, tau, meta.calib, minMove);
  return {
    signal,
    flux: { ...signal, ret_5_bps: null, rv_60: null },
    book: emptyBook(),
    spark: [],
    forecasts: [],
    heads: [],
    path15: [],
    path30: [],
    why: [],
    paper,
    error,
    kind: "lgbm",
    horizon_s: HORIZON_S,
    bar_s: 60,
    tau,
    min_move_bps: minMove,
    now: Date.now(),
    venue: "coinbase",
    product: "BTC-USD",
    test: {
      ...meta.test,
      mean_abs_move_bps:
        meta.test.mean_abs_move_bps ?? meta.test.all_test_mean_abs_bps ?? null,
    },
    train_n_days: meta.n_days ?? null,
    train_n_bars: meta.n_bars ?? null,
    fee: feeBlock(),
  };
}

export async function buildLive(): Promise<LiveResponse> {
  ensureSanity();
  const meta = getMeta();
  const tau = meta.tau ?? 0.58;
  const minMove = meta.min_move_bps ?? MAKER_RT_BPS;
    const test = {
      ...meta.test,
      mean_abs_move_bps:
        meta.test.mean_abs_move_bps ?? meta.test.all_test_mean_abs_bps ?? null,
    };
  const calib15 = getHeadCalib(15) ?? meta.calib;
  const fee = feeBlock();

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
    const heads: HeadPoint[] = [];
    if (featBars.length >= WARMUP_BARS) {
      rawMap = computeFeatureMap(featBars, { obi_10: book.obi_10 });
      const names = meta.features?.length ? meta.features : Object.keys(rawMap);
      const x = vectorFromMap(rawMap, names);
      for (const hm of listHorizons()) {
        const p = predictPUpAt(x, hm);
        const cal = getHeadCalib(hm);
        const abs = expectedAbsMoveBps(p, cal, rawMap, hm);
        const signed = expectedMoveBps(p, cal, rawMap, hm);
        heads.push({ horizon_m: hm, p_up: p, expected_move_bps: signed, expected_abs_bps: abs });
      }
      const p15 = heads.find((h) => h.horizon_m === 15)?.p_up ?? predictPUpAt(x, 15);
      signal = makeSignal(p15, mid, HORIZON_S, tau, calib15, minMove, rawMap, 15);
    } else {
      signal = makeSignal(0.5, mid, HORIZON_S, tau, calib15, minMove, undefined, 15);
      signal.why = "amorçage Coinbase — bougies 1m (minute en cours exclue)";
      signal.gated = false;
      signal.side = "flat";
      signal.label = "NEUTRE";
    }

    const p30 = heads.find((h) => h.horizon_m === 30)?.p_up ?? 0.5;
    const calib30 = getHeadCalib(30);
    const signal30 = heads.length
      ? makeSignal(p30, mid, 30 * 60, tau, calib30, minMove, rawMap, 30)
      : null;

    const path15: PathPoint[] = heads.length ? pathFromHeads(mid, exchNow, heads, 15) : [];
    const path30: PathPoint[] = heads.length ? pathFromHeads(mid, exchNow, heads, 30) : [];

    const lastBar = klines[klines.length - 1];
    const market: MarketPx = {
      now: wall,
      exch_now: exchNow,
      mid,
      bid: book.bids[0]?.p ?? 0,
      ask: book.asks[0]?.p ?? 0,
      last,
      low: lastBar?.l ?? last,
      high: lastBar?.h ?? last,
      bars: klines.slice(-20).map((k) => ({ t: k.t, h: k.h, l: k.l })),
    };
    const paper = await stepPaper(market, signal);
    const forecasts = updateForecasts({
      now: exchNow,
      mid,
      signal15: signal,
      signal30,
      path15,
      path30,
    });
    const spark = markSpark(sparkFrom(klines, 180), forecasts);
    const ret5 = retBps(featBars.length ? featBars : klines, 5);
    const rv60 = rvWindow(featBars.length ? featBars : klines, 60);
    const why = whyStrip(rawMap, meta.importance, [{ key: "obi_10", value: book.obi_10 }]);

    return {
      signal,
      flux: { ...signal, ret_5_bps: ret5, rv_60: rv60 },
      book,
      spark,
      forecasts,
      heads,
      path15,
      path30,
      why,
      paper,
      error: null,
      kind: "lgbm",
      horizon_s: HORIZON_S,
      bar_s: 60,
      tau,
      min_move_bps: minMove,
      now: exchNow,
      venue: "coinbase",
      product: "BTC-USD",
      test,
      train_n_days: meta.n_days ?? null,
      train_n_bars: meta.n_bars ?? null,
      fee,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : "live_error";
    return emptyLive(error, await snapshotPaper());
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
  const depth = await (await import("./coinbase")).fetchBook(2);
  return bookFromDepth(depth);
}

export async function buildHealth(): Promise<HealthResponse> {
  const meta = getMeta();
  return {
    ok: true,
    kind: "lgbm",
    horizon_s: HORIZON_S,
    bar_s: 60,
    tau: meta.tau,
    min_move_bps: meta.min_move_bps ?? MAKER_RT_BPS,
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
