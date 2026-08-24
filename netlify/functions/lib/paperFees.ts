/**
 * Coinbase Advanced Trade public maker/taker schedule, lowest-volume retail tier.
 *
 * Palier 0–10 000 $ US de volume sur 30 jours (spot, paires non stables) :
 *   preneur (taker) 60 bp = 0,60 %
 *   faiseur (maker) 40 bp = 0,40 %
 *
 * Sources (barème maker-taker identique Exchange / Advanced) :
 *   https://help.coinbase.com/en/exchange/trading-and-funding/exchange-fees
 *   https://help.coinbase.com/coinbase/trading-and-funding/advanced-trade/advanced-trade-fees
 *
 * Ne pas inventer un palier plus bas : un compte neuf / petit volume est ici.
 */
export const FEE_TIER_ID = "cb_adv_0_10k_usd_30d";
export const FEE_TIER_LABEL =
  "Coinbase Advanced Trade · palier 0–10 000 $ US / 30 j (détail public)";
export const TAKER_FEE_BPS = 60;
export const MAKER_FEE_BPS = 40;
export const FEE_SOURCE =
  "https://help.coinbase.com/en/exchange/trading-and-funding/exchange-fees";

export const STARTING_CASH_USD = 1000;
export const CLIP_USD = 75;
export const HORIZON_MS = 5000;
export const MAX_RECENT = 40;

/**
 * Seuil d’entrée paper, indépendant du gate live. 1 bp = même feu que le modèle.
 * Pour exiger un move qui couvre l’aller-retour preneur, monter à 2 * TAKER_FEE_BPS (120).
 * À 120 bp le carnet 5s resterait presque vide — on laisse 1 bp pour que le 24 h soit lisible,
 * et on affiche les 120 bp de friction pour que la perte taker soit honnête.
 */
export const PAPER_MIN_MOVE_BPS = 1.0;

export type PaperMode = "taker" | "maker";
export type FillRole = "taker" | "maker";

export function feeUsd(notional: number, bps: number): number {
  return (Math.abs(notional) * bps) / 1e4;
}

export function roundTripFeeBps(mode: PaperMode): number {
  const one = mode === "taker" ? TAKER_FEE_BPS : MAKER_FEE_BPS;
  return 2 * one;
}
