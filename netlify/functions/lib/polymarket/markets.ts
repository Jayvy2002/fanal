import type { PredictSymbol } from "../predictor/contract";

const GAMMA = "https://gamma-api.polymarket.com";
const HEADERS = {
  Accept: "application/json",
  "User-Agent": "FanalResearch/1.0",
};

export const SLOT_S = 300;
export const TWAP_WINDOW_S = 60;
export const RESOLUTION_SRC_BTC = "https://data.chain.link/streams/btc-usd-twap-60s-streams";
export const RESOLUTION_SRC_ETH = "https://data.chain.link/streams/eth-usd-twap-60s-streams";

export type PolyAsset = "BTC" | "ETH";

export type DiscoveredMarket = {
  asset: PolyAsset;
  symbol: PredictSymbol;
  slug: string;
  title: string;
  question: string;
  description: string;
  resolution_source: string;
  twap_window_s: number;
  slot_start_s: number;
  slot_end_s: number;
  remaining_s: number;
  up_token: string;
  down_token: string;
  outcomes: string[];
  fee_rate: number;
  fee_taker_only: boolean;
  condition_id: string | null;
};

function slugOf(asset: PolyAsset, slotStartS: number): string {
  return `${asset.toLowerCase()}-updown-5m-${slotStartS}`;
}

export function slotBounds(nowMs: number): { start: number; end: number } {
  const s = Math.floor(nowMs / 1000);
  const start = s - (s % SLOT_S);
  return { start, end: start + SLOT_S };
}

export function assetOfSymbol(symbol: PredictSymbol): PolyAsset {
  return symbol.startsWith("ETH") ? "ETH" : "BTC";
}

export function symbolOfAsset(asset: PolyAsset): PredictSymbol {
  return asset === "ETH" ? "ETH-USD" : "BTC-USD";
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`gamma ${res.status}`);
  return (await res.json()) as T;
}

type GammaMarket = {
  question?: string;
  description?: string;
  resolutionSource?: string;
  outcomes?: string;
  clobTokenIds?: string;
  conditionId?: string;
  feeSchedule?: { rate?: number; takerOnly?: boolean };
  eventStartTime?: string;
  endDate?: string;
};

type GammaEvent = {
  slug?: string;
  title?: string;
  description?: string;
  resolutionSource?: string;
  markets?: GammaMarket[];
};

function parseJsonArr(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function mapEvent(asset: PolyAsset, slotStart: number, ev: GammaEvent): DiscoveredMarket | null {
  const m = ev.markets?.[0];
  if (!m) return null;
  const tokens = parseJsonArr(m.clobTokenIds);
  const outcomes = parseJsonArr(m.outcomes);
  if (tokens.length < 2) return null;
  let up = tokens[0];
  let down = tokens[1];
  const upIdx = outcomes.findIndex((o) => o.toLowerCase() === "up");
  const downIdx = outcomes.findIndex((o) => o.toLowerCase() === "down");
  if (upIdx >= 0 && tokens[upIdx]) up = tokens[upIdx];
  if (downIdx >= 0 && tokens[downIdx]) down = tokens[downIdx];
  const src =
    m.resolutionSource ||
    ev.resolutionSource ||
    (asset === "ETH" ? RESOLUTION_SRC_ETH : RESOLUTION_SRC_BTC);
  const window = /twap-30s|30s-streams/i.test(src) ? 30 : TWAP_WINDOW_S;
  const now = Date.now();
  return {
    asset,
    symbol: symbolOfAsset(asset),
    slug: ev.slug || slugOf(asset, slotStart),
    title: ev.title || "",
    question: m.question || ev.title || "",
    description: m.description || ev.description || "",
    resolution_source: src,
    twap_window_s: window,
    slot_start_s: slotStart,
    slot_end_s: slotStart + SLOT_S,
    remaining_s: Math.max(0, slotStart + SLOT_S - now / 1000),
    up_token: up,
    down_token: down,
    outcomes: outcomes.length ? outcomes : ["Up", "Down"],
    fee_rate: m.feeSchedule?.rate ?? 0.07,
    fee_taker_only: m.feeSchedule?.takerOnly !== false,
    condition_id: m.conditionId ?? null,
  };
}

export async function discoverMarket(asset: PolyAsset, nowMs = Date.now()): Promise<DiscoveredMarket | null> {
  const { start } = slotBounds(nowMs);
  const slug = slugOf(asset, start);
  const evs = await getJson<GammaEvent[]>(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`);
  if (!Array.isArray(evs) || !evs[0]) return null;
  return mapEvent(asset, start, evs[0]);
}

export async function discoverCurrent(nowMs = Date.now()): Promise<DiscoveredMarket[]> {
  const out: DiscoveredMarket[] = [];
  for (const asset of ["BTC", "ETH"] as const) {
    try {
      const m = await discoverMarket(asset, nowMs);
      if (m) out.push(m);
    } catch {
      /* marché pas encore indexé */
    }
  }
  return out;
}
