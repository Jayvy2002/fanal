const BASE = "https://api.exchange.coinbase.com";
const HEADERS = {
  Accept: "application/json",
  "User-Agent": "FanalResearch/1.0",
};

export type PredictSymbol = "BTC-USD" | "ETH-USD";

export type Kline = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
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

/** [time_s, low, high, open, close, volume] */
export type CoinbaseCandle = [number, number, number, number, number, number];

type CacheEntry<T> = { t: number; v: T };
const cache = new Map<string, CacheEntry<unknown>>();

async function getJson<T>(path: string, ttl = 400): Promise<T> {
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

export async function fetchTicker(product: PredictSymbol): Promise<CoinbaseTicker> {
  return getJson<CoinbaseTicker>(`/products/${product}/ticker`);
}

export async function fetchStats(product: PredictSymbol): Promise<CoinbaseStats> {
  return getJson<CoinbaseStats>(`/products/${product}/stats`, 15_000);
}

export async function fetchBook(product: PredictSymbol, level = 2): Promise<CoinbaseBook> {
  return getJson<CoinbaseBook>(`/products/${product}/book?level=${level}`);
}

export async function fetchCandles1m(product: PredictSymbol): Promise<CoinbaseCandle[]> {
  return getJson<CoinbaseCandle[]>(`/products/${product}/candles?granularity=60`, 8_000);
}

export async function fetchCandles5m(product: PredictSymbol): Promise<CoinbaseCandle[]> {
  return getJson<CoinbaseCandle[]>(`/products/${product}/candles?granularity=300`, 8_000);
}

export function parseTradeTime(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : Date.now();
}

export function candlesToKlines(raw: CoinbaseCandle[]): Kline[] {
  const rows = raw
    .map(([ts, low, high, open, close, vol]) => ({
      t: ts * 1000,
      o: open,
      h: high,
      l: low,
      c: close,
      v: vol,
    }))
    .filter((k) => Number.isFinite(k.c) && k.c > 0);
  rows.sort((a, b) => a.t - b.t);
  return rows;
}

/** Barre [t, t+barMs) complète seulement si now >= t+barMs. Défaut = 5 m. */
export function isBarComplete(t: number, nowMs: number, barMs = 300_000): boolean {
  return t + barMs <= nowMs;
}

export function completedKlines(klines: Kline[], nowMs: number, barMs = 300_000): Kline[] {
  return klines.filter((k) => isBarComplete(k.t, nowMs, barMs));
}
