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
  side: "up" | "down";
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
  side: "up" | "down";
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
};

export type PaperMode = "taker" | "maker";

export type Paper = {
  n: number;
  hits: number;
  hit_rate: number | null;
  pending: PaperRow | null;
  remaining_s: number;
  recent: PaperRow[];
  horizon_s: number;
  mode?: PaperMode;
  cash_usd?: number;
  equity_usd?: number;
  realized_pnl_usd?: number;
  unrealized_usd?: number;
  fees_usd?: number;
  starting_cash_usd?: number;
  clip_usd?: number;
  min_move_bps?: number;
  n_cancelled?: number;
  fee_tier?: string;
  taker_fee_bps?: number;
  maker_fee_bps?: number;
  round_trip_fee_bps?: number;
  persisted?: boolean;
  store?: "blobs" | "file";
  started_ts?: number;
  updated_ts?: number;
  open_position?: {
    side: "up" | "down";
    label: "HAUSSIER" | "BAISSIER";
    qty: number;
    entry_px: number;
    role: "taker" | "maker";
  } | null;
  honest?: string;
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
  kind: string;
  horizon_s: number;
  bar_s: number;
  tau: number;
  min_move_bps?: number;
  now: number;
  venue: string;
  product: string;
  test: {
    gated_acc: number | null;
    n: number;
    coverage: number;
    naive_last_acc: number;
    mean_abs_move_bps?: number | null;
    expectancy_1bp?: number | null;
    expectancy_2bp?: number | null;
  };
  swapped_live?: boolean | null;
  coinbase_train?: {
    n_days?: number;
    kept_previous_live?: boolean;
    test?: LiveResponse["test"];
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

export const nfPrice = new Intl.NumberFormat("fr-FR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export const nfPct = new Intl.NumberFormat("fr-FR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: "exceptZero",
});

export const nfP = new Intl.NumberFormat("fr-FR", {
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});

export const nfBps = new Intl.NumberFormat("fr-FR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: "exceptZero",
});

export const nfUsd = new Intl.NumberFormat("fr-FR", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export const nfQty = new Intl.NumberFormat("fr-FR", {
  minimumFractionDigits: 6,
  maximumFractionDigits: 6,
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
  return `0:${String(x).padStart(2, "0")}`;
}

export function signalColor(label: Signal["label"]): string {
  if (label === "HAUSSIER") return "#3dd68c";
  if (label === "BAISSIER") return "#f0616d";
  return "#c8a46a";
}
