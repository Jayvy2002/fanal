import type { PredictResponse } from "../predictor/contract";
import { inMidBand, MID_BAND_MIN_EV_USDC } from "../predictor/fairvalue";
import type { PairBook, SideBook } from "./clob";
import { cryptoTakerFeeUsdc, intraRoundTripPnl, minExitMid } from "./fees";

export const INTRA_PAD_USDC = 0.02;
export const INTRA_TIME_STOP_S = 40;
export const INTRA_STALL_CENTS = 0.01;
export const SPREAD_PAD = 0.015;

export type IntraEnter = {
  ok: boolean;
  reason: string;
  side: "up" | "down" | null;
  ask: number;
  model_p: number;
  edge: number;
};

/** Intra seulement si le prédicteur fire (fair value fee-aware) ET un ask existe. */
export function shouldEnterIntra(pred: PredictResponse, book: PairBook): IntraEnter {
  if (!pred.fire || pred.side === "flat") {
    return { ok: false, reason: "no_fire", side: null, ask: 0, model_p: pred.confidence, edge: 0 };
  }
  const sideBook: SideBook = pred.side === "down" ? book.down : book.up;
  const ask = sideBook.ask;
  if (!(ask > 0 && ask < 1)) {
    return { ok: false, reason: "no_ask", side: pred.side, ask: 0, model_p: pred.confidence, edge: 0 };
  }
  if (inMidBand(ask) && (pred.edge_usdc ?? 0) < MID_BAND_MIN_EV_USDC) {
    return {
      ok: false,
      reason: "midband",
      side: pred.side,
      ask,
      model_p: pred.p_up,
      edge: pred.edge_usdc ?? 0,
    };
  }
  if ((pred.edge_usdc ?? 0) <= 0) {
    return {
      ok: false,
      reason: "fee",
      side: pred.side,
      ask,
      model_p: pred.p_up,
      edge: pred.edge_usdc ?? 0,
    };
  }
  return {
    ok: true,
    reason: "stale_cheap_side",
    side: pred.side,
    ask,
    model_p: pred.p_fair ?? pred.p_up,
    edge: pred.edge_usdc ?? 0,
  };
}

export type IntraExit = {
  exit: boolean;
  scratch: boolean;
  convert_lock: boolean;
  reason: string;
  mid: number;
  min_mid: number;
};

export function shouldExitIntra(opts: {
  entryAsk: number;
  mid: number;
  shares: number;
  held_s: number;
  remaining_slot_s: number;
  padUsdc?: number;
  pWin?: number | null;
  bid?: number;
}): IntraExit {
  const pad = opts.padUsdc ?? INTRA_PAD_USDC;
  const minMid = minExitMid(opts.entryAsk, opts.shares, pad);
  const base = { mid: opts.mid, min_mid: minMid };
  if (opts.remaining_slot_s <= 60 && opts.remaining_slot_s > 0) {
    return { exit: false, scratch: false, convert_lock: true, reason: "convert_lock", ...base };
  }
  if (opts.mid >= minMid) {
    return { exit: true, scratch: false, convert_lock: false, reason: "mid_cleared_fees", ...base };
  }
  if (opts.held_s >= INTRA_TIME_STOP_S && opts.mid < opts.entryAsk + INTRA_STALL_CENTS) {
    if (opts.pWin != null && opts.bid != null && opts.bid > 0) {
      const feeOut = cryptoTakerFeeUsdc(opts.shares, opts.bid);
      const scratch = opts.shares * opts.bid - feeOut;
      const hold = opts.shares * opts.pWin;
      if (hold > scratch) {
        return { exit: false, scratch: false, convert_lock: false, reason: "hold_better_than_scratch", ...base };
      }
    }
    return { exit: true, scratch: true, convert_lock: false, reason: "time_stop", ...base };
  }
  if (opts.remaining_slot_s <= 0) {
    return { exit: false, scratch: false, convert_lock: true, reason: "slot_ended_redeem", ...base };
  }
  return { exit: false, scratch: false, convert_lock: false, reason: "hold", ...base };
}

export function intraPnlAt(shares: number, entryAsk: number, exitBid: number) {
  return intraRoundTripPnl(shares, entryAsk, exitBid);
}
