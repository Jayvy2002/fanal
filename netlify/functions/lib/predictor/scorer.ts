import intraJson from "./_models/intra_lgbm.json";
import intraMetaJson from "./_models/intra_meta.json";
import slotJson from "./_models/slot_lgbm.json";
import slotMetaJson from "./_models/slot_meta.json";
import type { PredictHorizon, PredictTest } from "./contract";
import { HORIZON_INTRA_S, HORIZON_SLOT_S } from "./contract";

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
};

const intraModel = intraJson as CompactModel;
const slotModel = slotJson as CompactModel;
const intraMeta = intraMetaJson as ModelMeta;
const slotMeta = slotMetaJson as ModelMeta;

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

export function getHead(horizon: PredictHorizon): {
  model: CompactModel;
  meta: ModelMeta;
} {
  if (horizon === HORIZON_SLOT_S) return { model: slotModel, meta: slotMeta };
  return { model: intraModel, meta: intraMeta };
}

export function predictPUp(x: number[], horizon: PredictHorizon): number {
  const { model } = getHead(horizon);
  return sigmoid(rawScoreOf(model, x));
}

export function getMeta(horizon: PredictHorizon = HORIZON_INTRA_S): ModelMeta {
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
  const rv5 = map?.rv_5 ?? 0;
  const rv60 = map?.rv_60 ?? 0;
  return Math.max(rv5, rv60) * Math.sqrt(Math.max(horizonBars, 1)) * 1e4;
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
  const cap = horizonBars >= 5 ? 80 : 40;
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

export function verifySanity(eps = 1e-5): void {
  for (const horizon of [HORIZON_INTRA_S, HORIZON_SLOT_S] as PredictHorizon[]) {
    const { meta } = getHead(horizon);
    for (const s of meta.sanity ?? []) {
      const p = predictPUp(s.x, horizon);
      if (Math.abs(p - s.p) > eps) {
        throw new Error(`scorer_mismatch h=${horizon} expected=${s.p} got=${p}`);
      }
    }
  }
}
