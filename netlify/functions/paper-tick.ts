import { json } from "./lib/http";
import { buildLive } from "./lib/engine";

/**
 * Cron Netlify 1 min : avance le paper (flatten / expire) sans onglet au premier plan.
 * La barre live est déjà 1 m — le cron correspond à la granularité.
 * Aucun ordre Coinbase réel. Aucune clé.
 */
export const handler = async () => {
  try {
    const live = await buildLive();
    return json(200, {
      ok: true,
      tick: "paper",
      n: live.paper?.n ?? 0,
      remaining_s: live.paper?.remaining_s ?? 0,
      gated: live.signal?.gated ?? false,
      now: live.now,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "tick_error";
    return json(500, { ok: false, error: msg });
  }
};

export const config = {
  schedule: "* * * * *",
};
