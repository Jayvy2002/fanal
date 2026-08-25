/**
 * Frais taker crypto Polymarket (officiel).
 * https://docs.polymarket.com/trading/fees
 *
 *   fee = C × 0.07 × p × (1 − p)   USDC
 *
 * Makers : 0. Pic à 50 ¢. Arrondi à 5 décimales (plus petit = 0,00001 USDC).
 */

export const CRYPTO_TAKER_RATE = 0.07;
export const MAKER_FEE_RATE = 0;
export const FEE_SOURCE = "https://docs.polymarket.com/trading/fees";
export const FEE_FORMULA = "C * 0.07 * p * (1 - p)";

/** Prix à 90 ¢ : fee/share = 0.07*0.9*0.1 = 0.0063 → il faut P > 0,9063 ≈ 91 %. */
export function lockBreakEvenP(price: number): number {
  const p = clamp01(price);
  return p + cryptoTakerFeeUsdc(1, p);
}

export function clamp01(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return Math.min(1, Math.max(0, p));
}

export function cryptoTakerFeeUsdc(shares: number, price: number): number {
  const c = Math.abs(shares);
  const p = clamp01(price);
  const raw = c * CRYPTO_TAKER_RATE * p * (1 - p);
  return roundFee(raw);
}

export function cryptoMakerFeeUsdc(_shares: number, _price: number): number {
  return 0;
}

export function roundFee(x: number): number {
  if (!Number.isFinite(x) || x <= 0) return 0;
  const rounded = Math.round(x * 1e5) / 1e5;
  return rounded < 0.00001 ? 0 : rounded;
}

/** Edge net d’un take à `ask` si P(win)=q, payout 1. */
export function lockEdgeUsdc(shares: number, ask: number, pWin: number): number {
  const c = Math.abs(shares);
  const p = clamp01(ask);
  const fee = cryptoTakerFeeUsdc(c, p);
  return c * (pWin * (1 - p) - (1 - pWin) * p) - fee;
}

/** PnL d’un aller-retour taker (intra) : achat ask, vente bid. */
export function intraRoundTripPnl(
  shares: number,
  entryAsk: number,
  exitBid: number,
): { pnl: number; feeIn: number; feeOut: number } {
  const c = Math.abs(shares);
  const feeIn = cryptoTakerFeeUsdc(c, entryAsk);
  const feeOut = cryptoTakerFeeUsdc(c, exitBid);
  const pnl = c * (exitBid - entryAsk) - feeIn - feeOut;
  return { pnl, feeIn, feeOut };
}

/** Mid minimum pour que la sortie taker couvre les deux frais + pad. */
export function minExitMid(entryAsk: number, shares: number, padUsdc: number): number {
  const c = Math.abs(shares) || 1;
  const feeIn = cryptoTakerFeeUsdc(c, entryAsk);
  /* fee_out dépend de p_exit ; borne haute = pic 50¢ = 0.07*0.25*C */
  const feeOutCap = cryptoTakerFeeUsdc(c, 0.5);
  return entryAsk + (feeIn + feeOutCap + padUsdc) / c;
}
