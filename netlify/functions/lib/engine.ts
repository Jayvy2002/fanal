import { bookFromDepth } from "./book";
import type { Book } from "./types";
import {
  candlesToKlines,
  completedKlines,
  fetchBook,
  fetchCandles5m,
  fetchStats,
  fetchTicker,
  isPredictSymbol,
  parseTradeTime,
  predict,
  predictBoth,
  resolveHorizon,
  sparkFrom,
  type PredictSymbol,
} from "./predictor";

export { isPredictSymbol, type PredictSymbol };
import { snapshotPolyPaper } from "./polymarket";
import { snapshotMmPaper, stepMmPaper } from "./polymarket/mmpaper";
import type { PolySnapshot } from "./polymarket";
import type { MmSnapshot } from "./polymarket/mmtypes";
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
  predict: { intra: PredictResponse; slot: PredictResponse; h1: PredictResponse; h4: PredictResponse };
  poly: PolySnapshot;
  mm: MmSnapshot;
  error: string | null;
  bar_s: 300;
  kind: "lgbm";
  honest: string;
};

const HONEST =
  "Paper MM two-sided Polymarket (maker, pair < 1 $). Le prédicteur 1 h / 4 h est un jouet UI et ne trade pas. Aucun ordre live.";

function emptyBook(): Book {
  return { mid: 0, obi_10: 0, tilt: "neutre", bids: [], asks: [], spread_bps: 0 };
}

function emptyPred(): PredictResponse {
  return {
    ts: Date.now(),
    symbol: "BTC-USD",
    horizon_s: 3600,
    p_up: 0.5,
    expected_move_bps: 0,
    expected_abs_move_bps: 0,
    confidence: 0.5,
    fire: false,
    side: "flat",
    reasons: [],
    label: "NEUTRE",
    close: 0,
    bar_ts: null,
    tau: 0.54,
    min_edge_bps: 0,
    gate_block: "error",
    venue: "coinbase",
    bar_s: 300,
    kind: "lgbm",
    test: {
      n: 0,
      coverage: 0,
      gated_acc: null,
      naive_last_acc: 0.5,
      flat_acc: null,
      mean_abs_move_bps: null,
      expectancy_10bp: null,
      expectancy_120bp: null,
      brier: null,
      logloss: null,
      beats_naive_flat: null,
      beats_naive_gated: null,
    },
    last_hit: null,
    error: "indisponible",
  };
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
  try {
    const [ticker, depth, candles, mm, poly, heads] = await Promise.all([
      buildTicker(symbol).catch(() => null),
      fetchBook(symbol, 2).catch(() => null),
      fetchCandles5m(symbol),
      stepMmPaper().catch(() => snapshotMmPaper()),
      snapshotPolyPaper().catch(() => null),
      predictBoth(symbol, undefined, now),
    ]);
    const klines = completedKlines(candlesToKlines(candles), now, 300_000);
    const spark = sparkFrom(klines, 180).map((s) => ({
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
      predict: { intra: heads.h1, slot: heads.h4, h1: heads.h1, h4: heads.h4 },
      poly: poly ?? ({ open: [], recent: [], markets: [], cash_usdc: 1000 } as PolySnapshot),
      mm,
      error: heads.h1.error || heads.h4.error,
      bar_s: 300,
      kind: "lgbm",
      honest: HONEST,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : "live_error";
    const poly = await snapshotPolyPaper().catch(() => null);
    const mm = await snapshotMmPaper().catch(() => null);
    const heads = await predictBoth(symbol, undefined, now).catch(() => null);
    const h1 = heads?.h1 ?? emptyPred();
    const h4 = heads?.h4 ?? emptyPred();
    return {
      symbol,
      now,
      venue: "coinbase",
      ticker: null,
      book: emptyBook(),
      spark: [],
      predict: { intra: h1, slot: h4, h1, h4 },
      poly: poly ?? ({ open: [], recent: [], markets: [], cash_usdc: 1000 } as PolySnapshot),
      mm: mm ?? ({ on: true, live_orders: false, cash_usdc: 1000, slots: [], quotes: [], recent: [], markets: [] } as MmSnapshot),
      error,
      bar_s: 300,
      kind: "lgbm",
      honest: HONEST,
    };
  }
}

export async function buildHealth() {
  return {
    ok: true,
    kind: "lgbm",
    bar_s: 300,
    venue: "coinbase",
    symbols: ["BTC-USD", "ETH-USD"],
    horizons_s: [3600, 14400],
    paper: "mm_v5",
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
      const h = Number(queryParam(raw, "horizon_s") || "3600");
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
      const snap = await stepMmPaper();
      return {
        status: 200,
        body: {
          ok: true,
          tick: "paper-mm",
          n: snap.n,
          cash_usdc: snap.cash_usdc,
          open: snap.slots.length,
          live_orders: false,
        },
      };
    }
    if (p.endsWith("/paper-poly") || p.endsWith("/paper")) {
      const method = (req?.method || "GET").toUpperCase();
      if (method === "OPTIONS") return { status: 204, body: "" };
      if (method === "GET") return { status: 200, body: await snapshotMmPaper() };
      return { status: 405, body: { error: "methode", hint: "GET snapshot paper MM (pas d’ordres live)" } };
    }
    return { status: 404, body: { error: "not_found" } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    return { status: 502, body: { error: msg } };
  }
}
