import lgbmJson from "../_models/fanal_1m_lgbm.json";
import metaJson from "../_models/fanal_1m_meta.json";
import { PATH_HORIZONS_M, PRIMARY_HORIZON_M } from "./forecasts";

type Leaf = { v: number };
type Split = {
  f: number;
  t: number;
  left: number;
  right: number;
  missing: number;
};
type Node = Leaf | Split;
type CompactHead = {
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
  horizon_m?: number;
  clip_max_bps?: number;
};

export type ModelMeta = {
  tau: number;
  min_move_bps?: number;
  features: string[];
  horizon_s?: number;
  bar_s?: number;
  primary_horizon_m?: number;
  horizons_m?: number[];
  test: {
    gated_acc: number | null;
    n: number;
    coverage: number;
    naive_last_acc: number;
    mean_abs_move_bps?: number | null;
    all_test_mean_abs_bps?: number | null;
    expectancy_maker_rt?: number | null;
    expectancy_taker_rt?: number | null;
    expectancy_1bp?: number | null;
    expectancy_2bp?: number | null;
    note?: string;
  };
  sanity: { x: number[]; p: number; raw: number; horizon_m?: number }[];
  calib?: Calib;
  heads?: Record<
    string,
    {
      calib?: Calib;
      test?: ModelMeta["test"];
      enabled?: boolean;
    }
  >;
  importance?: { name: string; gain: number }[];
  train_archive?: string;
  live_venue?: string;
  n_days?: number;
  n_bars?: number;
};

type CompactBundle = {
  objective: string;
  features: string[];
  heads: Record<string, CompactHead>;
};

const bundle = lgbmJson as CompactBundle;
const meta = metaJson as ModelMeta;

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

function rawScoreOf(m: CompactHead, x: number[]): number {
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

function headOf(horizonM: number): CompactHead | null {
  const h = bundle.heads?.[String(horizonM)];
  if (!h?.trees?.length) return null;
  return h;
}

export function predictPUpAt(x: number[], horizonM: number): number {
  const h = headOf(horizonM);
  if (!h) return 0.5;
  return sigmoid(rawScoreOf(h, x));
}

export function predictPUp(x: number[]): number {
  return predictPUpAt(x, meta.primary_horizon_m ?? PRIMARY_HORIZON_M);
}

export function getMeta(): ModelMeta {
  return meta;
}

export function getHeadCalib(horizonM: number): Calib | undefined {
  return meta.heads?.[String(horizonM)]?.calib ?? (horizonM === 15 ? meta.calib : undefined);
}

export function listHorizons(): number[] {
  return meta.horizons_m?.length ? meta.horizons_m : [...PATH_HORIZONS_M];
}

export function verifySanity(eps = 1e-5): void {
  for (const s of meta.sanity ?? []) {
    const h = s.horizon_m ?? meta.primary_horizon_m ?? 15;
    const p = predictPUpAt(s.x, h);
    if (Math.abs(p - s.p) > eps) {
      throw new Error(`scorer_mismatch h=${h} expected=${s.p} got=${p}`);
    }
  }
}
