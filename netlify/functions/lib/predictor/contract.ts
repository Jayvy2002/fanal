/** Contrat public unique : UI et bot paper parlent uniquement à ça. */

export const PREDICT_SYMBOLS = ["BTC-USD", "ETH-USD"] as const;
export type PredictSymbol = (typeof PREDICT_SYMBOLS)[number];

export const HORIZON_INTRA_S = 60;
export const HORIZON_SLOT_S = 300;
export type PredictHorizon = typeof HORIZON_INTRA_S | typeof HORIZON_SLOT_S;

export type PredictSide = "up" | "down" | "flat";

export type PredictReason = {
  key: string;
  label: string;
  value: number;
  display: string;
};

export type PredictTest = {
  n: number;
  coverage: number;
  win_rate: number | null;
  e_usdc: number | null;
  naive_n: number;
  naive_win_rate: number | null;
  naive_e_usdc: number | null;
  clip_usdc: number;
  spread_pad: number;
  /** Legacy LightGBM spot — plus le scoreboard. */
  gated_acc: number | null;
  naive_last_acc: number;
  mean_abs_move_bps: number | null;
  expectancy_1bp: number | null;
  expectancy_2bp: number | null;
};

export type PredictGate =
  | "prob"
  | "move"
  | "warmup"
  | "error"
  | "fee"
  | "midband"
  | "twap"
  | "deadzone"
  | null;

export type PredictMarketContext = {
  remaining_s: number;
  twap: number | null;
  twap_stale: boolean;
  strike: number | null;
  strike_late: boolean;
  has_strike: boolean;
  up_ask: number;
  up_bid: number;
  down_ask: number;
  down_bid: number;
  rv_1m?: number;
};

export type PredictResponse = {
  ts: number;
  symbol: PredictSymbol;
  horizon_s: number;
  p_up: number;
  expected_move_bps: number;
  confidence: number;
  fire: boolean;
  side: PredictSide;
  reasons: PredictReason[];
  label: "HAUSSIER" | "BAISSIER" | "NEUTRE";
  close: number;
  bar_ts: number | null;
  tau: number;
  min_edge_bps: number;
  min_edge_usdc: number;
  edge_usdc: number;
  fee_usdc: number;
  p_fair: number;
  p_clob: number | null;
  strat: "intra" | "lock" | null;
  lock_hurdle_90c: number;
  gate_block: PredictGate;
  venue: "coinbase";
  bar_s: 60;
  kind: "fairvalue";
  test: PredictTest;
  error: string | null;
};

export type PredictOpts = {
  symbol: PredictSymbol;
  horizon_s?: number;
  /** Conservé pour compat API ; le feu est en USDC (frais Poly). */
  min_edge_bps?: number;
  now?: number;
  context?: PredictMarketContext;
};

export function isPredictSymbol(s: string | undefined): s is PredictSymbol {
  return s === "BTC-USD" || s === "ETH-USD";
}

export function resolveHorizon(raw: number | undefined): PredictHorizon {
  if (raw == null || Number.isNaN(raw)) return HORIZON_INTRA_S;
  if (raw >= 180) return HORIZON_SLOT_S;
  return HORIZON_INTRA_S;
}
