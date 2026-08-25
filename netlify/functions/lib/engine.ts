import { bookFromDepth } from "./book";
import type { Book } from "./types";
import {
  candlesToKlines,
  completedKlines,
  fetchBook,
  fetchCandles1m,
  fetchStats,
  fetchTicker,
  getMeta,
  isPredictSymbol,
  parseTradeTime,
  predict,
  predictBoth,
  resolveHorizon,
  sparkFrom,
  type PredictSymbol,
} from "./predictor";

export { isPredictSymbol, type PredictSymbol };
import { snapshotPolyPaper, stepPolyPaper } from "./polymarket";
import type { PolySnapshot } from "./polymarket";
import type { PredictResponse } from "./predictor/contract";

export type SparkPoint = {
  t: number;
  p: number;
  o?: number;
  h?: number;
  l?: number;
  side: "up" | "down" | "flat" | null;
};

export type TickerResponse = {
  symbol: string;
  last: number;
  change: number;
  change_pct: number;
  high: number;
  low: number;
  volume: number;
  ts: number;
};

export type LiveResponse = {
  symbol: PredictSymbol;
  now: number;
  venue: "coinbase";
  ticker: TickerResponse | null;
  book: Book;
  spark: SparkPoint[];
  predict: { intra: PredictResponse; slot: PredictResponse };
  poly: PolySnapshot;
  error: string | null;
  bar_s: 60;
  kind: "lgbm";
  honest: string;
};

function emptyBook(): Book {
  return { mid: 0, obi_10: 0, tilt: "neutre", bids: [], asks: [], spread_bps: 0 };
}

export async function buildTicker(symbol: PredictSymbol = "BTC-USD"): Promise<TickerResponse> {
  const [t, s] = await Promise.all([fetchTicker(symbol), fetchStats(symbol)]);
  const last = +t.price;
  const open = +s.open;
  const change = last - open;
  const change_pct = open > 0 ? (change / open) * 100 : 0;
  return {
    symbol,
    last,
    change,
    change_pct,
    high: +s.high,
    low: +s.low,
    volume: +s.volume,
    ts: parseTradeTime(t.time),
  };
}

export async function buildBook(symbol: PredictSymbol = "BTC-USD") {
  const depth = await fetchBook(symbol, 2);
  return bookFromDepth(depth);
}

export async function buildLive(symbol: PredictSymbol = "BTC-USD"): Promise<LiveResponse> {
  const now = Date.now();
  let error: string | null = null;
  try {
    const [preds, ticker, depth, candles, poly] = await Promise.all([
      predictBoth(symbol),
      buildTicker(symbol).catch(() => null),
      fetchBook(symbol, 2).catch(() => null),
      fetchCandles1m(symbol),
      stepPolyPaper(),
    ]);
    const klines = candlesToKlines(candles);
    const spark = sparkFrom(completedKlines(klines, now), 180).map((s) => ({
      ...s,
      side: null as SparkPoint["side"],
    }));
    const book = depth ? bookFromDepth(depth) : emptyBook();
    return {
      symbol,
      now,
      venue: "coinbase",
      ticker,
      book,
      spark,
      predict: preds,
      poly,
      error: preds.intra.error || preds.slot.error,
      bar_s: 60,
      kind: "lgbm",
      honest: poly.honest,
    };
  } catch (err) {
    error = err instanceof Error ? err.message : "live_error";
    const poly = await snapshotPolyPaper().catch(() => null);
    const intra = await predict({ symbol, horizon_s: 60 }).catch(() => null);
    const slot = await predict({ symbol, horizon_s: 300 }).catch(() => null);
    return {
      symbol,
      now,
      venue: "coinbase",
      ticker: null,
      book: emptyBook(),
      spark: [],
      predict: {
        intra: intra ?? ({} as PredictResponse),
        slot: slot ?? ({} as PredictResponse),
      },
      poly: poly ?? ({ open: [], recent: [], markets: [], cash_usdc: 1000 } as PolySnapshot),
      error,
      bar_s: 60,
      kind: "lgbm",
      honest: "Paper seulement. Aucun ordre live.",
    };
  }
}

export async function buildHealth() {
  const intra = getMeta(60);
  const slot = getMeta(300);
  return {
    ok: true,
    kind: "lgbm",
    bar_s: 60,
    venue: "coinbase",
    symbols: ["BTC-USD", "ETH-USD"],
    horizons_s: [60, 300],
    tau_intra: intra.tau,
    tau_slot: slot.tau,
    min_edge_intra: intra.default_min_edge_bps ?? intra.min_move_bps,
    min_edge_slot: slot.default_min_edge_bps ?? slot.min_move_bps,
    paper: "poly_v3",
    live_orders: false,
  };
}

export type ApiRequest = {
  method?: string;
  body?: string;
  url?: string;
};

function queryParam(path: string, key: string): string | undefined {
  const q = path.split("?")[1];
  if (!q) return undefined;
  return new URLSearchParams(q).get(key) ?? undefined;
}

export async function handleApi(
  path: string,
  req?: ApiRequest,
): Promise<{ status: number; body: unknown }> {
  const raw = path || "/";
  const p = raw.split("?")[0].replace(/\/$/, "") || "/";
  const symbolRaw = queryParam(raw, "symbol");
  const symbol: PredictSymbol = isPredictSymbol(symbolRaw) ? symbolRaw : "BTC-USD";
  try {
    if (p.endsWith("/health")) return { status: 200, body: await buildHealth() };
    if (p.endsWith("/ticker")) return { status: 200, body: await buildTicker(symbol) };
    if (p.endsWith("/book")) return { status: 200, body: await buildBook(symbol) };
    if (p.endsWith("/predict")) {
      const h = Number(queryParam(raw, "horizon_s") || "60");
      const minEdgeRaw = queryParam(raw, "min_edge_bps");
      const min_edge_bps = minEdgeRaw != null ? Number(minEdgeRaw) : undefined;
      const body = await predict({
        symbol,
        horizon_s: resolveHorizon(h),
        min_edge_bps: Number.isFinite(min_edge_bps) ? min_edge_bps : undefined,
      });
      return { status: 200, body };
    }
    if (p.endsWith("/live")) return { status: 200, body: await buildLive(symbol) };
    if (p.endsWith("/paper-poly-tick") || p.endsWith("/paper-tick")) {
      const snap = await stepPolyPaper();
      return {
        status: 200,
        body: { ok: true, tick: "paper-poly", n: snap.n, cash_usdc: snap.cash_usdc, open: snap.open.length },
      };
    }
    if (p.endsWith("/paper-poly") || p.endsWith("/paper")) {
      const method = (req?.method || "GET").toUpperCase();
      if (method === "OPTIONS") return { status: 204, body: "" };
      if (method === "GET") return { status: 200, body: await snapshotPolyPaper() };
      return { status: 405, body: { error: "methode", hint: "GET snapshot paper Polymarket (pas d’ordres live)" } };
    }
    return { status: 404, body: { error: "not_found" } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    return { status: 502, body: { error: msg } };
  }
}
