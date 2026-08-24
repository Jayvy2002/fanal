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
};

export type Paper = {
  n: number;
  hits: number;
  hit_rate: number | null;
  pending: PaperRow | null;
  remaining_s: number;
  recent: PaperRow[];
  horizon_s: number;
};

export type TestMeta = {
  gated_acc: number | null;
  n: number;
  coverage: number;
  naive_last_acc: number;
  mean_abs_move_bps?: number | null;
  expectancy_1bp?: number | null;
  expectancy_2bp?: number | null;
};

export type LiveResponse = {
  signal: Signal;
  flux: Signal & { ret_5_bps: number | null; rv_60: number | null };
  book: Book;
  spark: SparkPoint[];
  forecasts: Forecast[];
  why: WhyFeature[];
  paper: Paper;
  error: string | null;
  kind: "lgbm";
  horizon_s: number;
  bar_s: number;
  tau: number;
  min_move_bps: number;
  now: number;
  venue: "coinbase";
  product: "BTC-USD";
  test: TestMeta;
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
  paper: "memory";
};
