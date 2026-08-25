/**
 * Projecteur mécanique P(résolution) — souvent meilleur que le ML en fin de slot.
 * Up gagne si TWAP_fin ≥ strike (prix au début du range, règles live août 2026).
 * Si le TWAP est stale / sans strike officiel → skip. Jamais de mid Coinbase.
 */

export function normCdf(z: number): number {
  if (!Number.isFinite(z)) return 0.5;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = Math.exp((-z * z) / 2) / Math.sqrt(2 * Math.PI);
  const p = 1 - d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? p : 1 - p;
}

export type LockInput = {
  twap: number;
  strike: number;
  remaining_s: number;
  /** Vol réalisée 1m (écart-type des retours log 1m), pas un % inventé. */
  rv_1m: number;
  twap_stale: boolean;
  has_strike: boolean;
  strike_late: boolean;
};

export type LockProjection = {
  p_up: number;
  p_down: number;
  skip: boolean;
  skip_reason: string | null;
  distance_bps: number;
};

export function projectLock(input: LockInput): LockProjection {
  if (input.twap_stale) {
    return { p_up: 0.5, p_down: 0.5, skip: true, skip_reason: "twap_stale", distance_bps: 0 };
  }
  if (!input.has_strike || !(input.strike > 0)) {
    return { p_up: 0.5, p_down: 0.5, skip: true, skip_reason: "no_official_strike", distance_bps: 0 };
  }
  if (input.strike_late) {
    return { p_up: 0.5, p_down: 0.5, skip: true, skip_reason: "strike_not_at_open", distance_bps: 0 };
  }
  if (!(input.twap > 0)) {
    return { p_up: 0.5, p_down: 0.5, skip: true, skip_reason: "twap_missing", distance_bps: 0 };
  }
  const distBps = ((input.twap - input.strike) / input.strike) * 1e4;
  const t = Math.max(input.remaining_s, 1);
  const sigma = Math.max(input.rv_1m, 1e-6);
  const vol = sigma * Math.sqrt(t / 60);
  const z = Math.log(input.twap / input.strike) / vol;
  let pUp = normCdf(z);
  if (t <= 5) pUp = input.twap >= input.strike ? 0.995 : 0.005;
  pUp = Math.min(0.995, Math.max(0.005, pUp));
  return {
    p_up: pUp,
    p_down: 1 - pUp,
    skip: false,
    skip_reason: null,
    distance_bps: distBps,
  };
}

/** Ne pas acheter 90 ¢+ sauf si le projecteur dit que le flip est quasi impossible. */
export function expensiveAskOk(ask: number, pWin: number): boolean {
  if (ask < 0.9) return true;
  return pWin >= 0.91;
}
