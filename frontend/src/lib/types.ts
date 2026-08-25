export type Side = "up" | "down" | "flat";

export type PredictReason = {
  key: string;
  label: string;
  value: number;
  display: string;
};

export type PredictHit = {
  horizon_s: number;
  origin_bar_ts: number;
  origin_close: number;
  side: Side;
  fire: boolean;
  resolved: boolean;
  hit: boolean | null;
  future_close: number | null;
};

export type PredictTest = {
  n: number;
  coverage: number;
  gated_acc: number | null;
  naive_last_acc: number;
  flat_acc: number | null;
  mean_abs_move_bps: number | null;
  expectancy_10bp: number | null;
  expectancy_120bp: number | null;
  brier: number | null;
  logloss: number | null;
  beats_naive_flat: boolean | null;
  beats_naive_gated: boolean | null;
  win_rate?: number | null;
  e_usdc?: number | null;
  naive_e_usdc?: number | null;
};

export type PredictResponse = {
  ts: number;
  symbol: "BTC-USD" | "ETH-USD";
  horizon_s: number;
  p_up: number;
  expected_move_bps: number;
  expected_abs_move_bps?: number;
  confidence: number;
  fire: boolean;
  side: Side;
  reasons: PredictReason[];
  label: "HAUSSIER" | "BAISSIER" | "NEUTRE";
  close: number;
  bar_ts: number | null;
  tau: number;
  min_edge_bps: number;
  gate_block: "prob" | "move" | "warmup" | "error" | "fee" | "midband" | "twap" | "deadzone" | null;
  venue: "coinbase";
  bar_s?: 60 | 300;
  kind?: "lgbm" | "fairvalue";
  test: PredictTest;
  last_hit?: PredictHit | null;
  error: string | null;
};

export type WhyFeature = PredictReason;

export type BookLevel = { p: number; q: number };

export type Book = {
  mid: number;
  obi_10: number;
  tilt: "achat" | "vente" | "neutre";
  bids: BookLevel[];
  asks: BookLevel[];
  spread_bps: number;
};

export type SparkPoint = {
  t: number;
  p: number;
  o?: number;
  h?: number;
  l?: number;
  side: Side | null;
};

export type ClobLevel = { price: number; size: number };
export type SideBook = {
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  bids: ClobLevel[];
  asks: ClobLevel[];
};

export type PolyPosition = {
  id: string;
  asset: "BTC" | "ETH";
  slug: string;
  strat: "intra" | "lock";
  side: "up" | "down";
  shares: number;
  entry_ask: number;
  entry_ts: number;
  entry_fee: number;
};

export type PolyTrade = {
  id: string;
  ts: number;
  asset: "BTC" | "ETH";
  strat: "intra" | "lock";
  side: "up" | "down";
  shares: number;
  entry_ask: number;
  exit_bid: number;
  entry_fee: number;
  exit_fee: number;
  pnl: number;
  hit: boolean | null;
  scratch: boolean;
  reason: string;
};

export type MarketView = {
  market: {
    asset: "BTC" | "ETH";
    slug: string;
    remaining_s: number;
    resolution_source: string;
    twap_window_s: number;
    slot_end_s: number;
  };
  book: { up: SideBook; down: SideBook };
  twap: { value: number; stale: boolean; observed_ts: number; window_s: number } | null;
  strike: { twap: number; late: boolean } | null;
  p_lock_up: number | null;
  lock_skip: string | null;
  predict_intra: PredictResponse;
  predict_slot: PredictResponse;
};

export type PolySnapshot = {
  cash_usdc: number;
  starting_cash_usdc: number;
  equity_usdc: number;
  realized_pnl_usdc: number;
  unrealized_usdc: number;
  fees_usdc: number;
  n: number;
  n_intra: number;
  n_lock: number;
  hits: number;
  hit_rate: number | null;
  n_scratch: number;
  n_skip_stale: number;
  n_skip_nofire: number;
  clip_usdc: number;
  open: PolyPosition[];
  recent: PolyTrade[];
  markets: MarketView[];
  store: "blobs" | "file";
  live_orders: false;
  honest: string;
  fee_formula: string;
  lock_90c_math: string;
};

