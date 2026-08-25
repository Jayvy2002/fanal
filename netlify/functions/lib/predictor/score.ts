import {
  HORIZON_INTRA_S,
  resolveHorizon,
  type PredictMarketContext,
  type PredictOpts,
  type PredictResponse,
  type PredictSide,
} from "./contract";
import { candlesToKlines, completedKlines, fetchCandles1m } from "./coinbase";
import { computeFeatureMap, vectorFromMap, whyReasons } from "./features";
import { decideFair, LOCK_90C_HURDLE, MIN_EV_USDC } from "./fairvalue";
import { loadLiveContext } from "./livectx";
import { getPolyTest } from "./polytest";
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

function packBase(
  opts: PredictOpts,
  extra: Partial<PredictResponse> & { fire: boolean; side: PredictSide; gate_block: PredictResponse["gate_block"] },
): PredictResponse {
  const horizon = resolveHorizon(opts.horizon_s);
  const meta = getMeta(horizon);
  const minEdge = opts.min_edge_bps ?? meta.default_min_edge_bps ?? meta.min_move_bps ?? 4;
  const pUp = extra.p_up ?? 0.5;
  const side = extra.side;
  const label = side === "up" ? "HAUSSIER" : side === "down" ? "BAISSIER" : "NEUTRE";
  return {
    ts: opts.now ?? Date.now(),
    symbol: opts.symbol,
    horizon_s: horizon,
    p_up: pUp,
    expected_move_bps: extra.expected_move_bps ?? 0,
    confidence: extra.confidence ?? 0.5,
    fire: extra.fire,
    side,
    reasons: extra.reasons ?? [],
    label,
    close: extra.close ?? 0,
    bar_ts: extra.bar_ts ?? null,
    tau: extra.tau ?? meta.tau,
    min_edge_bps: minEdge,
    min_edge_usdc: extra.min_edge_usdc ?? MIN_EV_USDC,
    edge_usdc: extra.edge_usdc ?? 0,
    fee_usdc: extra.fee_usdc ?? 0,
    p_fair: extra.p_fair ?? pUp,
    p_clob: extra.p_clob ?? null,
    strat: extra.strat ?? null,
    lock_hurdle_90c: LOCK_90C_HURDLE,
    gate_block: extra.gate_block,
    venue: "coinbase",
    bar_s: 60,
    kind: "fairvalue",
    test: extra.test ?? getPolyTest(opts.symbol),
    error: extra.error ?? null,
  };
}

function emptyPredict(opts: PredictOpts, error: string | null, why: string, gate: PredictResponse["gate_block"] = "warmup"): PredictResponse {
  return packBase(opts, {
    fire: false,
    side: "flat",
    gate_block: error ? "error" : gate,
    reasons: [{ key: "gate", label: "feu", value: 0, display: why }],
    error: error ?? why,
  });
}

/** Lecture LightGBM (UI) — ne pilote plus le feu. Conservé pour les tests de calibration. */
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
  let lgbmFire = false;
  let gate_block: PredictResponse["gate_block"] = null;
  let why: string;
  if (!probGated) {
    gate_block = "prob";
    why = `P(↑) ${fmtP(pUp)} dans la bande τ [${fmtP(1 - tau)} ; ${fmtP(tau)}]`;
  } else if (!moveGated) {
    gate_block = "move";
    why = `|move| prévu ${fmtP(absMove)} bp < ${fmtP(minEdge)} bp (seuil consommateur)`;
  } else if (probUp) {
    side = "up";
    lgbmFire = true;
    why = `P(↑) ${fmtP(pUp)} ≥ τ ${fmtP(tau)} et |move| ${fmtP(absMove)} ≥ ${fmtP(minEdge)} bp`;
  } else {
    side = "down";
    lgbmFire = true;
    why = `P(↑) ${fmtP(pUp)} ≤ ${fmtP(1 - tau)} et |move| ${fmtP(absMove)} ≥ ${fmtP(minEdge)} bp`;
  }
  void lgbmFire;
  const reasons = whyReasons(map, meta.importance);
  reasons.unshift({
    key: "lgbm",
    label: "lecture 1 m",
    value: pUp,
    display: `LightGBM (pas le feu) · ${why}`,
  });
  return packBase(
    { ...opts, min_edge_bps: minEdge },
    {
      fire: false,
      side: "flat",
      gate_block: gate_block ?? "fee",
      p_up: pUp,
      expected_move_bps: move,
      confidence: Math.min(0.92, Math.max(0.5, Math.max(pUp, 1 - pUp))),
      reasons,
      close,
      bar_ts: barTs,
      tau,
      error: null,
    },
  );
}

