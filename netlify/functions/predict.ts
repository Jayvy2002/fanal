import { json } from "./lib/http";
import { predict, isPredictSymbol, resolveHorizon } from "./lib/predictor";

type Event = { queryStringParameters?: Record<string, string | undefined> };

export const handler = async (event: Event) => {
  const q = event.queryStringParameters ?? {};
  const symbol = isPredictSymbol(q.symbol) ? q.symbol : "BTC-USD";
  const horizon_s = resolveHorizon(Number(q.horizon_s || "3600"));
  const minRaw = q.min_edge_bps;
  const min_edge_bps = minRaw != null && minRaw !== "" ? Number(minRaw) : undefined;
  try {
    return json(200, await predict({ symbol, horizon_s, min_edge_bps }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "predict_error";
    return json(500, { error: msg });
  }
};
