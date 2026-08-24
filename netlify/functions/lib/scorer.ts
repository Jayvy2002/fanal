import lgbmJson from "../_models/fanal_sec_lgbm.json";
import metaJson from "../_models/fanal_sec_meta.json";

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

export type ModelMeta = {
  tau: number;
  features: string[];
  test: {
    gated_acc: number | null;
    n: number;
    coverage: number;
    naive_last_acc: number;
  };
  sanity: { x: number[]; p: number; raw: number }[];
};

const model = lgbmJson as CompactModel;
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

export function rawScore(x: number[]): number {
  let s = 0;
  for (const tree of model.trees) s += scoreTree(tree.nodes, x);
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

export function predictPUp(x: number[]): number {
  return sigmoid(rawScore(x));
}

export function getMeta(): ModelMeta {
  return meta;
}

export function verifySanity(eps = 1e-5): void {
  for (const s of meta.sanity ?? []) {
    const p = predictPUp(s.x);
    if (Math.abs(p - s.p) > eps) {
      throw new Error(`scorer_mismatch expected=${s.p} got=${p}`);
    }
  }
}
