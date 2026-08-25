import type { PredictResponse, PredictSymbol } from "../predictor/contract";
import type { PairBook } from "./clob";
import type { DiscoveredMarket } from "./markets";
import type { TwapTick } from "./twap";

export const LEDGER_V = 3 as const;
export const STARTING_CASH = 1000;
export const CLIP_USDC = 25;
export const MAX_RECENT = 40;

export type Strat = "intra" | "lock";
export type PolySide = "up" | "down";

export type StrikeRec = {
  twap: number;
  observed_ts: number;
  window_s: number;
  late: boolean;
};

export type PolyPosition = {
  id: string;
  asset: "BTC" | "ETH";
  symbol: PredictSymbol;
  slug: string;
  slot_start_s: number;
  strat: Strat;
  side: PolySide;
  shares: number;
  entry_ask: number;
  entry_ts: number;
  entry_fee: number;
  token_id: string;
};

export type PolyTrade = {
  id: string;
  ts: number;
  asset: "BTC" | "ETH";
  slug: string;
  strat: Strat;
  side: PolySide;
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

export type PolyLedger = {
  v: typeof LEDGER_V;
  started_ts: number;
  updated_ts: number;
  cash_usdc: number;
  starting_cash_usdc: number;
  realized_pnl_usdc: number;
  fees_usdc: number;
  n: number;
  n_intra: number;
  n_lock: number;
  hits: number;
  n_scratch: number;
  n_skip_stale: number;
  n_skip_nofire: number;
  clip_usdc: number;
  open: PolyPosition[];
  recent: PolyTrade[];
  strikes: Record<string, StrikeRec>;
  last_twap: Partial<Record<"btc/usd" | "eth/usd", TwapTick>>;
};

export type MarketView = {
  market: DiscoveredMarket;
  book: PairBook;
  twap: TwapTick | null;
  strike: StrikeRec | null;
  p_lock_up: number | null;
  lock_skip: string | null;
  predict_intra: PredictResponse;
  predict_slot: PredictResponse;
};

export type PolySnapshot = {
  v: typeof LEDGER_V;
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
  persisted: boolean;
  started_ts: number;
  updated_ts: number;
  live_orders: false;
  honest: string;
  fee_formula: string;
  lock_90c_math: string;
};
