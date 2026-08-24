import type { Kline } from "./coinbase";
import type { SparkPoint, WhyFeature } from "./types";

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
  "tbr",
  "tbr_5",
  "tbr_15",
  "tbr_30",
  "body_ratio",
  "upper_wick",
  "lower_wick",
  "log_hl",
  "close_loc",
  "vol_z_30",
  "vol_z_60",
  "log_vol",
  "vol_shock_5",
  "imb_5",
  "imb_15",
  "imb_30",
  "cvd_5",
  "cvd_15",
  "cvd_30",
  "trade_z_30",
] as const;

/** Tête 60s : insiste sur 15s–2 min (ret/vol/CVD/imb), pas seulement 3–5s. */
export const FEATURES_60 = [
  ...FEATURES,
  "ret_120",
  "rv_120",
  "tbr_60",
  "imb_60",
  "cvd_60",
  "vol_z_120",
] as const;

export type FeatureName = (typeof FEATURES)[number] | string;

const EPS = 1e-12;

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
  return k.v > 0 ? k.tb / k.v : 0.5;
}

function signedOf(k: Kline): number {
  return 2 * k.tb - k.v;
}

/** Leak-free feature map for the latest *completed* 1s bar (caller must drop the current second). Matches train/train_fanal.py. */
export function computeFeatureMap(klines: Kline[]): Record<string, number> {
  const n = klines.length;
  if (n < 61) throw new Error("not_enough_klines");
  const last = klines[n - 1];
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
  const trades = klines.map((k) => k.n);

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
  const vol120 = sliceLast(vols, 120);
  const tr30 = sliceLast(trades, 30);
  const s5 = sliceLast(signed, 5);
  const s15 = sliceLast(signed, 15);
  const s30 = sliceLast(signed, 30);
  const s60 = sliceLast(signed, 60);
  const v5 = sliceLast(vols, 5);
  const v15 = sliceLast(vols, 15);
  const v30 = sliceLast(vols, 30);
  const v60 = sliceLast(vols, 60);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

  const map: Record<string, number> = {
    ret_1: ret(1),
    ret_3: ret(3),
    ret_5: ret(5),
    ret_15: ret(15),
    ret_30: ret(30),
    ret_60: ret(60),
    ret_120: n > 120 ? ret(120) : 0,
    rv_5: stdPop(rets1(5)),
    rv_15: stdPop(rets1(15)),
    rv_30: stdPop(rets1(30)),
    rv_60: stdPop(rets1(60)),
    rv_120: n > 120 ? stdPop(rets1(120)) : stdPop(rets1(60)),
    tbr: tbrOf(last),
    tbr_5: mean(sliceLast(tbrs, 5)),
    tbr_15: mean(sliceLast(tbrs, 15)),
    tbr_30: mean(sliceLast(tbrs, 30)),
    tbr_60: mean(sliceLast(tbrs, 60)),
    body_ratio: body / rng,
    upper_wick: upper / rng,
    lower_wick: lower / rng,
    log_hl: Math.log(Math.max(h, EPS) / Math.max(l, EPS)),
    close_loc: (c - l) / rng,
    vol_z_30: (last.v - mean(vol30)) / Math.max(stdPop(vol30), EPS),
    vol_z_60: (last.v - mean(vol60)) / Math.max(stdPop(vol60), EPS),
    vol_z_120: (last.v - mean(vol120)) / Math.max(stdPop(vol120), EPS),
    log_vol: Math.log(last.v + EPS),
    vol_shock_5: last.v / Math.max(mean(v5), EPS),
    imb_5: sum(s5) / Math.max(sum(v5), EPS),
    imb_15: sum(s15) / Math.max(sum(v15), EPS),
    imb_30: sum(s30) / Math.max(sum(v30), EPS),
    imb_60: sum(s60) / Math.max(sum(v60), EPS),
    cvd_5: sum(s5),
    cvd_15: sum(s15),
    cvd_30: sum(s30),
    cvd_60: sum(s60),
    trade_z_30: (last.n - mean(tr30)) / Math.max(stdPop(tr30), EPS),
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

export function sparkFrom(klines: Kline[], n = 300): SparkPoint[] {
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
  ret_1: "rendement 1s",
  ret_3: "rendement 3s",
  ret_5: "rendement 5s",
  ret_15: "rendement 15s",
  ret_30: "rendement 30s",
  ret_60: "rendement 60s",
  ret_120: "rendement 120s",
  rv_5: "vol. réalisée 5s",
  rv_15: "vol. réalisée 15s",
  rv_30: "vol. réalisée 30s",
  rv_60: "vol. réalisée 60s",
  rv_120: "vol. réalisée 120s",
  tbr: "taker buy",
  tbr_5: "taker buy 5s",
  tbr_15: "taker buy 15s",
  tbr_30: "taker buy 30s",
  tbr_60: "taker buy 60s",
  body_ratio: "corps / range",
  upper_wick: "mèche haute",
  lower_wick: "mèche basse",
  log_hl: "log(haut/bas)",
  close_loc: "position close",
  vol_z_30: "choc volume 30s",
  vol_z_60: "choc volume 60s",
  vol_z_120: "choc volume 120s",
  log_vol: "log volume",
  vol_shock_5: "choc volume 5s",
  imb_5: "déséquilibre 5s",
  imb_15: "déséquilibre 15s",
  imb_30: "déséquilibre 30s",
  imb_60: "déséquilibre 60s",
  cvd_5: "CVD 5s",
  cvd_15: "CVD 15s",
  cvd_30: "CVD 30s",
  cvd_60: "CVD 60s",
  trade_z_30: "choc trades 30s",
  obi_10: "OBI carnet",
};

function fmtFr(x: number, digits: number): string {
  return x.toFixed(digits).replace(".", ",");
}

export function displayFeature(key: string, value: number): string {
  if (key.startsWith("ret_")) return `${fmtFr(value * 1e4, 2)} bps`;
  if (key.startsWith("tbr") || key.startsWith("imb") || key === "body_ratio" || key.endsWith("wick") || key === "close_loc") {
    return `${fmtFr(value * 100, 1)} %`;
  }
  if (key.startsWith("rv_")) return `${fmtFr(value * 100, 3)} %`;
  if (key.startsWith("cvd_")) return fmtFr(value, 4);
  if (key === "obi_10") return fmtFr(value, 3);
  if (key.startsWith("vol_z") || key === "trade_z_30" || key === "vol_shock_5") return fmtFr(value, 2);
  if (key === "log_vol" || key === "log_hl") return fmtFr(value, 4);
  return fmtFr(value, 3);
}

export function whyStrip(
  map: Record<string, number>,
  importance: { name: string; gain: number }[] | undefined,
  extra: { key: string; value: number }[],
): WhyFeature[] {
  const ranked = (importance?.length ? importance.map((i) => i.name) : FEATURES) as string[];
  const keys: string[] = [];
  for (const k of ranked) {
    if (keys.length >= 5) break;
    if (k in map) keys.push(k);
  }
  const out: WhyFeature[] = keys.map((key) => ({
    key,
    label: FEATURE_LABELS_FR[key] ?? key,
    value: map[key],
    display: displayFeature(key, map[key]),
  }));
  for (const e of extra) {
    out.push({
      key: e.key,
      label: FEATURE_LABELS_FR[e.key] ?? e.key,
      value: e.value,
      display: displayFeature(e.key, e.value),
    });
  }
  return out;
}
