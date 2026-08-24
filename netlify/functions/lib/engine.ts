import { fetchDepth, fetchKlines, fetchTicker } from "./binance";
import { bookFromDepth } from "./book";
import { computeFeatures, retBps, rvWindow, sparkFrom } from "./features";
import { getMeta, predictPUp, verifySanity } from "./scorer";
import { updatePaper } from "./paper";
import type {
  HealthResponse,
  LiveResponse,
  Signal,
  SparkPoint,
  TickerResponse,
} from "./types";

let sanityChecked = false;

function ensureSanity() {
  if (sanityChecked) return;
  verifySanity();
  sanityChecked = true;
}

function fmtP(x: number): string {
  return x.toFixed(3).replace(".", ",");
}

function makeSignal(pUp: number, close: number): Signal {
  const tau = getMeta().tau;
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
  return {
    side,
    label,
    p_up: pUp,
    confidence,
    gated,
    horizon_s: 5,
    why,
    close,
    tau,
  };
}

function markSpark(spark: SparkPoint[], paper: LiveResponse["paper"]): SparkPoint[] {
  const marks: { t: number; side: SparkPoint["side"] }[] = [];
  for (const row of paper.recent) marks.push({ t: row.ts, side: row.side });
  if (paper.pending) marks.push({ t: paper.pending.ts, side: paper.pending.side });
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
    const [klines, depth] = await Promise.all([fetchKlines(400), fetchDepth(20)]);
    const x = computeFeatures(klines);
    const pUp = predictPUp(x);
    const close = klines[klines.length - 1].c;
    const signal = makeSignal(pUp, close);
    const book = bookFromDepth(depth);
    const now = klines[klines.length - 1].t;
    const paper = updatePaper(now, book.mid || close, signal);
    const spark = markSpark(sparkFrom(klines, 180), paper);
    const ret5 = retBps(klines, 5);
    const rv60 = rvWindow(klines, 60);
    return {
      signal,
      flux: { ...signal, ret_5_bps: ret5, rv_60: rv60 },
      book,
      spark,
      paper,
      error,
      kind: "lgbm",
      horizon_s: 5,
      bar_s: 1,
      tau,
      test,
    };
  } catch (err) {
    error = err instanceof Error ? err.message : "live_error";
    const close = 0;
    const signal = makeSignal(0.5, close);
    const paper = updatePaper(Date.now(), 0, { ...signal, gated: false, side: "flat", label: "NEUTRE" });
    return {
      signal,
      flux: { ...signal, ret_5_bps: null, rv_60: null },
      book: emptyBook(),
      spark: [],
      paper,
      error,
      kind: "lgbm",
      horizon_s: 5,
      bar_s: 1,
      tau,
      test,
    };
  }
}

export async function buildTicker(): Promise<TickerResponse> {
  const t = await fetchTicker();
  return {
    symbol: t.symbol,
    last: +t.lastPrice,
    change: +t.priceChange,
    change_pct: +t.priceChangePercent,
    high: +t.highPrice,
    low: +t.lowPrice,
    volume: +t.volume,
    ts: t.closeTime,
  };
}

export async function buildBook() {
  const depth = await fetchDepth(20);
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
    symbol: "BTCUSDT",
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
