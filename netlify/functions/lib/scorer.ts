import lgbmJson from "../_models/fanal_sec_lgbm.json";
import metaJson from "../_models/fanal_sec_meta.json";
import lgbm15Json from "../_models/fanal_sec_lgbm_15.json";
import meta15Json from "../_models/fanal_sec_meta_15.json";

type Leaf = { v: number };
type Split = {
  f: number;
  t: number;
  left: number;
  right: number;
  missing: number;
};
type Node = Leaf | Split;
type CompactModel = {
  objective: string;
  features: string[];
  trees: { nodes: Node[] }[];
};

export type AbsBin = {
  lo: number;
  hi: number;
  mean_abs: number;
};

export type Calib = {
  beta_bps: number;
  intercept_bps: number;
  gated_up_mean_bps: number;
  gated_down_mean_bps: number;
  mean_abs_bps: number;
  abs_intercept?: number;
  abs_beta_conf?: number;
  abs_beta_vol?: number;
  abs_bins?: AbsBin[];
  min_move_bps?: number;
};

export type ModelMeta = {
  tau: number;
  min_move_bps?: number;
  features: string[];
  horizon_s?: number;
  enabled?: boolean;
  horizon_15_enabled?: boolean;
  test: {
    gated_acc: number | null;
    n: number;
    coverage: number;
    naive_last_acc: number;
    mean_abs_move_bps?: number | null;
    expectancy_1bp?: number | null;
    expectancy_2bp?: number | null;
  };
  sanity: { x: number[]; p: number; raw: number }[];
  calib?: Calib;
  importance?: { name: string; gain: number }[];
};

const model = lgbmJson as CompactModel;
const meta = metaJson as ModelMeta;
const model15 = lgbm15Json as CompactModel;
const meta15 = meta15Json as ModelMeta;

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

export function rawScore(x: number[]): number {
  return rawScoreOf(model, x);
}

export function sigmoid(z: number): number {
  if (z >= 0) {
    const ez = Math.exp(-z);
    return 1 / (1 + ez);
  }
  const ez = Math.exp(z);
  return ez / (1 + ez);
}

export function predictPUp(x: number[]): number {
  return sigmoid(rawScoreOf(model, x));
}

export function predictPUp15(x: number[]): number {
  if (!model15?.trees?.length) return 0.5;
  return sigmoid(rawScoreOf(model15, x));
}

export function getMeta(): ModelMeta {
  return meta;
}

export function getMeta15(): ModelMeta {
  return meta15;
}

export function is15Enabled(): boolean {
  return meta15?.enabled === true;
}

export function verifySanity(eps = 1e-5): void {
  for (const s of meta.sanity ?? []) {
    const p = predictPUp(s.x);
    if (Math.abs(p - s.p) > eps) {
      throw new Error(`scorer_mismatch expected=${s.p} got=${p}`);
    }
  }
}
