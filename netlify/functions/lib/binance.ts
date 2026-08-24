const BASES = [
  "https://data-api.binance.vision",
  "https://api.binance.com",
];

const SYMBOL = "BTCUSDT";

export type RawKline = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  number,
  string,
  string,
  string,
];

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

export type Depth = {
  lastUpdateId: number;
  bids: [string, string][];
  asks: [string, string][];
};

export type Ticker24h = {
  symbol: string;
  lastPrice: string;
  priceChange: string;
  priceChangePercent: string;
  highPrice: string;
  lowPrice: string;
  volume: string;
  closeTime: number;
};

type CacheEntry<T> = { t: number; v: T };
const cache = new Map<string, CacheEntry<unknown>>();
const TTL_MS = 400;

async function getJson<T>(path: string): Promise<T> {
  const now = Date.now();
  const hit = cache.get(path) as CacheEntry<T> | undefined;
  if (hit && now - hit.t < TTL_MS) return hit.v;

  let lastErr: unknown;
  for (const base of BASES) {
    try {
      const res = await fetch(`${base}${path}`, {
        signal: AbortSignal.timeout(8000),
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        lastErr = new Error(`${base} ${res.status}`);
        continue;
      }
      const v = (await res.json()) as T;
      cache.set(path, { t: now, v });
      return v;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("binance_unavailable");
}

export async function fetchKlines(limit = 400): Promise<Kline[]> {
  const raw = await getJson<RawKline[]>(
    `/api/v3/klines?symbol=${SYMBOL}&interval=1s&limit=${limit}`,
  );
  return raw.map((k) => ({
    t: k[0],
    o: +k[1],
    h: +k[2],
    l: +k[3],
    c: +k[4],
    v: +k[5],
    n: k[8],
    tb: +k[9],
  }));
}

export async function fetchDepth(limit = 20): Promise<Depth> {
  return getJson<Depth>(`/api/v3/depth?symbol=${SYMBOL}&limit=${limit}`);
}

export async function fetchTicker(): Promise<Ticker24h> {
  return getJson<Ticker24h>(`/api/v3/ticker/24hr?symbol=${SYMBOL}`);
}
