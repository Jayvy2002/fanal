/**
 * Live = Coinbase BTC-USD. Poids live = arbres Binance Vision 45 j.
 * Les features relatives (ret, rv, tbr, imb, z-scores, wicks) sont comparables.
 * Les features d’échelle brute (log_vol, CVD en BTC) ne le sont pas : Binance
 * imprime ~10× plus de volume 1s. Sans affine, les splits LightGBM sur log_vol / cvd
 * voient des vecteurs hors distribution.
 *
 * On n’entraîne pas ici. On isole les noms et on ramène seulement l’échelle
 * vers l’espace Binance. Le why-strip live reste en unités Coinbase brutes.
 */

export const SCALE_FREE_FEATURES = [
  "ret_1",
  "ret_3",
  "ret_5",
  "ret_15",
  "ret_30",
  "ret_60",
  "rv_5",
  "rv_15",
  "rv_30",
  "rv_60",
  "tbr",
  "tbr_5",
  "tbr_15",
  "tbr_30",
  "body_ratio",
  "upper_wick",
  "lower_wick",
  "log_hl",
  "close_loc",
  "vol_z_30",
  "vol_z_60",
  "vol_shock_5",
  "imb_5",
  "imb_15",
  "imb_30",
  "trade_z_30",
] as const;

/** Volume BTC 1s : pas un ratio, pas un z-score. */
export const VENUE_SCALE_FEATURES = ["log_vol", "cvd_5", "cvd_15", "cvd_30"] as const;

/** Rapport volume 1s typique Binance BTCUSDT / Coinbase BTC-USD. */
export const BINANCE_VS_COINBASE_VOL_RATIO = 10;
export const LOG_VOL_OFFSET = Math.log(BINANCE_VS_COINBASE_VOL_RATIO);

export function isBinanceTrained(trainArchive: string | undefined): boolean {
  return (trainArchive ?? "").toLowerCase().includes("binance");
}

export function adaptLiveFeatures(
  map: Record<string, number>,
  trainArchive: string | undefined,
): Record<string, number> {
  if (!isBinanceTrained(trainArchive)) return map;
  const out = { ...map };
  if (Number.isFinite(out.log_vol)) out.log_vol = out.log_vol + LOG_VOL_OFFSET;
  for (const k of ["cvd_5", "cvd_15", "cvd_30"] as const) {
    if (Number.isFinite(out[k])) out[k] = out[k] * BINANCE_VS_COINBASE_VOL_RATIO;
  }
  return out;
}
