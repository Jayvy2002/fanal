/**
 * Frais paper Fanal — module unique (paper, UI via l’API, README recopié).
 *
 * Pour changer les deux nombres du paper, éditer uniquement :
 *   TAKER_FEE_BPS
 *   MAKER_FEE_BPS
 *
 * Défaut = Coinbase Advanced Trade, palier d’entrée volume 30 j < 1 000 $ US.
 * Aller-retour faiseur = 2 × MAKER = 120 bp. Aller-retour preneur = 2 × TAKER = 240 bp.
 *
 * CE NE SONT PAS des chiffres publiés par Coinbase. Le barème officiel Advanced
 * Trade est derrière login (« sign in to see the complete fee structure ») :
 *   https://help.coinbase.com/en/coinbase/trading-and-funding/advanced-trade/advanced-trade-fees
 *
 * 120 / 60 bp = hypothèse tierce 2026 (TokenEcho, Exchange Review Lab — ils
 * divergent sur les paliers suivants), non vérifiée vs table officielle.
 * On ne prétend pas que Coinbase a publié 1,20 % / 0,60 %.
 *
 * Barème Exchange public 0–10 k$ US = 60 / 40 bp — alternative nommée, pas le défaut.
 * Jayvy trade sur coinbase.com Advanced Trade, pas Coinbase Exchange.
 */

export type PaperMode = "taker" | "maker";
export type FillRole = "taker" | "maker";

/** Modifier ici. Preneur Advanced Trade palier d’entrée (hypothèse tierce). */
export const TAKER_FEE_BPS = 120;
/** Modifier ici. Faiseur Advanced Trade palier d’entrée (hypothèse tierce). */
export const MAKER_FEE_BPS = 60;

export const FEE_PRODUCT = "Coinbase Advanced Trade";
export const FEE_PRODUCT_ID = "advanced_trade";
export const FEE_TIER_ID = "cb_adv_intro_lt_1k_usd_30d_unverified";
export const FEE_TIER_LABEL =
  "Coinbase Advanced Trade · palier d’entrée < 1 000 $ US / 30 j (hypothèse, non vérifiée)";
export const FEE_CAVEAT =
  "Le barème officiel Advanced Trade est derrière connexion compte ; 120 bp preneur / 60 bp faiseur = hypothèse palier d’entrée 2026 (TokenEcho, Exchange Review Lab), pas une publication Coinbase.";
export const FEE_VERIFIED_VS_OFFICIAL = false;

export const FEE_SOURCE_ADVANCED =
  "https://help.coinbase.com/en/coinbase/trading-and-funding/advanced-trade/advanced-trade-fees";
export const FEE_SOURCE_EXCHANGE =
  "https://help.coinbase.com/en/exchange/trading-and-funding/exchange-fees";
export const FEE_SOURCE_THIRD_PARTY = ["TokenEcho", "Exchange Review Lab"] as const;

/** Alternative nommée : Coinbase Exchange public 0–10 k$ US. Pas le défaut paper. */
export const EXCHANGE_FEE = {
  product: "Coinbase Exchange",
  product_id: "exchange",
  tier_id: "cb_ex_0_10k_usd_30d",
  tier_label: "Coinbase Exchange · palier 0–10 000 $ US / 30 j (barème public)",
  taker_bps: 60,
  maker_bps: 40,
  source: FEE_SOURCE_EXCHANGE,
} as const;

export const STARTING_CASH_USD = 1000;
export const CLIP_USD = 75;
export const MAX_RECENT = 40;

/** Schéma carnet : v1 = paper 5s preneur. v2 = horizon + mode stockés, pas de mix silencieux. */
export const LEDGER_VERSION = 2;

export const DEFAULT_PAPER_MODE: PaperMode = "maker";
export const DEFAULT_PAPER_HORIZON_S = 60;
export const DISPLAY_HORIZON_S = 5;
export const PAPER_HORIZON_S_ALLOWED = [5, 60] as const;
export type PaperHorizonS = (typeof PAPER_HORIZON_S_ALLOWED)[number];

/** Gate 5s (opt-in comparaison) — pas le paper par défaut. */
export const PAPER_MIN_MOVE_5S_BPS = 1.0;

export function roundTripFeeBps(mode: PaperMode): number {
  const one = mode === "taker" ? TAKER_FEE_BPS : MAKER_FEE_BPS;
  return 2 * one;
}

export function makerRoundTripBps(): number {
  return 2 * MAKER_FEE_BPS;
}

export function takerRoundTripBps(): number {
  return 2 * TAKER_FEE_BPS;
}

/**
 * Gate d’entrée paper. 60s = aller-retour faiseur (défaut 120 bp), y compris
 * si le mode est preneur. 5s = 1 bp (ancien paper, opt-in seulement).
 */
export function paperGateBps(horizonS: number): number {
  if (horizonS === 5) return PAPER_MIN_MOVE_5S_BPS;
  return makerRoundTripBps();
}

export function isPaperHorizon(h: number): h is PaperHorizonS {
  return h === 5 || h === 60;
}

export function feeUsd(notional: number, bps: number): number {
  return (Math.abs(notional) * bps) / 1e4;
}

export function feePublicView() {
  return {
    product: FEE_PRODUCT,
    product_id: FEE_PRODUCT_ID,
    tier_id: FEE_TIER_ID,
    fee_tier: FEE_TIER_LABEL,
    taker_fee_bps: TAKER_FEE_BPS,
    maker_fee_bps: MAKER_FEE_BPS,
    round_trip_taker_bps: takerRoundTripBps(),
    round_trip_maker_bps: makerRoundTripBps(),
    caveat: FEE_CAVEAT,
    verified_vs_official: FEE_VERIFIED_VS_OFFICIAL,
    official_advanced_url: FEE_SOURCE_ADVANCED,
    official_exchange_url: FEE_SOURCE_EXCHANGE,
    third_party_sources: [...FEE_SOURCE_THIRD_PARTY],
    exchange_alternate: {
      product: EXCHANGE_FEE.product,
      taker_bps: EXCHANGE_FEE.taker_bps,
      maker_bps: EXCHANGE_FEE.maker_bps,
      round_trip_maker_bps: 2 * EXCHANGE_FEE.maker_bps,
      round_trip_taker_bps: 2 * EXCHANGE_FEE.taker_bps,
      source: EXCHANGE_FEE.source,
      used: false,
    },
  };
}
