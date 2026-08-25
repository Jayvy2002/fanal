import { fetchPairBook } from "./clob";
import { fetchTicker } from "../predictor/coinbase";
import { discoverCurrent, type DiscoveredMarket } from "./markets";
import { applyMmStep, emptyMmLedger, isMmLedger, mmAssetOk, snapshotMm } from "./mm";
import { loadMmLedger, mmStoreKind, saveMmLedger } from "./mmstore";
import { markStale, pollTwap, twapSymbolOf, type TwapMap } from "./twap";
import type { MmLedger, MmSnapshot } from "./mmtypes";

function twapWindowFromSrc(src: string): 30 | 60 {
  return /twap-30s|30s-streams/i.test(src) ? 30 : 60;
}

export async function stepMmPaper(): Promise<MmSnapshot> {
  const now = Date.now();
  const loaded = await loadMmLedger();
  const led: MmLedger = isMmLedger(loaded.ledger) ? loaded.ledger : emptyMmLedger(now);
  const all = await discoverCurrent(now);
  const markets = all.filter((m) => mmAssetOk(m.asset));
  const windowS = markets[0] ? twapWindowFromSrc(markets[0].resolution_source) : 60;
  const [twapsRaw, booksPairs, tickers] = await Promise.all([
    pollTwap({ windowS, now }),
    Promise.all(
      markets.map(async (m) => {
        try {
          return [m.asset, await fetchPairBook(m.up_token, m.down_token)] as const;
        } catch {
          return [m.asset, null] as const;
        }
      }),
    ),
    Promise.all(
      markets.map(async (m) => {
        try {
          const t = await fetchTicker(m.symbol);
          return [m.asset, +t.price] as const;
        } catch {
          return [m.asset, 0] as const;
        }
      }),
    ),
  ]);
  const books: Record<string, NonNullable<(typeof booksPairs)[number][1]>> = {};
  for (const [asset, book] of booksPairs) {
    if (book) books[asset] = book;
  }
  const spots: Record<string, number> = {};
  for (const [asset, px] of tickers) {
    if (px > 0) spots[asset] = px;
  }
  const twaps: TwapMap = {};
  for (const [k, v] of Object.entries(twapsRaw)) {
    if (v) twaps[k as keyof TwapMap] = markStale(v, now);
  }
  for (const [sym, tick] of Object.entries(twaps)) {
    if (tick) led.last_twap[sym as keyof TwapMap] = tick;
  }
  const rv: Record<string, number> = { BTC: 0.001, ETH: 0.0012 };
  const views = applyMmStep(led, { now, markets, books, spots, rv });
  await saveMmLedger(led, loaded.etag);
  const kind = await mmStoreKind();
  return snapshotMm(led, views, kind);
}

export async function snapshotMmPaper(): Promise<MmSnapshot> {
  const now = Date.now();
  const loaded = await loadMmLedger();
  const led = isMmLedger(loaded.ledger) ? loaded.ledger : emptyMmLedger(now);
  const kind = await mmStoreKind();
  return snapshotMm(led, [], kind);
}

export function mmMarketsOf(markets: DiscoveredMarket[]): DiscoveredMarket[] {
  return markets.filter((m) => mmAssetOk(m.asset));
}
