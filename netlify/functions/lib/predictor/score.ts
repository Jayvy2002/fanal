import {
  HORIZON_INTRA_S,
  resolveHorizon,
  type PredictOpts,
  type PredictResponse,
  type PredictSide,
} from "./contract";
import { candlesToKlines, completedKlines, fetchCandles1m } from "./coinbase";
import { computeFeatureMap, vectorFromMap, whyReasons } from "./features";
import {
  calibrateP,
  expectedAbsMoveBps,
  expectedMoveBps,
  getMeta,
  predictPUp,
  verifySanity,
} from "./scorer";

let sanityChecked = false;

function ensureSanity() {
  if (sanityChecked) return;
  verifySanity();
  sanityChecked = true;
}

function fmtP(x: number): string {
  return x.toFixed(3).replace(".", ",");
}

function emptyPredict(opts: PredictOpts, error: string | null, why: string): PredictResponse {
  const horizon = resolveHorizon(opts.horizon_s);
  const meta = getMeta(horizon);
  const minEdge = opts.min_edge_bps ?? meta.default_min_edge_bps ?? meta.min_move_bps ?? 4;
  return {
    ts: opts.now ?? Date.now(),
    symbol: opts.symbol,
    horizon_s: horizon,
    p_up: 0.5,
    expected_move_bps: 0,
    confidence: 0.5,
    fire: false,
    side: "flat",
    reasons: [],
    label: "NEUTRE",
    close: 0,
    bar_ts: null,
    tau: meta.tau,
    min_edge_bps: minEdge,
    gate_block: error ? "error" : "warmup",
    venue: "coinbase",
    bar_s: 60,
    kind: "lgbm",
    test: meta.test,
    error: error ?? why,
  };
}

export function decisionFromVector(
  x: number[],
  map: Record<string, number>,
  opts: PredictOpts,
  close: number,
  barTs: number,
): PredictResponse {
  const horizon = resolveHorizon(opts.horizon_s);
  const meta = getMeta(horizon);
  const tau = meta.tau;
  const consumerEdge = opts.min_edge_bps;
  const defaultEdge = meta.default_min_edge_bps ?? meta.min_move_bps ?? (horizon === HORIZON_INTRA_S ? 4 : 10);
  const minEdge = consumerEdge != null && Number.isFinite(consumerEdge) ? consumerEdge : defaultEdge;
  const names = meta.features?.length ? meta.features : Object.keys(map);
  const vec = x.length === names.length ? x : vectorFromMap(map, names);
  const pRaw = predictPUp(vec, horizon);
  const pUp = calibrateP(pRaw, meta.p_calib);
  const absMove = expectedAbsMoveBps(pUp, meta.calib, map, meta.horizon_bars || 1);
  const move = expectedMoveBps(pUp, meta.calib, map, meta.horizon_bars || 1);
  const probUp = pUp >= tau;
  const probDown = pUp <= 1 - tau;
  const probGated = probUp || probDown;
  const moveGated = absMove >= minEdge - 1e-12;
  let side: PredictSide = "flat";
  let fire = false;
  let gate_block: PredictResponse["gate_block"] = null;
  let label: PredictResponse["label"] = "NEUTRE";
  let why: string;
  if (!probGated) {
    gate_block = "prob";
    why = `P(↑) ${fmtP(pUp)} dans la bande τ [${fmtP(1 - tau)} ; ${fmtP(tau)}]`;
  } else if (!moveGated) {
    gate_block = "move";
    why = `|move| prévu ${fmtP(absMove)} bp < ${fmtP(minEdge)} bp (seuil consommateur)`;
  } else if (probUp) {
    side = "up";
    fire = true;
    label = "HAUSSIER";
    why = `P(↑) ${fmtP(pUp)} ≥ τ ${fmtP(tau)} et |move| ${fmtP(absMove)} ≥ ${fmtP(minEdge)} bp`;
  } else {
    side = "down";
    fire = true;
    label = "BAISSIER";
    why = `P(↑) ${fmtP(pUp)} ≤ ${fmtP(1 - tau)} et |move| ${fmtP(absMove)} ≥ ${fmtP(minEdge)} bp`;
  }
  if (fire && absMove < minEdge - 1e-12) {
    fire = false;
    side = "flat";
    label = "NEUTRE";
    gate_block = "move";
  }
  const sideP = side === "down" ? 1 - pUp : side === "up" ? pUp : Math.max(pUp, 1 - pUp);
  const confidence = Math.min(0.92, Math.max(0.5, sideP));
  const reasons = whyReasons(map, meta.importance);
  reasons.unshift({
    key: "gate",
    label: "feu",
    value: fire ? 1 : 0,
    display: why,
  });
  return {
    ts: opts.now ?? Date.now(),
    symbol: opts.symbol,
    horizon_s: horizon,
    p_up: pUp,
    expected_move_bps: move,
    confidence,
    fire,
    side,
    reasons,
    label,
    close,
    bar_ts: barTs,
    tau,
    min_edge_bps: minEdge,
    gate_block,
    venue: "coinbase",
    bar_s: 60,
    kind: "lgbm",
    test: meta.test,
    error: null,
  };
}

/** Point d’entrée unique — UI et bot. */
export async function predict(opts: PredictOpts): Promise<PredictResponse> {
  try {
    ensureSanity();
    const now = opts.now ?? Date.now();
    const raw = await fetchCandles1m(opts.symbol);
    const klines = completedKlines(candlesToKlines(raw), now);
    if (klines.length < 61) {
      return emptyPredict(opts, null, "amorçage Coinbase — pas assez de barres 1m complètes");
    }
    const last = klines[klines.length - 1];
    const map = computeFeatureMap(klines, opts.symbol === "ETH-USD");
    const meta = getMeta(resolveHorizon(opts.horizon_s));
    const x = vectorFromMap(map, meta.features);
    return decisionFromVector(x, map, { ...opts, now }, last.c, last.t);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "predict_error";
    return emptyPredict(opts, msg, msg);
  }
}

export async function predictBoth(symbol: PredictOpts["symbol"], minEdge?: number, now?: number) {
  const intra = await predict({ symbol, horizon_s: 60, min_edge_bps: minEdge, now });
  const slot = await predict({ symbol, horizon_s: 300, min_edge_bps: minEdge, now });
  return { intra, slot };
}
