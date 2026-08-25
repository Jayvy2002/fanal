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
export { predict, predictBoth, decisionFromVector } from "./score";
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