export function decisionFromFair(
  ctx: PredictMarketContext,
  opts: PredictOpts,
  close: number,
  barTs: number | null,
  rv1m: number,
  lgbmReasons: PredictResponse["reasons"] = [],
): PredictResponse {
  if (ctx.twap == null || !(ctx.twap > 0) || ctx.twap_stale) {
    return emptyPredict(opts, null, "TWAP officiel stale ou manquant — pas de feu", "twap");
  }
  if (!ctx.has_strike || ctx.strike == null || !(ctx.strike > 0) || ctx.strike_late) {
    return emptyPredict(
      opts,
      null,
      ctx.strike_late ? "strike pas observé à l’open — skip" : "pas de strike officiel — skip",
      "twap",
    );
  }
  const dec = decideFair({
    remaining_s: ctx.remaining_s,
    twap: ctx.twap,
    strike: ctx.strike,
    twap_stale: ctx.twap_stale,
    has_strike: ctx.has_strike,
    strike_late: ctx.strike_late,
    rv_1m: rv1m,
    up_ask: ctx.up_ask,
    up_bid: ctx.up_bid,
    down_ask: ctx.down_ask,
    down_bid: ctx.down_bid,
  });
  const sideP = dec.side === "down" ? 1 - dec.p_fair_up : dec.side === "up" ? dec.p_fair_up : Math.max(dec.p_fair_up, 1 - dec.p_fair_up);
  const lgbm = lgbmReasons.filter((r) => r.key !== "gate" && r.key !== "lgbm");
  return packBase(opts, {
    fire: dec.fire,
    side: dec.side,
    gate_block: dec.gate_block,
    p_up: dec.p_fair_up,
    p_fair: dec.p_fair_up,
    p_clob: dec.p_clob_up,
    expected_move_bps: ((ctx.twap - ctx.strike) / ctx.strike) * 1e4,
    confidence: Math.min(0.995, Math.max(0.5, sideP)),
    reasons: [...dec.reasons, ...lgbm.slice(0, 4)],
    close,
    bar_ts: barTs,
    edge_usdc: dec.edge_usdc,
    fee_usdc: dec.fee_usdc,
    strat: dec.strat,
    error: null,
  });
}

/** Point d’entrée unique — UI et bot. Feu = fair value vs CLOB, fee-aware. */
export async function predict(opts: PredictOpts): Promise<PredictResponse> {
  try {
    ensureSanity();
    const now = opts.now ?? Date.now();
    const [raw, ctx] = await Promise.all([
      fetchCandles1m(opts.symbol).catch(() => [] as Awaited<ReturnType<typeof fetchCandles1m>>),
      opts.context ? Promise.resolve(opts.context) : loadLiveContext(opts.symbol, now),
    ]);
    const klines = completedKlines(candlesToKlines(raw), now);
    let close = 0;
    let barTs: number | null = null;
    let rv = 0.001;
    let lgbmReasons: PredictResponse["reasons"] = [];
    if (klines.length >= 61) {
      const last = klines[klines.length - 1];
      close = last.c;
      barTs = last.t;
      const map = computeFeatureMap(klines, opts.symbol === "ETH-USD");
      rv = Math.max(map.rv_15 || map.rv_5 || 0, 1e-6);
      const meta = getMeta(resolveHorizon(opts.horizon_s));
      const reading = decisionFromVector(vectorFromMap(map, meta.features), map, { ...opts, now }, close, last.t);
      lgbmReasons = reading.reasons;
    }
    if (!ctx) {
      return emptyPredict(opts, null, "marché 5 m / CLOB indisponible — pas de feu", "warmup");
    }
    return decisionFromFair(ctx, { ...opts, now }, close, barTs, ctx.rv_1m && ctx.rv_1m > 0 ? ctx.rv_1m : rv, lgbmReasons);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "predict_error";
    return emptyPredict(opts, msg, msg, "error");
  }
}

export async function predictBoth(symbol: PredictOpts["symbol"], minEdge?: number, now?: number, context?: PredictMarketContext) {
  const intra = await predict({ symbol, horizon_s: 60, min_edge_bps: minEdge, now, context });
  const slot = await predict({ symbol, horizon_s: 300, min_edge_bps: minEdge, now, context });
  return { intra, slot };
}
