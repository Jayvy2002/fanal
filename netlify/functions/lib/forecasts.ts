import type { Forecast, HeadPoint, PathPoint, Side, Signal } from "./types";

const MAX_TRAIL = 16;
export const PATH_HORIZONS_M = [1, 3, 5, 10, 15, 30] as const;
export const PRIMARY_HORIZON_M = 15;

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
  horizon_m?: number;
  clip_max_bps?: number;
};

type Lane = {
  pending: Forecast | null;
  recent: Forecast[];
};

const lane15: Lane = { pending: null, recent: [] };
const lane30: Lane = { pending: null, recent: [] };

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

/** Vol proxy en bps sur l’horizon (barres 1m). Aligne train/train_fanal.py. */
export function volProxyBps(map: Record<string, number> | undefined, horizonM = 15): number {
  const rv5 = map?.rv_5 ?? 0;
  const rv60 = map?.rv_60 ?? 0;
  const h = horizonM > 0 ? horizonM : 15;
  return Math.max(rv5, rv60) * Math.sqrt(h) * 1e4;
}

export function expectedAbsMoveBps(
  pUp: number,
  calib: Calib | undefined,
  map?: Record<string, number>,
  horizonM = 15,
): number {
  const c = calib ?? {};
  const conf = Math.abs(pUp - 0.5);
  const h = c.horizon_m ?? horizonM;
  const vol = volProxyBps(map, h);
  const meanAbs = Math.max(c.mean_abs_bps ?? 8, 1);
  const typical = meanAbs * (0.45 + 0.55 * Math.min(1, Math.max(0, conf / 0.5)));
  const hasAbs = c.abs_intercept != null || c.abs_beta_conf != null || c.abs_beta_vol != null;
  let lin = hasAbs
    ? (c.abs_intercept ?? 0) + (c.abs_beta_conf ?? 0) * conf + (c.abs_beta_vol ?? 0) * vol
    : vol;
  if (!Number.isFinite(lin)) lin = 1;
  lin = Math.max(lin, 0.5);
  const binE = binAbs(conf, c.abs_bins, meanAbs);
  const blended = 0.4 * lin + 0.35 * (Number.isFinite(binE) ? binE : meanAbs) + 0.25 * typical;
  const cap = c.clip_max_bps ?? Math.max(80, 25 * Math.sqrt(h));
  if (!Number.isFinite(blended)) return Math.min(typical, cap);
  return Math.max(0.5, Math.min(cap, blended));
}

export function expectedMoveBps(
  pUp: number,
  calib: Calib | undefined,
  map?: Record<string, number>,
  horizonM = 15,
): number {
  const sign = pUp >= 0.5 ? 1 : -1;
  return sign * expectedAbsMoveBps(pUp, calib, map, horizonM);
}

/** Interpolation lisse (hermite / smoothstep) entre nœuds (t, p). */
export function interpolatePath(knots: PathPoint[], stepMs = 15_000): PathPoint[] {
  if (knots.length === 0) return [];
  if (knots.length === 1) return [{ ...knots[0] }];
  const sorted = [...knots].sort((a, b) => a.t - b.t);
  const out: PathPoint[] = [];
  const t0 = sorted[0].t;
  const t1 = sorted[sorted.length - 1].t;
  for (let t = t0; t <= t1 + 1; t += stepMs) {
    let i = 0;
    while (i < sorted.length - 2 && sorted[i + 1].t < t) i += 1;
    const a = sorted[i];
    const b = sorted[Math.min(i + 1, sorted.length - 1)];
    const span = Math.max(b.t - a.t, 1);
    const u = Math.min(1, Math.max(0, (t - a.t) / span));
    const s = u * u * (3 - 2 * u);
    out.push({ t, p: a.p + (b.p - a.p) * s });
  }
  const last = sorted[sorted.length - 1];
  if (out.length === 0 || out[out.length - 1].t !== last.t) out.push({ ...last });
  return out;
}

export function pathFromHeads(
  mid: number,
  ts: number,
  heads: HeadPoint[],
  untilM: number,
): PathPoint[] {
  const knots: PathPoint[] = [{ t: ts, p: mid }];
  for (const h of heads) {
    if (h.horizon_m > untilM) continue;
    knots.push({ t: ts + h.horizon_m * 60_000, p: mid * (1 + h.expected_move_bps / 1e4) });
  }
  if (knots.length < 2) {
    const last = heads.find((h) => h.horizon_m === untilM) ?? heads[heads.length - 1];
    if (last) {
      knots.push({ t: ts + untilM * 60_000, p: mid * (1 + last.expected_move_bps / 1e4) });
    }
  }
  return interpolatePath(knots);
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

function maybeOpen(
  lane: Lane,
  now: number,
  mid: number,
  signal: Signal,
  horizonS: number,
  path: PathPoint[],
): void {
  if (lane.pending) return;
  if (!signal.gated || signal.side === "flat") return;
  const target = path.length ? path[path.length - 1].p : signal.target_px;
  lane.pending = {
    ts: now,
    side: signal.side,
    label: signal.label as "HAUSSIER" | "BAISSIER",
    mid,
    target_px: target,
    expected_move_bps: signal.expected_move_bps,
    resolve_ts: now + horizonS * 1000,
    hit: null,
    path,
    horizon_s: horizonS,
    p_up: signal.p_up,
  };
}

export function updateForecasts(opts: {
  now: number;
  mid: number;
  signal15: Signal;
  signal30: Signal | null;
  path15: PathPoint[];
  path30: PathPoint[];
}): Forecast[] {
  const { now, mid, signal15, signal30, path15, path30 } = opts;
  resolveLane(lane15, now, mid);
  resolveLane(lane30, now, mid);
  maybeOpen(lane15, now, mid, signal15, signal15.horizon_s || 900, path15);
  if (signal30) maybeOpen(lane30, now, mid, signal30, signal30.horizon_s || 1800, path30);

  const out: Forecast[] = [];
  if (lane15.pending) out.push(cloneForecast(lane15.pending));
  if (lane30.pending) out.push(cloneForecast(lane30.pending));
  for (const f of lane15.recent) out.push(cloneForecast(f));
  for (const f of lane30.recent) out.push(cloneForecast(f));
  return out;
}
