import { assetOfSymbol } from "../polymarket/markets";
import { fetchPairBook } from "../polymarket/clob";
import { discoverMarket } from "../polymarket/markets";
import { loadLedger } from "../polymarket/store";
import { markStale, pollTwap, twapSymbolOf } from "../polymarket/twap";
import type { PredictMarketContext, PredictSymbol } from "./contract";

function strikeKey(asset: string, slotStart: number): string {
  return `${asset}:${slotStart}`;
}

/** Contexte CLOB + TWAP officiel pour /api/predict. Strike = ledger ou obs d’open, jamais un mid Coinbase. */
export async function loadLiveContext(
  symbol: PredictSymbol,
  now = Date.now(),
): Promise<PredictMarketContext | null> {
  const asset = assetOfSymbol(symbol);
  try {
    const market = await discoverMarket(asset, now);
    if (!market) return null;
    const [book, twaps, loaded] = await Promise.all([
      fetchPairBook(market.up_token, market.down_token),
      pollTwap({ windowS: market.twap_window_s === 30 ? 30 : 60, now }),
      loadLedger().catch(() => ({ ledger: null as const })),
    ]);
    const rawTick = twaps[twapSymbolOf(asset)];
    const tick = rawTick ? markStale(rawTick, now) : null;
    const rec = loaded.ledger?.strikes?.[strikeKey(asset, market.slot_start_s)];
    let strike = rec && rec.twap > 0 ? rec.twap : null;
    let strike_late = Boolean(rec?.late);
    let has_strike = Boolean(strike && !strike_late);
    if (!has_strike && tick && tick.value > 0) {
      const openMs = market.slot_start_s * 1000;
      if (Math.abs(tick.observed_ts - openMs) <= 20_000) {
        strike = tick.value;
        strike_late = false;
        has_strike = true;
      }
    }
    return {
      remaining_s: market.remaining_s,
      twap: tick?.value ?? null,
      twap_stale: tick ? tick.stale : true,
      strike,
      strike_late,
      has_strike,
      up_ask: book.up.ask,
      up_bid: book.up.bid,
      down_ask: book.down.ask,
      down_bid: book.down.bid,
    };
  } catch {
    return null;
  }
}
