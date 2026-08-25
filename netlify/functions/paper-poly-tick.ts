import { json } from "./lib/http";
import { stepMmPaper } from "./lib/polymarket/mmpaper";

/**
 * Cron 1 min : avance le paper MM two-sided. Aucun ordre CLOB. Aucune clé.
 */
export const handler = async () => {
  try {
    const snap = await stepMmPaper();
    return json(200, {
      ok: true,
      tick: "paper-mm",
      n: snap.n,
      cash_usdc: snap.cash_usdc,
      open: snap.slots.length,
      live_orders: false,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "tick_error";
    return json(500, { ok: false, error: msg, live_orders: false });
  }
};
