import type { Kline } from "./coinbase";
import type { SparkPoint, WhyFeature } from "./types";

/** Features 1m — même ordre que train/train_fanal.py. */
export const FEATURES = [
  "ret_1",
  "ret_3",
  "ret_5",
  "ret_15",
  "ret_30",
  "ret_60",
  "rv_5",
  "rv_15",
  "rv_30",
  "rv_60",
  "range_bps",
  "body_ratio",
  "upper_wick",
  "lower_wick",
  "log_hl",
  "close_loc",
  "vol_z_30",
  "vol_z_60",
  "log_vol",
  "vol_shock_5",
  "tbr",
  "tbr_5",
  "tbr_15",
  "imb_5",
  "imb_15",
  "gap_up",
  "gap_dn",
  "gap_up_5",
  "gap_dn_5",
  "tod_sin",
  "tod_cos",
  "dow_sin",
  "dow_cos",
  "obi_10",
] as const;

export type FeatureName = (typeof FEATURES)[number] | string;

export const WARMUP_BARS = 61;
const EPS = 1e-12;
const BAR_MS = 60_000;

function mean(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return xs.length ? s / xs.length : 0;
}

function stdPop(xs: number[]): number {
  if (xs.length === 0) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) {
    const d = x - m;
    s += d * d;
  }
  return Math.sqrt(s / xs.length);
}

function sliceLast<T>(arr: T[], n: number): T[] {
  return arr.slice(Math.max(0, arr.length - n));
}

function tbrOf(k: Kline): number {
  return k.v > 0 && k.tb > 0 ? k.tb / k.v : 0.5;
}

function signedOf(k: Kline): number {
  /* Sans trades (bougies pures) tb=n=0 → pas de flux taker. */
  if (!(k.v > 0) || (k.tb <= 0 && k.n <= 0)) return 0;
  return 2 * k.tb - k.v;
}

function todParts(tMs: number): { tod_sin: number; tod_cos: number; dow_sin: number; dow_cos: number } {
  const d = new Date(tMs);
  const minute = d.getUTCHours() * 60 + d.getUTCMinutes();
  const tod = (2 * Math.PI * minute) / (24 * 60);
  const dow = (2 * Math.PI * d.getUTCDay()) / 7;
  return {
    tod_sin: Math.sin(tod),
    tod_cos: Math.cos(tod),
    dow_sin: Math.sin(dow),
    dow_cos: Math.cos(dow),
  };
}

/**
 * Features de la dernière barre 1m *complète* (l’appelant a déjà retiré la minute en cours).
 * Aligne train/train_fanal.py. OBI / taker-buy : 0,5 / 0 si absents (bougies pures).
 */
export function computeFeatureMap(
  klines: Kline[],
  extra?: { obi_10?: number },
): Record<string, number> {
  const n = klines.length;
  if (n < WARMUP_BARS) throw new Error("not_enough_klines");
  const last = klines[n - 1];
  const prev = klines[n - 2];
  const logc = klines.map((k) => Math.log(Math.max(k.c, EPS)));

  const ret = (k: number) => (n - 1 - k >= 0 ? logc[n - 1] - logc[n - 1 - k] : 0);
  const rets1 = (window: number) => {
    const out: number[] = [];
    const start = Math.max(1, n - window);
    for (let i = start; i < n; i++) out.push(logc[i] - logc[i - 1]);
    return out;
  };

  const tbrs = klines.map(tbrOf);
  const vols = klines.map((k) => k.v);
  const signed = klines.map(signedOf);

  const o = last.o;
  const h = last.h;
  const l = last.l;
  const c = last.c;
  const rng = Math.max(h - l, EPS);
  const body = Math.abs(c - o);
  const upper = h - Math.max(o, c);
  const lower = Math.min(o, c) - l;

  const vol30 = sliceLast(vols, 30);
  const vol60 = sliceLast(vols, 60);
  const v5 = sliceLast(vols, 5);
  const s5 = sliceLast(signed, 5);
  const s15 = sliceLast(signed, 15);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

  const priorHigh5 = Math.max(...klines.slice(n - 6, n - 1).map((k) => k.h));
  const priorLow5 = Math.min(...klines.slice(n - 6, n - 1).map((k) => k.l));
  const gap_up = Math.max(0, prev.h - last.h) / c;
  const gap_dn = Math.max(0, last.l - prev.l) / c;
  const gap_up_5 = Math.max(0, priorHigh5 - last.h) / c;
  const gap_dn_5 = Math.max(0, last.l - priorLow5) / c;

  const tod = todParts(last.t);

  const map: Record<string, number> = {
    ret_1: ret(1),
    ret_3: ret(3),
    ret_5: ret(5),
    ret_15: ret(15),
    ret_30: ret(30),
    ret_60: ret(60),
    rv_5: stdPop(rets1(5)),
    rv_15: stdPop(rets1(15)),
    rv_30: stdPop(rets1(30)),
    rv_60: stdPop(rets1(60)),
    range_bps: (rng / c) * 1e4,
    body_ratio: body / rng,
    upper_wick: upper / rng,
    lower_wick: lower / rng,
    log_hl: Math.log(Math.max(h, EPS) / Math.max(l, EPS)),
    close_loc: (c - l) / rng,
    vol_z_30: (last.v - mean(vol30)) / Math.max(stdPop(vol30), EPS),
    vol_z_60: (last.v - mean(vol60)) / Math.max(stdPop(vol60), EPS),
    log_vol: Math.log(last.v + EPS),
    vol_shock_5: last.v / Math.max(mean(v5), EPS),
    tbr: tbrOf(last),
    tbr_5: mean(sliceLast(tbrs, 5)),
    tbr_15: mean(sliceLast(tbrs, 15)),
    imb_5: sum(s5) / Math.max(sum(v5), EPS),
    imb_15: sum(s15) / Math.max(sum(sliceLast(vols, 15)), EPS),
    gap_up,
    gap_dn,
    gap_up_5,
    gap_dn_5,
    tod_sin: tod.tod_sin,
    tod_cos: tod.tod_cos,
    dow_sin: tod.dow_sin,
    dow_cos: tod.dow_cos,
    obi_10: extra?.obi_10 ?? 0,
  };

  for (const k of Object.keys(map)) {
    if (!Number.isFinite(map[k])) map[k] = 0;
  }
  return map;
}

