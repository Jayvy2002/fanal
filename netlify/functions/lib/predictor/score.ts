import {
  HORIZON_1H_S,
  HORIZON_4H_S,
  resolveHorizon,
  type PredictHit,
  type PredictOpts,
  type PredictResponse,
  type PredictSide,
} from "./contract";
import { candlesToKlines, completedKlines, fetchCandles5m } from "./coinbase";
import { WARMUP_BARS, computeFeatureMap, vectorFromMap, whyReasons } from "./features";
import { noteForecast, resolveHit } from "./hits";
import {
  calibrateP,
  emptyTest,
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

function emptyPredict(opts: PredictOpts, error: string | null, why: string, gate: PredictResponse["gate_block"] = "warmup"): PredictResponse {
  const horizon = resolveHorizon(opts.horizon_s);
  const meta = getMeta(horizon);
  return {
    ts: opts.now ?? Date.now(),
    symbol: opts.symbol,
    horizon_s: horizon,
    p_up: 0.5,
    expected_move_bps: 0,
    expected_abs_move_bps: 0,
    confidence: 0.5,
    fire: false,
    side: "flat",
    reasons: [{ key: "gate", label: "appel", value: 0, display: why }],
    label: "NEUTRE",
    close: 0,
    bar_ts: null,
    tau: meta.tau,
    min_edge_bps: 0,
    gate_block: error ? "error" : gate,
    venue: "coinbase",
    bar_s: 300,
    kind: "lgbm",
    test: meta.test ?? emptyTest(),
    last_hit: null,
    error: error ?? why,
  };
}

export function decisionFromVector(
  x: number[],
  map: Record<string, number>,
  opts: PredictOpts,
  close: number,
  barTs: number,
  lastHit: PredictHit | null = null,
): PredictResponse {
  const horizon = resolveHorizon(opts.horizon_s);
  const meta = getMeta(horizon);
  const tau = meta.tau;
  const names = meta.features?.length ? meta.features : Object.keys(map);
  const vec = x.length === names.length ? x : vectorFromMap(map, names);
  const pRaw = predictPUp(vec, horizon);
  const pUp = calibrateP(pRaw, meta.p_calib);
  const absMove = expectedAbsMoveBps(pUp, meta.calib, map, meta.horizon_bars || 12);
  const move = expectedMoveBps(pUp, meta.calib, map, meta.horizon_bars || 12);
  const probUp = pUp >= tau;
  const probDown = pUp <= 1 - tau;
  let side: PredictSide = "flat";
  let fire = false;
  let gate_block: PredictResponse["gate_block"] = null;
  let label: PredictResponse["label"] = "NEUTRE";
  let why: string;
  if (!probUp && !probDown) {
    gate_block = "prob";
    why = `P(↑) ${fmtP(pUp)} dans la bande τ [${fmtP(1 - tau)} ; ${fmtP(tau)}] → NEUTRE`;
  } else if (probUp) {
    side = "up";
    fire = true;
    label = "HAUSSIER";
    why = `P(↑) ${fmtP(pUp)} ≥ τ ${fmtP(tau)} · |move| calibré ${absMove.toFixed(1).replace(".", ",")} bp / ${horizon / 3600} h`;
  } else {
    side = "down";
    fire = true;
    label = "BAISSIER";
    why = `P(↑) ${fmtP(pUp)} ≤ ${fmtP(1 - tau)} · |move| calibré ${absMove.toFixed(1).replace(".", ",")} bp / ${horizon / 3600} h`;
  }
  const sideP = side === "down" ? 1 - pUp : side === "up" ? pUp : Math.max(pUp, 1 - pUp);
  const confidence = Math.min(0.92, Math.max(0.5, sideP));
  const reasons = whyReasons(map, meta.importance);
  reasons.unshift({ key: "gate", label: "appel", value: fire ? 1 : 0, display: why });
  reasons.unshift({
    key: "move",
    label: "|move| calibré",
    value: absMove,
    display: `${absMove.toFixed(1).replace(".", ",")} bp`,
  });
  return {
    ts: opts.now ?? Date.now(),
    symbol: opts.symbol,
    horizon_s: horizon,
    p_up: pUp,
    expected_move_bps: move,
    expected_abs_move_bps: absMove,
    confidence,
    fire,
    side,
    reasons,
    label,
    close,
    bar_ts: barTs,
    tau,
    min_edge_bps: 0,
    gate_block,
    venue: "coinbase",
    bar_s: 300,
    kind: "lgbm",
    test: meta.test ?? emptyTest(),
    last_hit: lastHit,
    error: null,
  };
}

/** Point d’entrée unique. fire = appel UI (HAUSSIER/BAISSIER) ; le paper Poly ignore. */
export async function predict(opts: PredictOpts): Promise<PredictResponse> {
  try {
    ensureSanity();
    const now = opts.now ?? Date.now();
    const raw = await fetchCandles5m(opts.symbol);
    const klines = completedKlines(candlesToKlines(raw), now, 300_000);
    if (klines.length < WARMUP_BARS) {
      return emptyPredict(opts, null, "amorçage Coinbase — pas assez de barres 5 m complètes");
    }
    const last = klines[klines.length - 1];
    const map = computeFeatureMap(klines, opts.symbol === "ETH-USD");
    const meta = getMeta(resolveHorizon(opts.horizon_s));
    const x = vectorFromMap(map, meta.features);
    const lastHit = resolveHit(opts.symbol, resolveHorizon(opts.horizon_s), last.c, now);
    const out = decisionFromVector(x, map, { ...opts, now }, last.c, last.t, lastHit);
    noteForecast({
      symbol: opts.symbol,
      horizon_s: out.horizon_s,
      origin_bar_ts: last.t,
      origin_close: last.c,
      side: out.side,
      fire: out.fire,
      p_up: out.p_up,
    });
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "predict_error";
    return emptyPredict(opts, msg, msg, "error");
  }
}

export async function predictBoth(symbol: PredictOpts["symbol"], minEdge?: number, now?: number) {
  const h1 = await predict({ symbol, horizon_s: HORIZON_1H_S, min_edge_bps: minEdge, now });
  const h4 = await predict({ symbol, horizon_s: HORIZON_4H_S, min_edge_bps: minEdge, now });
  return { intra: h1, slot: h4, h1, h4 };
}
