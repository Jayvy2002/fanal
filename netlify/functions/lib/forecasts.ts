import type { Forecast, PathPoint, Side, Signal } from "./types";

const MAX_TRAIL = 20;

export type AbsBin = {
  lo: number;
  hi: number;
  mean_abs: number;
};

export type Calib = {
  beta_bps?: number;
  intercept_bps?: number;
  gated_up_mean_bps?: number;
  gated_down_mean_bps?: number;
  mean_abs_bps?: number;
  abs_intercept?: number;
  abs_beta_conf?: number;
  abs_beta_vol?: number;
  abs_bins?: AbsBin[];
  min_move_bps?: number;
};

type Lane = {
  pending: Forecast | null;
  recent: Forecast[];
};

const lane5: Lane = { pending: null, recent: [] };
const lane15: Lane = { pending: null, recent: [] };

function cloneForecast(f: Forecast): Forecast {
  return { ...f, path: f.path.map((p) => ({ ...p })) };
}

function binAbs(conf: number, bins: AbsBin[] | undefined, fallback: number): number {
  if (!bins?.length) return fallback;
  for (const b of bins) {
    if (conf >= b.lo && conf < b.hi) return b.mean_abs;
  }
  return bins[bins.length - 1].mean_abs;
}

export const MOVE_CAP_5S = 25;
export const MOVE_CAP_60S = 400;

/**
 * E[|move| bps | p, vol]. Must match train/train_fanal.py::predict_abs_move:
 *   blended = 0.40 * lin + 0.35 * bin_e + 0.25 * typical
 * Train vol_proxy always used sqrt(5), even for the 15s head — keep that for the 5s gate.
 * Do not substitute TEST gated |move| for calib.mean_abs_bps (that inflates the 1bp gate).
 */
export function volProxyBps(map: Record<string, number> | undefined, horizonS = 5): number {
  const rv5 = map?.rv_5 ?? 0;
  const rv15 = map?.rv_15 ?? 0;
  const rv30 = map?.rv_30 ?? 0;
  const rv60 = map?.rv_60 ?? 0;
  const rv120 = map?.rv_120 ?? 0;
  const h = horizonS > 0 ? horizonS : 5;
  const rv = h >= 60 ? Math.max(rv15, rv30, rv60, rv120) : Math.max(rv5, rv60);
  return rv * Math.sqrt(h) * 1e4;
}

export function expectedAbsMoveBps(
  pUp: number,
  calib: Calib | undefined,
  map?: Record<string, number>,
  horizonS = 5,
): number {
  const c = calib ?? {};
  const conf = Math.abs(pUp - 0.5);
  const volH = horizonS >= 60 ? horizonS : 5;
  const cap = horizonS >= 60 ? MOVE_CAP_60S : MOVE_CAP_5S;
  const volGate = volProxyBps(map, volH);
  const meanAbs = Math.max(c.mean_abs_bps ?? (horizonS >= 60 ? 8 : 0.5), horizonS >= 60 ? 4 : 0.5);
  const typical = meanAbs * (0.45 + 0.55 * Math.min(1, Math.max(0, conf / 0.5)));
  const hasAbs = c.abs_intercept != null || c.abs_beta_conf != null || c.abs_beta_vol != null;
  let lin = hasAbs
    ? (c.abs_intercept ?? 0) + (c.abs_beta_conf ?? 0) * conf + (c.abs_beta_vol ?? 0) * volGate
    : volGate;
  if (!Number.isFinite(lin)) lin = 0.05;
  lin = Math.max(lin, 0.05);
  const binE = binAbs(conf, c.abs_bins, meanAbs);
  const blended = 0.4 * lin + 0.35 * (Number.isFinite(binE) ? binE : meanAbs) + 0.25 * typical;
  if (!Number.isFinite(blended)) return Math.min(cap, typical);
  return Math.max(0.05, Math.min(cap, blended));
}