export function vectorFromMap(map: Record<string, number>, names: string[]): number[] {
  return names.map((f) => {
    const v = map[f];
    return Number.isFinite(v) ? v : 0;
  });
}

export function computeFeatures(klines: Kline[], names: string[] = [...FEATURES]): number[] {
  return vectorFromMap(computeFeatureMap(klines), names);
}

export function sparkFrom(klines: Kline[], n = 180): SparkPoint[] {
  return sliceLast(klines, n).map((k) => ({
    t: k.t,
    p: k.c,
    o: k.o,
    h: k.h,
    l: k.l,
    side: null,
  }));
}

export function retBps(klines: Kline[], lag: number): number | null {
  if (klines.length <= lag) return null;
  const a = klines[klines.length - 1 - lag].c;
  const b = klines[klines.length - 1].c;
  if (a <= 0) return null;
  return ((b - a) / a) * 1e4;
}

export function rvWindow(klines: Kline[], window: number): number | null {
  if (klines.length < window + 1) return null;
  const logc = klines.map((k) => Math.log(Math.max(k.c, EPS)));
  const rets: number[] = [];
  const n = logc.length;
  for (let i = n - window; i < n; i++) rets.push(logc[i] - logc[i - 1]);
  return stdPop(rets);
}

export const FEATURE_LABELS_FR: Record<string, string> = {
  ret_1: "rendement 1m",
  ret_3: "rendement 3m",
  ret_5: "rendement 5m",
  ret_15: "rendement 15m",
  ret_30: "rendement 30m",
  ret_60: "rendement 60m",
  rv_5: "vol. réalisée 5m",
  rv_15: "vol. réalisée 15m",
  rv_30: "vol. réalisée 30m",
  rv_60: "vol. réalisée 60m",
  range_bps: "range 1m",
  body_ratio: "corps / range",
  upper_wick: "mèche haute",
  lower_wick: "mèche basse",
  log_hl: "log(haut/bas)",
  close_loc: "position close",
  vol_z_30: "choc volume 30m",
  vol_z_60: "choc volume 60m",
  log_vol: "log volume",
  vol_shock_5: "choc volume 5m",
  tbr: "taker buy",
  tbr_5: "taker buy 5m",
  tbr_15: "taker buy 15m",
  imb_5: "déséquilibre 5m",
  imb_15: "déséquilibre 15m",
  gap_up: "gap haut (1m)",
  gap_dn: "gap bas (1m)",
  gap_up_5: "hauts non comblés 5m",
  gap_dn_5: "bas non comblés 5m",
  tod_sin: "heure (sin)",
  tod_cos: "heure (cos)",
  dow_sin: "jour (sin)",
  dow_cos: "jour (cos)",
  obi_10: "OBI carnet",
};

function fmtFr(x: number, digits: number): string {
  return x.toFixed(digits).replace(".", ",");
}

export function displayFeature(key: string, value: number): string {
  if (key.startsWith("ret_") || key.startsWith("gap_")) return `${fmtFr(value * 1e4, 2)} bps`;
  if (key === "range_bps") return `${fmtFr(value, 2)} bp`;
  if (
    key.startsWith("tbr") ||
    key.startsWith("imb") ||
    key === "body_ratio" ||
    key.endsWith("wick") ||
    key === "close_loc"
  ) {
    return `${fmtFr(value * 100, 1)} %`;
  }
  if (key.startsWith("rv_")) return `${fmtFr(value * 100, 3)} %`;
  if (key === "obi_10") return fmtFr(value, 3);
  if (key.startsWith("vol_z") || key === "vol_shock_5") return fmtFr(value, 2);
  if (key === "log_vol" || key === "log_hl") return fmtFr(value, 4);
  if (key.startsWith("tod_") || key.startsWith("dow_")) return fmtFr(value, 3);
  return fmtFr(value, 3);
}

export function whyStrip(
  map: Record<string, number>,
  importance: { name: string; gain: number }[] | undefined,
  extra: { key: string; value: number }[],
): WhyFeature[] {
  const ranked = (importance?.length ? importance.map((i) => i.name) : FEATURES) as string[];
  const skip = new Set(["tod_sin", "tod_cos", "dow_sin", "dow_cos"]);
  const keys: string[] = [];
  for (const k of ranked) {
    if (keys.length >= 5) break;
    if (skip.has(k)) continue;
    if (k in map) keys.push(k);
  }
  const out: WhyFeature[] = keys.map((key) => ({
    key,
    label: FEATURE_LABELS_FR[key] ?? key,
    value: map[key],
    display: displayFeature(key, map[key]),
  }));
  for (const e of extra) {
    if (out.some((x) => x.key === e.key)) continue;
    out.push({
      key: e.key,
      label: FEATURE_LABELS_FR[e.key] ?? e.key,
      value: e.value,
      display: displayFeature(e.key, e.value),
    });
  }
  return out;
}

export { BAR_MS };
