import { json } from "./lib/http";
import { buildLive } from "./lib/engine";

export const handler = async () => {
  try {
    return json(200, await buildLive());
  } catch (err) {
    const msg = err instanceof Error ? err.message : "live_error";
    return json(500, { error: msg, kind: "lgbm", horizon_s: 5, bar_s: 1 });
  }
};
