import { FEATURES_60 } from "./features";
import {
  conservativeAbsMove60Bps,
  expectedAbsMoveBps,
} from "./forecasts";
import { paperGateBps } from "./paperFees";
import {
  getMeta60,
  has60Model,
  predictPUp60,
  sigmoid,
  type ModelMeta,
} from "./scorer";
import type { Signal } from "./types";
import { adaptLiveFeatures } from "./venue";
import { vectorFromMap } from "./features";

function fmtP(x: number): string {
  return x.toFixed(3).replace(".", ",");
}

function momentumPUp(map: Record<string, number>): number {
  /* Structure 15s–2 min, pas le mean-reversion 3–5s. */
  const r15 = map.ret_15 ?? 0;
  const r30 = map.ret_30 ?? 0;
  const r60 = map.ret_60 ?? 0;
  const r120 = map.ret_120 ?? 0;
  const rv = Math.max(map.rv_15 ?? 0, map.rv_30 ?? 0, map.rv_60 ?? 0, map.rv_120 ?? 0, 1e-12);
  const z = (0.15 * r15 + 0.25 * r30 + 0.35 * r60 + 0.25 * r120) / (rv * Math.sqrt(60));
  return sigmoid(Math.max(-8, Math.min(8, z)));
}

export function makePaperSignal(
  pUp: number,
  close: number,
  horizonS: number,
  tau: number,
  absMove: number,
  signedMove: number,
  minMoveBps: number,
  extraWhy?: string,
): Signal {
  const probUp = pUp >= tau;
  const probDown = pUp <= 1 - tau;
  const probGated = probUp || probDown;
  const moveGated = absMove >= minMoveBps - 1e-12;
  let label: Signal["label"] = "NEUTRE";
  let side: Signal["side"] = "flat";
  let gated = false;
  let gate_block: Signal["gate_block"] = null;
  let why: string;
  if (!probGated) {
    gate_block = "prob";
    why = `P(↑) 60s entre 1−τ ${fmtP(1 - tau)} et τ ${fmtP(tau)} — pas de take`;
  } else if (!moveGated) {
    gate_block = "move";
    why =
      `|move| 60s prévu ${fmtP(absMove)} bp < gate frais ${fmtP(minMoveBps)} bp (RT faiseur) — NEUTRE`;
  } else if (probUp) {
    label = "HAUSSIER";
    side = "up";
    gated = true;
    why = `P(↑) ${fmtP(pUp)} ≥ τ ${fmtP(tau)} et |move| ${fmtP(absMove)} ≥ ${fmtP(minMoveBps)} bp`;
  } else {
    label = "BAISSIER";
    side = "down";
    gated = true;
    why = `P(↑) ${fmtP(pUp)} ≤ 1−τ ${fmtP(1 - tau)} et |move| ${fmtP(absMove)} ≥ ${fmtP(minMoveBps)} bp`;
  }
  if (gated && absMove < minMoveBps - 1e-12) {
    gated = false;
    side = "flat";
    label = "NEUTRE";
    gate_block = "move";
  }
  if (extraWhy && !gated) why = `${why} ${extraWhy}`;
  const confidence = side === "down" ? 1 - pUp : side === "up" ? pUp : Math.max(pUp, 1 - pUp);
  const target_px = close * (1 + signedMove / 1e4);
  return {
    side,
    label,
    p_up: pUp,
    confidence,
    gated,
    horizon_s: horizonS,
    why,
    close,
    tau,
    expected_move_bps: signedMove,
    target_px,
    min_move_bps: minMoveBps,
    gate_block,
  };
}

export function buildSignal60(
  rawMap: Record<string, number>,
  pUp5: number,
  close: number,
): { signal: Signal; meta: ModelMeta; fallback: boolean } {
  const meta = getMeta60();
  const tau = meta.tau || 0.58;
  const minMove = paperGateBps(60);
  const fallback = !has60Model();
  const archive = meta.train_archive;
  const modelMap = adaptLiveFeatures(rawMap, archive);
  const names = meta.features?.length ? meta.features : [...FEATURES_60];
  let pUp: number;
  let absMove: number;
  if (!fallback) {
    const x = vectorFromMap(modelMap, names);
    pUp = predictPUp60(x);
    absMove = expectedAbsMoveBps(pUp, meta.calib, modelMap, 60);
  } else {
    const pMom = momentumPUp(rawMap);
    pUp = 0.35 * pUp5 + 0.65 * pMom;
    absMove = conservativeAbsMove60Bps(pUp, rawMap);
  }
  const sign = pUp >= 0.5 ? 1 : -1;
  const signed = sign * absMove;
  const extra = fallback
    ? "(tête 60s fallback : momentum 15s–2 min + vol réalisée, pas un LightGBM 60s.)"
    : undefined;
  const signal = makePaperSignal(pUp, close, 60, tau, absMove, signed, minMove, extra);
  return { signal, meta, fallback };
}

export function emptySignal60(close: number, why: string): Signal {
  const s = makePaperSignal(0.5, close, 60, 0.58, 0, 0, paperGateBps(60));
  s.why = why;
  s.gated = false;
  s.side = "flat";
  s.label = "NEUTRE";
  return s;
}
