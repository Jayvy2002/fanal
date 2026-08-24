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

/** E[|5s move| bps | p, vol] calibrated on VAL. Used for the 1bp fire gate. */
export function expectedAbsMoveBps(
  pUp: number,
  calib: Calib | undefined,
  map?: Record<string, number>,
): number {
  const c = calib ?? {};
  const conf = Math.abs(pUp - 0.5);
  const rv5 = map?.rv_5 ?? 0;
  const rv60 = map?.rv_60 ?? 0;
  const vol = Math.max(rv5, rv60) * Math.sqrt(5) * 1e4;
  const meanAbs = Math.max(c.mean_abs_bps ?? 0.5, 0.5);
  const typical = meanAbs * (0.45 + 0.55 * Math.min(1, conf / 0.5));
  const hasLin = c.abs_intercept != null || c.abs_beta_conf != null || c.abs_beta_vol != null;
  const lin = hasLin
    ? (c.abs_intercept ?? 0) + (c.abs_beta_conf ?? 0) * conf + (c.abs_beta_vol ?? 0) * vol
    : 0.55 * typical + 0.45 * Math.max(vol, 0);
  const fromBin = binAbs(conf, c.abs_bins, meanAbs);
  const parts = [Math.max(0.05, typical)];
  if (Number.isFinite(lin) && lin > 0) parts.push(lin);
  if (Number.isFinite(fromBin) && fromBin > 0) parts.push(fromBin);
  const blended = parts.reduce((a, b) => a + b, 0) / parts.length;
  if (!Number.isFinite(blended)) return typical;
  return Math.max(0.05, Math.min(25, blended));
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
  const target = signal.target_px;
  lane.pending = {
    ts: now,
    side: signal.side,
    label: signal.label as "HAUSSIER" | "BAISSIER",
    mid,
    target_px: target,
    expected_move_bps: expected,
    resolve_ts: now + horizonS * 1000,
    hit: null,
    path: projectPath(mid, expected, now, horizonS),
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
