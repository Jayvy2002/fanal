import { json } from "./lib/http";
import { stepPolyPaper } from "./lib/polymarket";

/**
 * Cron 1 min : avance le paper Polymarket sans onglet au premier plan.
 * L’intra a besoin du poll UI 1 s. Aucun ordre CLOB réel. Aucune clé.
 */
export const handler = async () => {
  try {
    const snap = await stepPolyPaper();
    return json(200, {
      ok: true,
      tick: "paper-poly",
      n: snap.n,
      cash_usdc: snap.cash_usdc,
      open: snap.open.length,
      live_orders: false,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "tick_error";
    return json(500, { ok: false, error: msg, live_orders: false });
  }
};
