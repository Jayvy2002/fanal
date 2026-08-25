import { json } from "./lib/http";
import { buildLive, isPredictSymbol } from "./lib/engine";

type Event = { queryStringParameters?: Record<string, string | undefined> };

export const handler = async (event: Event) => {
  const symbol = event.queryStringParameters?.symbol;
  try {
    return json(200, await buildLive(isPredictSymbol(symbol) ? symbol : "BTC-USD"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "live_error";
    return json(500, { error: msg, kind: "fairvalue", bar_s: 60, live_orders: false });
  }
};
