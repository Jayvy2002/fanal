import type { PredictResponse } from "../predictor/contract";
import type { PairBook, SideBook } from "./clob";
import { cryptoTakerFeeUsdc, intraRoundTripPnl, minExitMid } from "./fees";

export const INTRA_PAD_USDC = 0.02;
export const INTRA_TIME_STOP_S = 90;
export const SPREAD_PAD = 0.015;

export type IntraEnter = {
  ok: boolean;
  reason: string;
  side: "up" | "down" | null;
  ask: number;
  model_p: number;
  edge: number;
};

/** Intra seulement si le prédicteur fire ET le CLOB a encore le côté cheap / en retard. */
export function shouldEnterIntra(pred: PredictResponse, book: PairBook): IntraEnter {
  if (!pred.fire || pred.side === "flat") {
    return { ok: false, reason: "no_fire", side: null, ask: 0, model_p: pred.confidence, edge: 0 };
  }
  const sideBook: SideBook = pred.side === "down" ? book.down : book.up;
  const ask = sideBook.ask;
  if (!(ask > 0 && ask < 1)) {
    return { ok: false, reason: "no_ask", side: pred.side, ask: 0, model_p: pred.confidence, edge: 0 };
  }
  const modelP = pred.confidence;
  const fee = cryptoTakerFeeUsdc(1, ask);
  const edge = modelP - ask - fee - SPREAD_PAD;
  if (edge <= 0) {
    return {
      ok: false,
      reason: "clob_already_moved",
      side: pred.side,
      ask,
      model_p: modelP,
      edge,
    };
  }
  return { ok: true, reason: "stale_cheap_side", side: pred.side, ask, model_p: modelP, edge };
}

export type IntraExit = {
  exit: boolean;
  scratch: boolean;
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
}): IntraExit {
  const pad = opts.padUsdc ?? INTRA_PAD_USDC;
  const minMid = minExitMid(opts.entryAsk, opts.shares, pad);
  if (opts.mid >= minMid) {
    return { exit: true, scratch: false, reason: "mid_cleared_fees", mid: opts.mid, min_mid: minMid };
  }
  if (opts.held_s >= INTRA_TIME_STOP_S) {
    return { exit: true, scratch: true, reason: "time_stop", mid: opts.mid, min_mid: minMid };
  }
  if (opts.remaining_slot_s <= 12) {
    return { exit: true, scratch: true, reason: "slot_ending", mid: opts.mid, min_mid: minMid };
  }
  return { exit: false, scratch: false, reason: "hold", mid: opts.mid, min_mid: minMid };
}

export function intraPnlAt(shares: number, entryAsk: number, exitBid: number) {
  return intraRoundTripPnl(shares, entryAsk, exitBid);
}