/**
 * |move| 60s conservateur : vol réalisée 15s–2 min × sqrt(60) × facteur de confiance.
 * Pas un boost pour passer le gate frais. BTC 60s ~10 bp vs 120 bp RT faiseur.
 */
export function conservativeAbsMove60Bps(
  pUp: number,
  map?: Record<string, number>,
): number {
  const conf = Math.abs(pUp - 0.5);
  const vol = volProxyBps(map, 60);
  const factor = 0.35 + 0.65 * Math.min(1, Math.max(0, conf / 0.5));
  const e = vol * factor;
  if (!Number.isFinite(e)) return 0.05;
  return Math.max(0.05, Math.min(MOVE_CAP_60S, e));
}

export function expectedMoveBps(
  pUp: number,
  calib: Calib | undefined,
  map?: Record<string, number>,
): number {
  const sign = pUp >= 0.5 ? 1 : -1;
  const absMove = expectedAbsMoveBps(pUp, calib, map);
  return sign * absMove;
}

export function projectPath(mid: number, expectedBps: number, ts: number, horizonS: number): PathPoint[] {
  const target = mid * (1 + expectedBps / 1e4);
  const path: PathPoint[] = [];
  const steps = Math.max(1, horizonS);
  for (let i = 0; i <= steps; i++) {
    const frac = i / steps;
    path.push({ t: ts + i * 1000, p: mid + (target - mid) * frac });
  }
  return path;
}

function hitOf(side: Exclude<Side, "flat">, mid: number, midEnd: number): boolean {
  return side === "up" ? midEnd > mid : midEnd < mid;
}

function resolveLane(lane: Lane, now: number, mid: number): void {
  if (!lane.pending) return;
  if (now < lane.pending.resolve_ts) return;
  const done: Forecast = {
    ...lane.pending,
    hit: hitOf(lane.pending.side, lane.pending.mid, mid),
  };
  lane.pending = null;
  lane.recent.unshift(done);
  if (lane.recent.length > MAX_TRAIL) lane.recent.pop();
}

function maybeOpen(lane: Lane, now: number, mid: number, signal: Signal, horizonS: number): void {
  if (lane.pending) return;
  if (!signal.gated || signal.side === "flat") return;
  const expected = signal.expected_move_bps;
  /* 15s tête: the gate number is 5s-calib (train). Stretch only the drawn path so it
     is not a 5s move painted over 15s — paper never uses this lane. */
  const pathBps = horizonS > 5 ? expected * Math.sqrt(horizonS / 5) : expected;
  const target = mid * (1 + pathBps / 1e4);
  lane.pending = {
    ts: now,
    side: signal.side,
    label: signal.label as "HAUSSIER" | "BAISSIER",
    mid,
    target_px: target,
    expected_move_bps: expected,
    resolve_ts: now + horizonS * 1000,
    hit: null,
    path: projectPath(mid, pathBps, now, horizonS),
    horizon_s: horizonS,
    p_up: signal.p_up,
  };
}

export function updateForecasts(opts: {
  now: number;
  mid: number;
  signal5: Signal;
  signal15: Signal | null;
}): Forecast[] {
  const { now, mid, signal5, signal15 } = opts;
  resolveLane(lane5, now, mid);
  resolveLane(lane15, now, mid);
  maybeOpen(lane5, now, mid, signal5, signal5.horizon_s || 5);
  if (signal15) maybeOpen(lane15, now, mid, signal15, signal15.horizon_s || 15);

  const out: Forecast[] = [];
  if (lane5.pending) out.push(cloneForecast(lane5.pending));
  if (lane15.pending) out.push(cloneForecast(lane15.pending));
  for (const f of lane5.recent) out.push(cloneForecast(f));
  for (const f of lane15.recent) out.push(cloneForecast(f));
  return out;
}

export function pending5RemainingS(now: number): number {
  if (!lane5.pending) return 0;
  return Math.max(0, (lane5.pending.resolve_ts - now) / 1000);
}
