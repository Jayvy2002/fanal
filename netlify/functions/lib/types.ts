export type Side = "up" | "down" | "flat";

export type Signal = {
  side: Side;
  label: "HAUSSIER" | "BAISSIER" | "NEUTRE";
  p_up: number;
  confidence: number;
  gated: boolean;
  horizon_s: number;
  why: string;
  close: number;
  tau: number;
  expected_move_bps: number;
  target_px: number;
  min_move_bps?: number;
  gate_block?: "prob" | "move" | null;
};

export type WhyFeature = {
  key: string;
  label: string;
  value: number;
  display: string;
};

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

export type PathPoint = { t: number; p: number };

export type Forecast = {
  ts: number;
  side: Exclude<Side, "flat">;
  label: "HAUSSIER" | "BAISSIER";
  mid: number;
  target_px: number;
  expected_move_bps: number;
  resolve_ts: number;
  hit: boolean | null;
  path: PathPoint[];
  horizon_s: number;
  p_up: number;
};

export type PaperRow = {
  ts: number;
  side: Exclude<Side, "flat">;
  label: "HAUSSIER" | "BAISSIER";
  mid: number;
  mid_end: number | null;
  hit: boolean | null;
  signed_bps: number | null;
  horizon_s: number;
  pnl_usd?: number;
  fee_usd?: number;
  entry_role?: "taker" | "maker";
  exit_role?: "taker" | "maker" | "cancel";
  status?: "open" | "pending_entry" | "closed" | "cancelled";
  id?: string;
  posted_px?: number;
  age_s?: number;
};

export type PaperMode = "taker" | "maker";

export type Paper = {
  n: number;
  hits: number;
  hits_after_fees: number;
  hit_rate: number | null;
  hit_rate_after_fees: number | null;
  pending: PaperRow | null;
  remaining_s: number;
  recent: PaperRow[];
  horizon_s: number;
  mode: PaperMode;
  cash_usd: number;
  equity_usd: number;
  realized_pnl_usd: number;
  unrealized_usd: number;
  fees_usd: number;
  starting_cash_usd: number;
  clip_usd: number;
  min_move_bps: number;
  n_cancelled: number;
  n_maker_fills: number;
  n_taker_fills: number;
  fee_product: string;
  fee_tier: string;
  taker_fee_bps: number;
  maker_fee_bps: number;
  round_trip_fee_bps: number;
  round_trip_maker_bps: number;
  round_trip_taker_bps: number;
  fee_caveat: string;
  fee_verified_vs_official: boolean;
  official_advanced_url: string;
  official_exchange_url: string;
  exchange_alternate: {
    product: string;
    taker_bps: number;
    maker_bps: number;
    used: boolean;
  };
  persisted: boolean;
  store: "blobs" | "file";
  started_ts: number;
  updated_ts: number;
  open_position: {
    side: Exclude<Side, "flat">;
    label: "HAUSSIER" | "BAISSIER";
    qty: number;
    entry_px: number;
    role: "taker" | "maker";
    posted_px?: number;
    age_s?: number;
  } | null;
  honest: string;
};

export type TestMeta = {
  gated_acc: number | null;
  n: number;
  coverage: number;
  naive_last_acc: number;
  mean_abs_move_bps?: number | null;
  expectancy_1bp?: number | null;
  expectancy_2bp?: number | null;
  expectancy_maker_rt?: number | null;
  expectancy_taker_rt?: number | null;
};

export type LiveResponse = {
  signal: Signal;
  flux: Signal & { ret_5_bps: number | null; rv_60: number | null };
  book: Book;
  spark: SparkPoint[];
  forecasts: Forecast[];
  why: WhyFeature[];
  paper: Paper;
  paper_signal?: Signal;
  error: string | null;
  kind: "lgbm";
  horizon_s: number;
  paper_horizon_s?: number;
  bar_s: number;
  tau: number;
  min_move_bps: number;
  now: number;
  venue: "coinbase";
  product: "BTC-USD";
  test: TestMeta;
  test_60?: TestMeta & { fallback?: boolean; note?: string };
  swapped_live?: boolean | null;
  coinbase_train?: {
    n_days?: number;
    kept_previous_live?: boolean;
    test?: TestMeta;
  };
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

export type HealthResponse = {
  ok: boolean;
  kind: "lgbm";
  horizon_s: number;
  bar_s: number;
  tau: number;
  min_move_bps?: number;
  symbol: string;
  venue: "coinbase";
  paper: "blobs" | "file";
};
