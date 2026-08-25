/** Contrat public unique : UI parle uniquement à ça. Paper Poly est éteint. */

export const PREDICT_SYMBOLS = ["BTC-USD", "ETH-USD"] as const;
export type PredictSymbol = (typeof PREDICT_SYMBOLS)[number];

export const HORIZON_1H_S = 3600;
export const HORIZON_4H_S = 14400;
export const HORIZON_INTRA_S = 60;
export const HORIZON_SLOT_S = 300;
export type PredictHorizon = typeof HORIZON_1H_S | typeof HORIZON_4H_S;

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
  /** Legacy Poly / 1 bp — plus le scoreboard. */
  win_rate?: number | null;
  e_usdc?: number | null;
  naive_n?: number;
  naive_win_rate?: number | null;
  naive_e_usdc?: number | null;
  clip_usdc?: number;
  spread_pad?: number;
  expectancy_1bp?: number | null;
  expectancy_2bp?: number | null;
};

export type PredictGate = "prob" | "warmup" | "error" | "fee" | "midband" | "twap" | "deadzone" | "move" | null;

export type PredictHit = {
  horizon_s: number;
  origin_bar_ts: number;
  origin_close: number;
  side: PredictSide;
  fire: boolean;
  resolved: boolean;
  hit: boolean | null;
  future_close: number | null;
};

/** Contexte CLOB/TWAP conservé pour le paper (éteint) — ignoré par le cerveau 1 h / 4 h. */
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
};

export type PredictResponse = {
  ts: number;
  symbol: PredictSymbol;
  horizon_s: number;
  p_up: number;
  expected_move_bps: number;
  expected_abs_move_bps: number;
  confidence: number;
  fire: boolean;
  side: PredictSide;
  reasons: PredictReason[];
  label: "HAUSSIER" | "BAISSIER" | "NEUTRE";
  close: number;
  bar_ts: number | null;
  tau: number;
  min_edge_bps: number;
  gate_block: PredictGate;
  venue: "coinbase";
  bar_s: 60 | 300;
  kind: "lgbm" | "fairvalue";
  test: PredictTest;
  last_hit: PredictHit | null;
  error: string | null;
  /** Champs paper (éteint) — optionnels. */
  min_edge_usdc?: number;
  edge_usdc?: number;
  fee_usdc?: number;
  p_fair?: number;
  p_clob?: number | null;
  strat?: "intra" | "lock" | null;
  lock_hurdle_90c?: number;
};

export type PredictOpts = {
  symbol: PredictSymbol;
  horizon_s?: number;
  min_edge_bps?: number;
  now?: number;
  /** Ignoré : le cerveau 1 h / 4 h ne lit pas le CLOB. */
  context?: PredictMarketContext;
};

export function isPredictSymbol(s: string | undefined): s is PredictSymbol {
  return s === "BTC-USD" || s === "ETH-USD";
}

export function resolveHorizon(raw: number | undefined): PredictHorizon {
  if (raw == null || Number.isNaN(raw)) return HORIZON_1H_S;
  if (raw >= 7200) return HORIZON_4H_S;
  return HORIZON_1H_S;
}