export type MmSlot = {
  asset: "BTC" | "ETH";
  slug: string;
  slot_start_s: number;
  shares_up: number;
  shares_down: number;
  matched: number;
  paired_cost: number;
  n_maker: number;
  n_taker: number;
};

export type MmQuote = {
  side: "up" | "down";
  bid: number;
  shares: number;
};

export type MmTrade = {
  id: string;
  ts: number;
  asset: "BTC" | "ETH";
  kind: string;
  matched: number;
  paired_cost: number;
  pair_avg: number | null;
  pnl: number;
  reason: string;
};

export type MmTest = {
  n: number;
  e_usdc: number | null;
  e_matched_usdc?: number | null;
  n_matched?: number;
  naive_e_usdc: number | null;
  naive_n: number;
  coverage: number;
  mean_pair: number | null;
  n_taker: number;
  n_maker: number;
  lean_skipped: string;
  note: string;
};

export type MmMarketView = {
  market: { asset: "BTC" | "ETH"; slug: string; remaining_s: number };
  book: { up: SideBook; down: SideBook };
  p_fair: number | null;
  p_clob: number | null;
  quotes: MmQuote[];
  slot: MmSlot | null;
  pair_ask: number | null;
  pair_bid: number | null;
};

export type MmSnapshot = {
  on: true;
  live_orders: false;
  cash_usdc: number;
  starting_cash_usdc: number;
  equity_usdc: number;
  realized_pnl_usdc: number;
  unrealized_usdc: number;
  fees_usdc: number;
  n: number;
  n_pairs: number;
  n_maker_fills: number;
  n_taker_fills: number;
  n_scratch: number;
  hits: number;
  hit_rate: number | null;
  clip_usdc: number;
  quotes: MmQuote[];
  slots: MmSlot[];
  recent: MmTrade[];
  markets: MmMarketView[];
  store: "blobs" | "file";
  honest: string;
  fee_formula: string;
  test: MmTest;
};

export type LiveResponse = {
  symbol: "BTC-USD" | "ETH-USD";
  now: number;
  venue: "coinbase";
  ticker: TickerResponse | null;
  book: Book;
  spark: SparkPoint[];
  predict: { intra: PredictResponse; slot: PredictResponse; h1?: PredictResponse; h4?: PredictResponse };
  poly: PolySnapshot;
  mm?: MmSnapshot;
  error: string | null;
  bar_s: number;
  kind?: "lgbm" | "fairvalue";
  honest: string;
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

export const nfPrice = new Intl.NumberFormat("fr-FR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export const nfPct = new Intl.NumberFormat("fr-FR", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
  signDisplay: "exceptZero",
});

export const nfP = new Intl.NumberFormat("fr-FR", {
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});

export const nfBps = new Intl.NumberFormat("fr-FR", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
  signDisplay: "exceptZero",
});

export const nfUsd = new Intl.NumberFormat("fr-FR", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function fmtCd(s: number): string {
  const x = Math.max(0, Math.round(s));
  const m = Math.floor(x / 60);
  const r = x % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

export function signalColor(label: PredictResponse["label"]): string {
  if (label === "HAUSSIER") return "#3dd68c";
  if (label === "BAISSIER") return "#f0616d";
  return "#c8a46a";
}

export function pctFr(x: number | null | undefined, digits = 1): string {
  if (x == null || !Number.isFinite(x)) return "—";
  return `${(x * 100).toFixed(digits).replace(".", ",")} %`;
}

export function bpsFr(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return "—";
  return `${x.toFixed(1).replace(".", ",")} bp`;
}

export function headsOf(live: LiveResponse): { h1: PredictResponse; h4: PredictResponse } {
  return {
    h1: live.predict.h1 ?? live.predict.intra,
    h4: live.predict.h4 ?? live.predict.slot,
  };
}
