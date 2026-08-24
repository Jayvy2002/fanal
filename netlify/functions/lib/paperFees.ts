/**
 * Frais spot BTC-USD — une seule source pour le gate, le paper et l’UI.
 *
 * Défaut (intro Advanced Trade, **non vérifié**) :
 *   preneur 120 bp · faiseur 60 bp
 *   aller-retour faiseur = 120 bp · aller-retour preneur = 240 bp
 *
 * Sources tierces 2026 (petit volume / intro, < 1 k$ US / 30 j) :
 *   TokenEcho, Exchange Review Lab — **pas** le tableau officiel login-gated.
 *
 * Pages Coinbase (barème réel derrière connexion) :
 *   https://help.coinbase.com/coinbase/trading-and-funding/advanced-trade/advanced-trade-fees
 *   https://help.coinbase.com/en/exchange/trading-and-funding/exchange-fees
 *
 * Alternate **nommée**, pas le défaut : Exchange 60 / 40 bp (barème public Exchange).
 * Ne pas inventer les chiffres Advanced Trade officiels.
 */

export type PaperMode = "taker" | "maker";
export type FillRole = "taker" | "maker";

export type FeeScheduleId = "adv_intro_unverified" | "exchange_60_40";

export type FeeSchedule = {
  id: FeeScheduleId;
  product: "BTC-USD";
  venue: "coinbase";
  label: string;
  taker_bps: number;
  maker_bps: number;
  caveat: string;
  links: { label: string; href: string }[];
};

export const FEE_LINKS = {
  advanced:
    "https://help.coinbase.com/coinbase/trading-and-funding/advanced-trade/advanced-trade-fees",
  exchange: "https://help.coinbase.com/en/exchange/trading-and-funding/exchange-fees",
} as const;

export const FEE_SCHEDULES: Record<FeeScheduleId, FeeSchedule> = {
  adv_intro_unverified: {
    id: "adv_intro_unverified",
    product: "BTC-USD",
    venue: "coinbase",
    label: "Advanced Trade intro (non vérifié, sources tierces 2026)",
    taker_bps: 120,
    maker_bps: 60,
    caveat:
      "Chiffres d’intro Advanced Trade non vérifiés (TokenEcho, Exchange Review Lab, palier < 1 k$ US / 30 j). " +
      "Le barème officiel Advanced Trade est derrière connexion — on n’invente pas les chiffres login-gated.",
    links: [
      { label: "Advanced Trade (aide Coinbase)", href: FEE_LINKS.advanced },
      { label: "Exchange (aide Coinbase)", href: FEE_LINKS.exchange },
    ],
  },
  exchange_60_40: {
    id: "exchange_60_40",
    product: "BTC-USD",
    venue: "coinbase",
    label: "Exchange 60 / 40 (alternate, pas le défaut)",
    taker_bps: 60,
    maker_bps: 40,
    caveat:
      "Alternate nommée : barème public Coinbase Exchange 60 bp preneur / 40 bp faiseur. Ce n’est pas le défaut Fanal.",
    links: [{ label: "Exchange (aide Coinbase)", href: FEE_LINKS.exchange }],
  },
};

export const DEFAULT_FEE_SCHEDULE_ID: FeeScheduleId = "adv_intro_unverified";
export const DEFAULT_FEE_SCHEDULE = FEE_SCHEDULES[DEFAULT_FEE_SCHEDULE_ID];

export const FEE_TIER_ID = DEFAULT_FEE_SCHEDULE.id;
export const FEE_TIER_LABEL = DEFAULT_FEE_SCHEDULE.label;
export const TAKER_FEE_BPS = DEFAULT_FEE_SCHEDULE.taker_bps;
export const MAKER_FEE_BPS = DEFAULT_FEE_SCHEDULE.maker_bps;
export const FEE_SOURCE = FEE_LINKS.advanced;
export const FEE_CAVEAT = DEFAULT_FEE_SCHEDULE.caveat;

/** Aller-retour faiseur = 2 × 60 = 120 bp. Aller-retour preneur = 2 × 120 = 240 bp. */
export const MAKER_RT_BPS = 2 * MAKER_FEE_BPS;
export const TAKER_RT_BPS = 2 * TAKER_FEE_BPS;

export const STARTING_CASH_USD = 1000;
export const CLIP_USD = 75;
/** Horizon paper / décision primaire : 15 minutes depuis le placement. */
export const HORIZON_S = 15 * 60;
export const HORIZON_MS = HORIZON_S * 1000;
export const BAR_S = 60;
export const MAX_RECENT = 40;

/**
 * Seuil d’entrée paper = aller-retour faiseur (120 bp).
 * Un feu 1s/5s ne doit pas ouvrir le paper : le scoreur live n’émet que du 15 m.
 */
export const PAPER_MIN_MOVE_BPS = MAKER_RT_BPS;

export const LEDGER_VERSION = 2 as const;

export function feeUsd(notional: number, bps: number): number {
  return (Math.abs(notional) * bps) / 1e4;
}

export function roundTripFeeBps(mode: PaperMode): number {
  return mode === "taker" ? TAKER_RT_BPS : MAKER_RT_BPS;
}

export function activeSchedule(): FeeSchedule {
  return DEFAULT_FEE_SCHEDULE;
}
