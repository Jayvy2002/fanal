import { json } from "./lib/http";
import { buildLive } from "./lib/engine";

/**
 * Cron Netlify 1 min : avance le paper (flatten / expire) sans onglet au premier plan.
 * Résolution 5s = toujours le poll UI 1s. Sans ce tick, un 24 h paper se fige
 * dès que l’onglet est en arrière-plan (Netlify n’a pas de cron à 1s).
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
