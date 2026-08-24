import type { FillRole, PaperMode } from "./paperFees";
import type { Side } from "./types";

export type PaperOrder = {
  kind: "entry" | "exit";
  side: Exclude<Side, "flat">;
  label: "HAUSSIER" | "BAISSIER";
  limit_px: number;
  qty: number;
  placed_ts: number;
  expire_ts: number;
  expected_move_bps: number;
};

export type PaperPosition = {
  side: Exclude<Side, "flat">;
  label: "HAUSSIER" | "BAISSIER";
  qty: number;
  entry_px: number;
  entry_ts: number;
  entry_fee_usd: number;
  entry_role: FillRole;
  flatten_ts: number;
  expected_move_bps: number;
};

export type PaperTrade = {
  id: string;
  ts: number;
  side: Exclude<Side, "flat">;
  label: "HAUSSIER" | "BAISSIER";
  mode: PaperMode;
  entry_px: number;
  exit_px: number;
  qty: number;
  notional_usd: number;
  entry_role: FillRole;
  exit_role: FillRole | "cancel";
  entry_fee_usd: number;
  exit_fee_usd: number;
  pnl_usd: number;
  pnl_bps: number;
  signed_bps: number | null;
  hit: boolean | null;
  cancelled: boolean;
  horizon_s: number;
};

export type Ledger = {
  v: 1;
  started_ts: number;
  updated_ts: number;
  mode: PaperMode;
  starting_cash_usd: number;
  cash_usd: number;
  btc: number;
  realized_pnl_usd: number;
  fees_usd: number;
  n: number;
  hits: number;
  n_cancelled: number;
  n_maker_fills: number;
  n_taker_fills: number;
  clip_usd: number;
  min_move_bps: number;
  last_entry_attempt_ts: number;
  mark_px: number;
  open: PaperPosition | null;
  pending: PaperOrder | null;
  recent: PaperTrade[];
};
