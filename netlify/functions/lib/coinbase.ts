const BASE = "https://api.exchange.coinbase.com";
const PRODUCT = "BTC-USD";

const HEADERS = {
  Accept: "application/json",
  "User-Agent": "FanalResearch/1.0",
};

export type Kline = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  n: number;
  tb: number;
};

export type CoinbaseTrade = {
  trade_id: number;
  side: "buy" | "sell" | string;
  size: string;
  price: string;
  time: string;
};

export type CoinbaseTicker = {
  ask: string;
  bid: string;
  volume: string;
  trade_id: number;
  price: string;
  size: string;
  time: string;
};

export type CoinbaseStats = {
  open: string;
  high: string;
  low: string;
  last: string;
  volume: string;
};

export type CoinbaseBook = {
  sequence: number;
  bids: [string, string, number][];
  asks: [string, string, number][];
};

/** Coinbase candle: [time_s, low, high, open, close, volume] */
export type CoinbaseCandle = [number, number, number, number, number, number];

type CacheEntry<T> = { t: number; v: T };
const cache = new Map<string, CacheEntry<unknown>>();
const TTL_MS = 400;

async function getJson<T>(path: string, ttl = TTL_MS): Promise<T> {
  const now = Date.now();
  const hit = cache.get(path) as CacheEntry<T> | undefined;
  if (hit && now - hit.t < ttl) return hit.v;

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${BASE}${path}`, {
        signal: AbortSignal.timeout(8000),
        headers: HEADERS,
      });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        lastErr = new Error("coinbase_429");
        continue;
      }
      if (!res.ok) {
        lastErr = new Error(`coinbase ${res.status}`);
        continue;
      }
      const v = (await res.json()) as T;
      cache.set(path, { t: now, v });
      return v;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("coinbase_unavailable");
}

export async function fetchTicker(): Promise<CoinbaseTicker> {
  return getJson<CoinbaseTicker>(`/products/${PRODUCT}/ticker`);
}

export async function fetchStats(): Promise<CoinbaseStats> {
  return getJson<CoinbaseStats>(`/products/${PRODUCT}/stats`, 15_000);
}

export async function fetchBook(level = 2): Promise<CoinbaseBook> {
  return getJson<CoinbaseBook>(`/products/${PRODUCT}/book?level=${level}`);
}

export async function fetchTrades(limit = 1000, after?: number): Promise<CoinbaseTrade[]> {
  const q = after
    ? `/products/${PRODUCT}/trades?limit=${limit}&after=${after}`
    : `/products/${PRODUCT}/trades?limit=${limit}`;
  return getJson<CoinbaseTrade[]>(q, after ? 0 : TTL_MS);
}

export async function fetchCandles60(): Promise<CoinbaseCandle[]> {
  return fetchCandles1m(300);
}

/** Bougies 1m Coinbase Exchange. Sans start/end : les ~300 plus récentes (~5 h). */
export async function fetchCandles1m(n = 252): Promise<CoinbaseCandle[]> {
  const raw = await getJson<CoinbaseCandle[]>(
    `/products/${PRODUCT}/candles?granularity=60`,
    15_000,
  );
  const sorted = [...raw].sort((a, b) => a[0] - b[0]);
  return n > 0 && sorted.length > n ? sorted.slice(-n) : sorted;
}

export function parseTradeTime(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : Date.now();
}

export const COINBASE_PRODUCT = PRODUCT;
