import {
  fetchBook,
  fetchCandles1m,
  fetchStats,
  fetchTicker,
  fetchTrades,
  parseTradeTime,
  type CoinbaseBook,
  type CoinbaseCandle,
  type CoinbaseStats,
  type CoinbaseTicker,
  type CoinbaseTrade,
  type Kline,
} from "./coinbase";

const BAR_MS = 60_000;
const LOOKBACK_BARS = 240; /* ~4 h de 1m */

export type Bar = Kline;

function candleToBar(c: CoinbaseCandle): Bar {
  const t = Math.floor(c[0]) * 1000;
  return {
    t,
    o: c[3],
    h: c[2],
    l: c[1],
    c: c[4],
    v: c[5],
    n: 0,
    tb: 0,
  };
}

function bucket1m(ms: number): number {
  return Math.floor(ms / BAR_MS) * BAR_MS;
}

/** Overlay taker-buy depuis les trades récents (side = maker ; taker buy = sell). */
function applyTrades(bars: Map<number, Bar>, trades: CoinbaseTrade[]): void {
  for (let i = trades.length - 1; i >= 0; i--) {
    const tr = trades[i];
    const px = +tr.price;
    const sz = +tr.size;
    if (!Number.isFinite(px) || px <= 0 || !Number.isFinite(sz)) continue;
    const t = bucket1m(parseTradeTime(tr.time));
    const bar = bars.get(t);
    if (!bar) continue;
    const takerBuy = tr.side === "sell";
    bar.n += 1;
    if (takerBuy) bar.tb += sz;
  }
}

function densify(sorted: Bar[]): Bar[] {
  if (sorted.length < 2) return sorted.map((b) => ({ ...b }));
  const out: Bar[] = [];
  let prev = { ...sorted[0] };
  out.push(prev);
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    for (let t = prev.t + BAR_MS; t < next.t; t += BAR_MS) {
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
    prev = { ...next };
    out.push(prev);
  }
  return out;
}

/** Barre 1m [t, t+60000) complète seulement si now >= t+60000. */
export function isBarComplete(t: number, nowMs: number): boolean {
  return t + BAR_MS <= nowMs;
}

export function completedKlines(klines: Kline[], nowMs: number): Kline[] {
  return klines.filter((k) => isBarComplete(k.t, nowMs));
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
  const [candles, ticker, stats, book, trades] = await Promise.all([
    fetchCandles1m(LOOKBACK_BARS + 12),
    fetchTicker(),
    fetchStats(),
    fetchBook(2),
    fetchTrades(1000),
  ]);

  const last = +ticker.price;
  const now = parseTradeTime(ticker.time) || Date.now();
  const byT = new Map<number, Bar>();
  for (const c of candles) {
    const b = candleToBar(c);
    if (b.c > 0 && Number.isFinite(b.c)) byT.set(b.t, b);
  }
  applyTrades(byT, trades);

  const times = [...byT.keys()].sort((a, b) => a - b);
  const raw = times.map((t) => byT.get(t)!);
  let klines = densify(raw);
  if (klines.length > LOOKBACK_BARS + 2) {
    klines = klines.slice(-(LOOKBACK_BARS + 2));
  }
  return { klines, ticker, stats, book, now, last };
}

export function barCount(): number {
  return 0;
}

export { BAR_MS, LOOKBACK_BARS };
