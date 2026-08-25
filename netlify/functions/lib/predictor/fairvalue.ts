/**
 * Fair value TWAP-implied vs CLOB — le seul feu du bot.
 *
 * P(up) = CDF(log(TWAP/strike) / (rv * sqrt(remaining/60))).
 * Take seulement si l’EV après frais taker officiels + pad de spread est > 0.
 * Bande 40–60 ¢ skippée sauf mispricing énorme. 90 ¢+ exige P ≥ 91 %.
 */

import {
  CRYPTO_TAKER_RATE,
  cryptoTakerFeeUsdc,
  lockBreakEvenP,
  lockEdgeUsdc,
} from "../polymarket/fees";
import { expensiveAskOk, projectLock } from "../polymarket/lock";
import type { PredictReason, PredictSide } from "./contract";

export const SPREAD_PAD_DEFAULT = 0.015;
export const CLIP_DEFAULT = 25;
export const MIN_EV_USDC = 0.5;
export const MIN_GAP_DEFAULT = 0.12;
export const CHEAP_MAX = 0.3;
export const MID_LO = 0.4;
export const MID_HI = 0.6;
/** EV minimum (USDC, clip 25) pour prendre un ask dans 40–60 ¢. */
export const MID_BAND_MIN_EV_USDC = 0.75;
export const LOCK_WINDOW_S = 60;
export const LOCK_DEADZONE_S = 8;
export const WING_LO = 0.3;
export const WING_HI = 0.7;
export const LOCK_90C_HURDLE = lockBreakEvenP(0.9);

export type FairOverrides = {
  spread_pad?: number;
  clip_usdc?: number;
  min_ev_usdc?: number;
  mid_band_min_ev_usdc?: number;
  wings_only?: boolean;
  cheap_only?: boolean;
  min_gap?: number;
};

export type FairInput = {
  remaining_s: number;
  twap: number;
  strike: number;
  twap_stale: boolean;
  has_strike: boolean;
  strike_late: boolean;
  rv_1m: number;
  up_ask: number;
  up_bid: number;
  down_ask: number;
  down_bid: number;
} & FairOverrides;

export type FairGate = "fee" | "midband" | "twap" | "warmup" | "prob" | "deadzone" | null;

export type FairDecision = {
  p_fair_up: number;
  p_clob_up: number | null;
  fire: boolean;
  side: PredictSide;
  strat: "intra" | "lock" | null;
  ask: number;
  shares: number;
  edge_usdc: number;
  fee_usdc: number;
  gap: number;
  gate_block: FairGate;
  skip_reason: string | null;
  why: string;
  reasons: PredictReason[];
};

function fmt(x: number, d = 3): string {
  return x.toFixed(d).replace(".", ",");
}

export function inMidBand(p: number): boolean {
  return p > MID_LO && p < MID_HI;
}

export function inWings(p: number): boolean {
  return p <= WING_LO || p >= WING_HI;
}

export function takerFeePerShare(p: number): number {
  return cryptoTakerFeeUsdc(1, p);
}

function clobUp(input: FairInput): number | null {
  if (input.up_ask > 0 && input.up_bid > 0) return (input.up_ask + input.up_bid) / 2;
  if (input.up_ask > 0) return input.up_ask;
  if (input.down_ask > 0) return 1 - input.down_ask;
  return null;
}

function noFire(
  pFair: number,
  pClob: number | null,
  gate: FairGate,
  skip: string,
  why: string,
  extra: PredictReason[] = [],
): FairDecision {
  return {
    p_fair_up: pFair,
    p_clob_up: pClob,
    fire: false,
    side: "flat",
    strat: null,
    ask: 0,
    shares: 0,
    edge_usdc: 0,
    fee_usdc: 0,
    gap: 0,
    gate_block: gate,
    skip_reason: skip,
    why,
    reasons: [
      { key: "gate", label: "feu", value: 0, display: why },
      ...extra,
    ],
  };
}

type Cand = {
  side: "up" | "down";
  ask: number;
  pWin: number;
  shares: number;
  fee: number;
  ev: number;
  gap: number;
  midband: boolean;
};

/**
 * EV d’un take au ask, porté jusqu’à la résolution ($1 / $0) — un seul frais taker.
 * Le pad de spread est soustrait en USDC (1–2 ¢ × shares).
 */
export function holdToResEvUsdc(shares: number, ask: number, pWin: number, pad: number): number {
  return lockEdgeUsdc(shares, ask, pWin) - pad * Math.abs(shares);
}

