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
  gated_acc: number | null;
  n: number;
  coverage: number;
  naive_last_acc: number;
  mean_abs_move_bps: number | null;
  expectancy_1bp: number | null;
  expectancy_2bp: number | null;
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
  gate_block: "prob" | "move" | "warmup" | "error" | null;
  venue: "coinbase";
  bar_s: 60;
  kind: "lgbm";
  test: PredictTest;
  error: string | null;
};

export type PredictOpts = {
  symbol: PredictSymbol;
  horizon_s?: number;
  /** Seuil |move| du consommateur. Défaut = conservateur (meta du modèle). */
  min_edge_bps?: number;
  now?: number;
};

export function isPredictSymbol(s: string | undefined): s is PredictSymbol {
  return s === "BTC-USD" || s === "ETH-USD";
}

export function resolveHorizon(raw: number | undefined): PredictHorizon {
  if (raw == null || Number.isNaN(raw)) return HORIZON_INTRA_S;
  if (raw >= 180) return HORIZON_SLOT_S;
  return HORIZON_INTRA_S;
}
