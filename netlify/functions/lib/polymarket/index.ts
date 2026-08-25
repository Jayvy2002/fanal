export { CRYPTO_TAKER_RATE, cryptoTakerFeeUsdc, intraRoundTripPnl, lockBreakEvenP, lockEdgeUsdc, minExitMid, redeemPnl } from "./fees";
export { discoverCurrent, discoverMarket, slotBounds } from "./markets";
export { fetchPairBook } from "./clob";
export { pollTwap, markStale } from "./twap";
export { projectLock, expensiveAskOk } from "./lock";
export { shouldEnterIntra, shouldExitIntra } from "./intra";
export { applyPolyStep, newPolyLedger, snapshotOf, snapshotPolyPaper, stepPolyPaper } from "./paper";
export type { PolyLedger, PolySnapshot, PolyPosition, PolyTrade, MarketView } from "./types";