export function decideFair(input: FairInput): FairDecision {
  const pad = input.spread_pad ?? SPREAD_PAD_DEFAULT;
  const clip = input.clip_usdc ?? CLIP_DEFAULT;
  const minEv = input.min_ev_usdc ?? MIN_EV_USDC;
  const midMin = input.mid_band_min_ev_usdc ?? MID_BAND_MIN_EV_USDC;
  const wingsOnly = input.wings_only ?? false;
  const cheapOnly = input.cheap_only ?? false;
  const minGap = input.min_gap ?? MIN_GAP_DEFAULT;
  const pClob = clobUp(input);
  const proj = projectLock({
    twap: input.twap,
    strike: input.strike,
    remaining_s: input.remaining_s,
    rv_1m: input.rv_1m,
    twap_stale: input.twap_stale,
    has_strike: input.has_strike,
    strike_late: input.strike_late,
  });
  const extra: PredictReason[] = [
    {
      key: "p_fair",
      label: "P(up) TWAP",
      value: proj.p_up,
      display: proj.skip ? proj.skip_reason ?? "skip" : fmt(proj.p_up),
    },
    {
      key: "p_clob",
      label: "p CLOB Up",
      value: pClob ?? 0,
      display: pClob == null ? "—" : fmt(pClob),
    },
    {
      key: "hurdle_90c",
      label: "hurdle 90 ¢",
      value: LOCK_90C_HURDLE,
      display: `P > ${fmt(LOCK_90C_HURDLE, 4)} ≈ 91 %`,
    },
  ];

  if (proj.skip) {
    return noFire(0.5, pClob, "twap", proj.skip_reason ?? "twap", `TWAP skip : ${proj.skip_reason}`, extra);
  }

  const remaining = input.remaining_s;
  const lockMode = remaining <= LOCK_WINDOW_S && remaining >= LOCK_DEADZONE_S;
  const intraMode = remaining > LOCK_WINDOW_S;
  if (!lockMode && !intraMode) {
    return noFire(
      proj.p_up,
      pClob,
      "deadzone",
      "deadzone",
      `fenêtre morte (${fmt(remaining, 0)} s) — pas de last-tick`,
      extra,
    );
  }
  const strat: "intra" | "lock" = lockMode ? "lock" : "intra";
  const pUp = proj.p_up;

  const raw: { side: "up" | "down"; ask: number; pWin: number }[] = [
    { side: "up", ask: input.up_ask, pWin: pUp },
    { side: "down", ask: input.down_ask, pWin: 1 - pUp },
  ];

  const scored: Cand[] = [];
  for (const c of raw) {
    if (!(c.ask > 0) || c.ask >= 0.99) continue;
    if (!expensiveAskOk(c.ask, c.pWin)) continue;
    if (wingsOnly && !inWings(c.ask)) continue;
    if (cheapOnly && c.ask > CHEAP_MAX) continue;
    const shares = clip / c.ask;
    if (!(shares > 0)) continue;
    const fee = cryptoTakerFeeUsdc(shares, c.ask);
    const ev = holdToResEvUsdc(shares, c.ask, c.pWin, pad);
    const gap = c.pWin - c.ask;
    const feePs = takerFeePerShare(c.ask);
    /* |p_fair − p_CLOB| doit couvrir fee(p) + pad. L’EV USDC le formalise. */
    if (gap <= feePs + pad + minGap) continue;
    scored.push({
      side: c.side,
      ask: c.ask,
      pWin: c.pWin,
      shares,
      fee,
      ev,
      gap,
      midband: inMidBand(c.ask),
    });
  }

  scored.sort((a, b) => b.ev - a.ev);
  const midBlocked = scored.filter((c) => c.midband && c.ev < midMin);
  const viable = scored.filter((c) => (!c.midband || c.ev >= midMin) && c.ev >= minEv);
  const best = viable[0];

  if (!best) {
    let gate: FairGate = "fee";
    let skip = "no_plus_ev";
    let why = `aucun côté avec E[USDC] ≥ ${fmt(minEv, 2)} après fee ${CRYPTO_TAKER_RATE}·p·(1−p) + pad ${fmt(pad, 3)}`;
    if (midBlocked.length && !scored.some((c) => !c.midband && c.ev >= minEv)) {
      gate = "midband";
      skip = "midband";
      why = `bande 40–60 ¢ : EV ${fmt(midBlocked[0].ev, 2)} USDC < ${fmt(midMin, 2)} (frais max près de 50 ¢)`;
    }
    extra.unshift({
      key: "gap",
      label: "gap fair−ask",
      value: scored[0]?.gap ?? 0,
      display: scored[0] ? fmt(scored[0].gap) : "—",
    });
    return noFire(pUp, pClob, gate, skip, why, extra);
  }

  const why =
    `${strat} ${best.side.toUpperCase()} @ ${fmt(best.ask)} · P(win) ${fmt(best.pWin)} · ` +
    `E ${fmt(best.ev, 2)} USDC après 1 frais taker + pad ${fmt(pad, 3)}`;
  return {
    p_fair_up: pUp,
    p_clob_up: pClob,
    fire: true,
    side: best.side,
    strat,
    ask: best.ask,
    shares: best.shares,
    edge_usdc: best.ev,
    fee_usdc: best.fee,
    gap: best.gap,
    gate_block: null,
    skip_reason: null,
    why,
    reasons: [
      { key: "gate", label: "feu", value: 1, display: why },
      {
        key: "edge_usdc",
        label: "E USDC après frais",
        value: best.ev,
        display: `${fmt(best.ev, 2)} USDC`,
      },
      {
        key: "gap",
        label: "gap fair−ask",
        value: best.gap,
        display: fmt(best.gap),
      },
      ...extra,
    ],
  };
}
