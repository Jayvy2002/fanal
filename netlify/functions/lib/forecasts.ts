import type { Forecast, PathPoint, Side, Signal } from "./types";

const MAX_TRAIL = 20;

export type Calib = {
  beta_bps?: number;
  intercept_bps?: number;
  gated_up_mean_bps?: number;
  gated_down_mean_bps?: number;
  mean_abs_bps?: number;
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

export function expectedMoveBps(pUp: number, calib: Calib | undefined): number {
  const c = calib ?? {};
  const sign = pUp >= 0.5 ? 1 : -1;
  const conf = Math.min(1, Math.abs(pUp - 0.5) / 0.5);
  const linear = (c.beta_bps ?? 0) * (pUp - 0.5) + (c.intercept_bps ?? 0);
  const emp = pUp >= 0.5 ? (c.gated_up_mean_bps ?? 0) : (c.gated_down_mean_bps ?? 0);
  const signed = Number.isFinite(emp) || Number.isFinite(linear) ? 0.55 * emp + 0.45 * linear : 0;
  const abs = Math.max(c.mean_abs_bps ?? 0, 0.5);
  // Typical |move| in the called direction, shrunk by distance-to-0.5. Not a moonshot.
  const typical = sign * abs * (0.45 + 0.55 * conf);
  const blended = 0.35 * signed + 0.65 * typical;
  const cap = Math.max(3.5 * abs, 1.5);
  if (!Number.isFinite(blended)) return sign * abs * 0.5;
  return Math.max(-cap, Math.min(cap, blended));
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
