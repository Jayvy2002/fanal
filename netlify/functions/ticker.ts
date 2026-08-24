import { json } from "./lib/http";
import { buildTicker } from "./lib/engine";

export const handler = async () => {
  try {
    return json(200, await buildTicker());
  } catch (err) {
    const msg = err instanceof Error ? err.message : "ticker_error";
    return json(502, { error: msg });
  }
};
