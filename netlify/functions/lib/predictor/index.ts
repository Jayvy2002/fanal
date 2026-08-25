export {
  HORIZON_INTRA_S,
  HORIZON_SLOT_S,
  isPredictSymbol,
  resolveHorizon,
  type PredictHorizon,
  type PredictOpts,
  type PredictReason,
  type PredictResponse,
  type PredictSide,
  type PredictSymbol,
  type PredictTest,
} from "./contract";
export { predict, predictBoth, decisionFromVector, decisionFromFair } from "./score";
export { decideFair, LOCK_90C_HURDLE, MIN_EV_USDC, inMidBand } from "./fairvalue";
export { getPolyTest, getPolyTestFile, tradeAssetOk } from "./polytest";
export type { PredictGate, PredictMarketContext } from "./contract";
export { getMeta, verifySanity, calibrateP, expectedAbsMoveBps } from "./scorer";
export {
  candlesToKlines,
  completedKlines,
  fetchBook,
  fetchCandles1m,
  fetchStats,
  fetchTicker,
  parseTradeTime,
  type Kline,
} from "./coinbase";
export { computeFeatureMap, sparkFrom, vectorFromMap, whyReasons } from "./features";
