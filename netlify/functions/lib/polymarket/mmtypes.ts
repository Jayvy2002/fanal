import type { PairBook, SideBook } from "./clob";
import type { DiscoveredMarket } from "./markets";
import type { TwapTick } from "./twap";

export const MM_LEDGER_V = 5 as const;
export const MM_STARTING_CASH = 1000;
export const MM_CLIP_USDC = 8;
export const MM_TARGET_PAIR = 0.98;
export const MM_HARD_CAP = 1.03;
export const MM_PAIR_TIMEOUT_MS = 60_000;
export const MM_MAX_FILLS_SLOT = 8;
export const MM_MAX_RECENT = 40;
export const MM_TICK = 0.01;
export const MM_ASSETS = ["BTC"] as const;
export type MmAsset = (typeof MM_ASSETS)[number];

/** Lean extra : 1 = pair 1:1 only. 2 = double the underpriced side. 1.0–1.5x skippé (TEST). */
export const MM_LEAN_RATIO = 1;

export type MmSide = "up" | "down";

export type MmQuote = {
  id: string;
  asset: MmAsset;
  slug: string;
  slot_start_s: number;
  side: MmSide;
  bid: number;
  shares: number;
  placed_ts: number;
  placed_ask: number;
  placed_mid: number;
  placed_bid: number;
};

export type MmSlot = {
  asset: MmAsset;
  symbol: "BTC-USD" | "ETH-USD";
  slug: string;
  slot_start_s: number;
  shares_up: number;
  shares_down: number;
  cost_up: number;
  cost_down: number;
  fees_usdc: number;
  matched: number;
  paired_cost: number;
  naked_since_ts: number | null;
  n_fills: number;
  n_maker: number;
  n_taker: number;
  flatten_quote: MmQuote | null;
};

export type MmTrade = {
  id: string;
  ts: number;
  asset: MmAsset;
  slug: string;
  kind: "pair_redeem" | "naked_redeem" | "scratch" | "taker_lock";
  matched: number;
  paired_cost: number;
  pair_avg: number | null;
  pnl: number;
  winner: MmSide | null;
  reason: string;
};

export type MmSpotOpen = {
  px: number;
  ts: number;
  late: boolean;
};

export type MmLedger = {
  v: typeof MM_LEDGER_V;
  started_ts: number;
  updated_ts: number;
  cash_usdc: number;
  starting_cash_usdc: number;
  realized_pnl_usdc: number;
  fees_usdc: number;
  n: number;
  n_pairs: number;
  n_maker_fills: number;
  n_taker_fills: number;
  n_scratch: number;
  hits: number;
  clip_usdc: number;
  quotes: MmQuote[];
  slots: MmSlot[];
  recent: MmTrade[];
  strikes: Record<string, { twap: number; observed_ts: number; window_s: number; late: boolean }>;
  last_twap: Partial<Record<"btc/usd" | "eth/usd", TwapTick>>;
  spot_open: Record<string, MmSpotOpen>;
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
  market: DiscoveredMarket;
  book: PairBook;
  p_fair: number | null;
  p_clob: number | null;
  quotes: MmQuote[];
  slot: MmSlot | null;
  pair_ask: number | null;
  pair_bid: number | null;
};

export type MmSnapshot = {
  v: typeof MM_LEDGER_V;
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

export type MmStepInput = {
  now: number;
  markets: DiscoveredMarket[];
  books: Record<string, PairBook>;
  spots: Record<string, number>;
  rv: Record<string, number>;
};

export type SideSnap = SideBook;
