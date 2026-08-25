import h1Json from "./_models/h1h_lgbm.json";
import h1MetaJson from "./_models/h1h_meta.json";
import h4Json from "./_models/h4h_lgbm.json";
import h4MetaJson from "./_models/h4h_meta.json";
import type { PredictHorizon, PredictTest } from "./contract";
import { HORIZON_1H_S, HORIZON_4H_S } from "./contract";

type Leaf = { v: number };
type Split = { f: number; t: number; left: number; right: number; missing: number };
type Node = Leaf | Split;
type CompactModel = { objective: string; features: string[]; trees: { nodes: Node[] }[] };

export type AbsBin = { lo: number; hi: number; mean_abs: number };
export type PBin = { lo: number; hi: number; mean_y: number; n: number };

export type Calib = {
  abs_intercept?: number;
  abs_beta_conf?: number;
  abs_beta_vol?: number;
  mean_abs_bps?: number;
  abs_bins?: AbsBin[];
  min_move_bps?: number;
};

export type ModelMeta = {
  tau: number;
  min_move_bps: number;
  default_min_edge_bps?: number;
  features: string[];
  horizon_s: number;
  horizon_bars: number;
  bar_s: number;
  test: PredictTest & { by_symbol?: Record<string, PredictTest> };
  sanity: { x: number[]; p: number; raw: number }[];
  calib?: Calib;
  p_calib?: PBin[];
  importance?: { name: string; gain: number }[];
  train_archive?: string;
  live_venue?: string;
  walk_forward?: { fold: number; n: number; flat_acc: number; naive_acc: number; brier: number }[];
};

const h1Model = h1Json as CompactModel;
const h4Model = h4Json as CompactModel;
const h1Meta = h1MetaJson as ModelMeta;
const h4Meta = h4MetaJson as ModelMeta;

function isLeaf(n: Node): n is Leaf {
  return "v" in n;
}

function scoreTree(nodes: Node[], x: number[]): number {
  let i = 0;
  for (let step = 0; step < nodes.length; step++) {
    const n = nodes[i];
    if (isLeaf(n)) return n.v;
    const val = x[n.f];
    if (val === null || val === undefined || Number.isNaN(val)) i = n.missing;
    else i = val <= n.t ? n.left : n.right;
  }
  return 0;
}

function rawScoreOf(m: CompactModel, x: number[]): number {
  let s = 0;
  for (const tree of m.trees) s += scoreTree(tree.nodes, x);
  return s;
}

export function sigmoid(z: number): number {
  if (z >= 0) {
    const ez = Math.exp(-z);
    return 1 / (1 + ez);
  }
  const ez = Math.exp(z);
  return ez / (1 + ez);
}

export function getHead(horizon: PredictHorizon): { model: CompactModel; meta: ModelMeta } {
  if (horizon === HORIZON_4H_S) return { model: h4Model, meta: h4Meta };
  return { model: h1Model, meta: h1Meta };
}

export function predictPUp(x: number[], horizon: PredictHorizon): number {
  const { model } = getHead(horizon);
  return sigmoid(rawScoreOf(model, x));
}

export function getMeta(horizon: PredictHorizon = HORIZON_1H_S): ModelMeta {
  return getHead(horizon).meta;
}

/** P calibrée par bins empiriques VAL — jamais un 99 % inventé. */
export function calibrateP(pRaw: number, bins: PBin[] | undefined): number {
  const p = Math.min(0.95, Math.max(0.05, pRaw));
  if (!bins?.length) return p;
  for (const b of bins) {
    if (p >= b.lo && p < b.hi) {
      const emp = Math.min(0.92, Math.max(0.08, b.mean_y));
      return 0.65 * emp + 0.35 * p;
    }
  }
  const last = bins[bins.length - 1];
  if (p >= last.hi) {
    const emp = Math.min(0.92, Math.max(0.08, last.mean_y));
    return 0.65 * emp + 0.35 * p;
  }
  return p;
}

function binAbs(conf: number, bins: AbsBin[] | undefined, fallback: number): number {
  if (!bins?.length) return fallback;
  for (const b of bins) {
    if (conf >= b.lo && conf < b.hi) return b.mean_abs;
  }
  return bins[bins.length - 1].mean_abs;
}

export function volProxyBps(map: Record<string, number> | undefined, horizonBars: number): number {
  const rv12 = map?.rv_12 ?? 0;
  const rv48 = map?.rv_48 ?? 0;
  return Math.max(rv12, rv48) * Math.sqrt(Math.max(horizonBars, 1)) * 1e4;
}

export function expectedAbsMoveBps(
  pUp: number,
  calib: Calib | undefined,
  map: Record<string, number> | undefined,
  horizonBars: number,
): number {
  const c = calib ?? {};
  const conf = Math.abs(pUp - 0.5);
  const vol = volProxyBps(map, horizonBars);
  const meanAbs = Math.max(c.mean_abs_bps ?? 0.5, 0.5);
  const typical = meanAbs * (0.45 + 0.55 * Math.min(1, Math.max(0, conf / 0.5)));
  const hasAbs = c.abs_intercept != null || c.abs_beta_conf != null || c.abs_beta_vol != null;
  let lin = hasAbs
    ? (c.abs_intercept ?? 0) + (c.abs_beta_conf ?? 0) * conf + (c.abs_beta_vol ?? 0) * vol
    : vol;
  if (!Number.isFinite(lin)) lin = 0.05;
  lin = Math.max(lin, 0.05);
  const binE = binAbs(conf, c.abs_bins, meanAbs);
  const blended = 0.4 * lin + 0.35 * (Number.isFinite(binE) ? binE : meanAbs) + 0.25 * typical;
  const cap = horizonBars >= 24 ? 1000 : 400;
  if (!Number.isFinite(blended)) return typical;
  return Math.max(0.05, Math.min(cap, blended));
}

export function expectedMoveBps(
  pUp: number,
  calib: Calib | undefined,
  map: Record<string, number> | undefined,
  horizonBars: number,
): number {
  const sign = pUp >= 0.5 ? 1 : -1;
  return sign * expectedAbsMoveBps(pUp, calib, map, horizonBars);
}

export function emptyTest(): PredictTest {
  return {
    n: 0,
    coverage: 0,
    gated_acc: null,
    naive_last_acc: 0.5,
    flat_acc: null,
    mean_abs_move_bps: null,
    expectancy_10bp: null,
    expectancy_120bp: null,
    brier: null,
    logloss: null,
    beats_naive_flat: null,
    beats_naive_gated: null,
  };
}

export function verifySanity(eps = 1e-5): void {
  for (const horizon of [HORIZON_1H_S, HORIZON_4H_S] as PredictHorizon[]) {
    const { meta } = getHead(horizon);
    for (const s of meta.sanity ?? []) {
      const p = predictPUp(s.x, horizon);
      if (Math.abs(p - s.p) > eps) {
        throw new Error(`scorer_mismatch h=${horizon} expected=${s.p} got=${p}`);
      }
    }
  }
}
