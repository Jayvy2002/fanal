const CLOB = "https://clob.polymarket.com";
const HEADERS = {
  Accept: "application/json",
  "User-Agent": "FanalResearch/1.0",
};

export type ClobLevel = { price: number; size: number };

export type SideBook = {
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  bids: ClobLevel[];
  asks: ClobLevel[];
};

export type PairBook = {
  up: SideBook;
  down: SideBook;
};

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`clob ${res.status}`);
  return (await res.json()) as T;
}

type RawBook = {
  bids?: { price: string; size: string }[];
  asks?: { price: string; size: string }[];
};

function levels(rows: { price: string; size: string }[] | undefined, n = 5): ClobLevel[] {
  return (rows ?? [])
    .map((r) => ({ price: +r.price, size: +r.size }))
    .filter((l) => l.price > 0 && l.size > 0)
    .slice(0, n);
}

function sideFrom(raw: RawBook): SideBook {
  const bids = levels(raw.bids);
  const asks = levels(raw.asks);
  const bid = bids[0]?.price ?? 0;
  const ask = asks[0]?.price ?? 0;
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : bid || ask;
  const spread = bid > 0 && ask > 0 ? ask - bid : 0;
  return { bid, ask, mid, spread, bids, asks };
}

export async function fetchSideBook(tokenId: string): Promise<SideBook> {
  const raw = await getJson<RawBook>(`${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`);
  return sideFrom(raw);
}

export async function fetchPairBook(upToken: string, downToken: string): Promise<PairBook> {
  const [up, down] = await Promise.all([fetchSideBook(upToken), fetchSideBook(downToken)]);
  return { up, down };
}

export function bestAsk(book: SideBook): number {
  return book.ask > 0 ? book.ask : 0;
}

export function bestBid(book: SideBook): number {
  return book.bid > 0 ? book.bid : 0;
}
