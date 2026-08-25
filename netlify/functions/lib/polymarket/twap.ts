/**
 * TWAP officiel Chainlink via RTDS public Polymarket (sans clé).
 * Docs : https://docs.polymarket.com/market-data/chainlink-twap
 *
 *   wss://ws-live-data.polymarket.com
 *   topic crypto_prices_twap_sixty | crypto_prices_twap_thirty
 *
 * Pas de snapshot REST. Si le flux est muet / périmé → stale, on skip le lock.
 * On n’invente PAS un mid Coinbase à la place.
 */

export const RTDS_URL = "wss://ws-live-data.polymarket.com";
export const STALE_MS = 15_000;

export type TwapSymbol = "btc/usd" | "eth/usd";

export type TwapTick = {
  symbol: TwapSymbol;
  value: number;
  observed_ts: number;
  published_ts: number;
  window_s: 30 | 60;
  stale: boolean;
};

export type TwapMap = Partial<Record<TwapSymbol, TwapTick>>;

type RtdsMsg = {
  topic?: string;
  type?: string;
  timestamp?: number | string;
  payload?: {
    symbol?: string;
    value?: number | string;
    timestamp?: number;
    window_s?: number;
    windowSeconds?: number;
    full_accuracy_value?: string;
  };
};

function parseValue(payload: RtdsMsg["payload"]): number {
  if (!payload) return NaN;
  const full = payload.full_accuracy_value;
  if (full && /^\d+$/.test(full)) {
    const n = Number(full) / 1e18;
    if (Number.isFinite(n) && n > 0) return n;
  }
  const v = typeof payload.value === "string" ? Number(payload.value) : payload.value;
  return typeof v === "number" && Number.isFinite(v) ? v : NaN;
}

function topicWindow(topic: string | undefined, payload: RtdsMsg["payload"]): 30 | 60 {
  if (payload?.window_s === 30 || payload?.windowSeconds === 30) return 30;
  if (topic?.includes("thirty") || topic?.includes("30")) return 30;
  return 60;
}

export function markStale(tick: TwapTick, now: number, maxAge = STALE_MS): TwapTick {
  return { ...tick, stale: now - tick.observed_ts > maxAge || !(tick.value > 0) };
}

export async function pollTwap(opts?: {
  windowS?: 30 | 60;
  timeoutMs?: number;
  now?: number;
}): Promise<TwapMap> {
  const windowS = opts?.windowS ?? 60;
  const timeoutMs = opts?.timeoutMs ?? 4500;
  const now = opts?.now ?? Date.now();
  const topic = windowS === 30 ? "crypto_prices_twap_thirty" : "crypto_prices_twap_sixty";
  const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!WS) return {};

  return new Promise((resolve) => {
    const out: TwapMap = {};
    let done = false;
    let ws: WebSocket;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(out);
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      ws = new WS(RTDS_URL);
    } catch {
      clearTimeout(timer);
      resolve({});
      return;
    }
    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          action: "subscribe",
          subscriptions: [{ topic, type: "update" }],
        }),
      );
    });
    ws.addEventListener("message", (ev) => {
      let msg: RtdsMsg;
      try {
        msg = JSON.parse(String(ev.data)) as RtdsMsg;
      } catch {
        return;
      }
      const sym = (msg.payload?.symbol || "").toLowerCase() as TwapSymbol;
      if (sym !== "btc/usd" && sym !== "eth/usd") return;
      const value = parseValue(msg.payload);
      if (!(value > 0)) return;
      const observed = Number(msg.payload?.timestamp) || now;
      const published = typeof msg.timestamp === "number" ? msg.timestamp : Date.parse(String(msg.timestamp || "")) || now;
      const tick: TwapTick = {
        symbol: sym,
        value,
        observed_ts: observed,
        published_ts: published,
        window_s: topicWindow(msg.topic, msg.payload),
        stale: false,
      };
      out[sym] = markStale(tick, now);
      if (out["btc/usd"] && out["eth/usd"]) {
        clearTimeout(timer);
        finish();
      }
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      finish();
    });
    ws.addEventListener("close", () => {
      clearTimeout(timer);
      finish();
    });
  });
}

export function twapSymbolOf(asset: "BTC" | "ETH"): TwapSymbol {
  return asset === "ETH" ? "eth/usd" : "btc/usd";
}
