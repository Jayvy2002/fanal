import {
  fetchTicker,
  fetchTrades,
  fetchBook,
  fetchStats,
  parseTradeTime,
  type CoinbaseBook,
  type CoinbaseStats,
  type CoinbaseTicker,
  type CoinbaseTrade,
  type Kline,
} from "./coinbase";

const SEC = 1000;
const MAX_BARS = 360;
const SEED_PAGES = 7;

export type Bar = Kline;

type Store = {
  bars: Map<number, Bar>;
  seen: Set<number>;
  lastTradeId: number;
  seeded: boolean;
  seeding: Promise<void> | null;
};

const store: Store = {
  bars: new Map(),
  seen: new Set(),
  lastTradeId: 0,
  seeded: false,
  seeding: null,
};

function bucket(ms: number): number {
  return Math.floor(ms / SEC) * SEC;
}

function upsertTrade(tr: CoinbaseTrade): void {
  const px = +tr.price;
  const sz = +tr.size;
  if (!Number.isFinite(px) || px <= 0) return;
  const t = bucket(parseTradeTime(tr.time));
  // Coinbase Exchange `side` is the MAKER. Taker buy = maker sell.
  const takerBuy = tr.side === "sell";
  const prev = store.bars.get(t);
  if (!prev) {
    store.bars.set(t, {
      t,
      o: px,
      h: px,
      l: px,
      c: px,
      v: Number.isFinite(sz) ? sz : 0,
      n: 1,
      tb: takerBuy && Number.isFinite(sz) ? sz : 0,
    });
    return;
  }
  prev.h = Math.max(prev.h, px);
  prev.l = Math.min(prev.l, px);
  prev.c = px;
  if (Number.isFinite(sz)) {
    prev.v += sz;
    if (takerBuy) prev.tb += sz;
  }
  prev.n += 1;
}

function trimSeen(): void {
  if (store.seen.size <= 20_000) return;
  const ids = [...store.seen].sort((a, b) => a - b);
  for (let i = 0; i < 8_000; i++) store.seen.delete(ids[i]);
}

function ingestTrades(trades: CoinbaseTrade[]): void {
  // Coinbase returns newest-first. Ingest oldest-first so OHLC opens correctly.
  for (let i = trades.length - 1; i >= 0; i--) {
    const tr = trades[i];
    if (store.seen.has(tr.trade_id)) continue;
    store.seen.add(tr.trade_id);
    upsertTrade(tr);
  }
  if (trades.length) {
    const newest = Math.max(...trades.map((t) => t.trade_id));
    if (newest > store.lastTradeId) store.lastTradeId = newest;
  }
  trimSeen();
  prune();
}

function ingestTicker(ticker: CoinbaseTicker): void {
  const px = +ticker.price;
  if (!Number.isFinite(px) || px <= 0) return;
  const t = bucket(parseTradeTime(ticker.time) || Date.now());
  const prev = store.bars.get(t);
  if (!prev) {
    store.bars.set(t, { t, o: px, h: px, l: px, c: px, v: 0, n: 0, tb: 0 });
    prune();
    return;
  }
  prev.h = Math.max(prev.h, px);
  prev.l = Math.min(prev.l, px);
  prev.c = px;
}

function prune(): void {
  if (store.bars.size <= MAX_BARS) return;
  const times = [...store.bars.keys()].sort((a, b) => a - b);
  const drop = times.length - MAX_BARS;
  for (let i = 0; i < drop; i++) store.bars.delete(times[i]);
}

function densify(from: number, to: number): Bar[] {
  const out: Bar[] = [];
  let prev: Bar | null = null;
  for (let t = from; t <= to; t += SEC) {
    const hit = store.bars.get(t);
    if (hit) {
      prev = { ...hit };
      out.push(prev);
      continue;
    }
    if (!prev) continue;
    const carried: Bar = {
      t,
      o: prev.c,
      h: prev.c,
      l: prev.c,
      c: prev.c,
      v: 0,
      n: 0,
      tb: 0,
    };
    out.push(carried);
    prev = carried;
  }
  return out;
}

async function seedHistory(): Promise<void> {
  if (store.seeded) return;
  let after: number | undefined;
  for (let page = 0; page < SEED_PAGES; page++) {
    const trades = await fetchTrades(1000, after);
    if (!trades.length) break;
    ingestTrades(trades);
    after = trades[trades.length - 1].trade_id;
  }
  store.seeded = true;
  prune();
}

export type Snapshot = {
  klines: Kline[];
  ticker: CoinbaseTicker;
  stats: CoinbaseStats;
  book: CoinbaseBook;
  now: number;
  last: number;
};

export async function snapshotLive(): Promise<Snapshot> {
  if (!store.seeded && !store.seeding) {
    store.seeding = seedHistory().finally(() => {
      store.seeding = null;
    });
  }
  const [ticker, stats, book, trades] = await Promise.all([
    fetchTicker(),
    fetchStats(),
    fetchBook(2),
    fetchTrades(1000),
  ]);
  if (store.seeding) await store.seeding;

  ingestTrades(trades);
  ingestTicker(ticker);

  const last = +ticker.price;
  const now = parseTradeTime(ticker.time) || Date.now();
  const times = [...store.bars.keys()].sort((a, b) => a - b);
  const to = bucket(now);
  const from = times.length ? times[0] : to - 180_000;
  const klines = densify(from, to);
  return { klines, ticker, stats, book, now, last };
}

export function barCount(): number {
  return store.bars.size;
}
