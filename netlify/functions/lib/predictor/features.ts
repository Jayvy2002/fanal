import type { Kline } from "./coinbase";
import type { PredictReason } from "./contract";

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
  "body_ratio",
  "upper_wick",
  "lower_wick",
  "log_hl",
  "close_loc",
  "vol_z_30",
  "vol_z_60",
  "log_vol",
  "vol_shock_5",
  "range_z_30",
  "is_eth",
] as const;

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

/** Features de la dernière barre 1m *complète*. Identique à train/train_predictor.py. */
export function computeFeatureMap(klines: Kline[], isEth: boolean): Record<string, number> {
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
  const vols = klines.map((k) => k.v);
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
  const ranges = klines.map((k) => Math.max(k.h - k.l, 0));
  const rng30 = sliceLast(ranges, 30);

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
    body_ratio: body / rng,
    upper_wick: upper / rng,
    lower_wick: lower / rng,
    log_hl: Math.log(Math.max(h, EPS) / Math.max(l, EPS)),
    close_loc: (c - l) / rng,
    vol_z_30: (last.v - mean(vol30)) / Math.max(stdPop(vol30), EPS),
    vol_z_60: (last.v - mean(vol60)) / Math.max(stdPop(vol60), EPS),
    log_vol: Math.log(last.v + EPS),
    vol_shock_5: last.v / Math.max(mean(v5), EPS),
    range_z_30: (rng - mean(rng30)) / Math.max(stdPop(rng30), EPS),
    is_eth: isEth ? 1 : 0,
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
  body_ratio: "corps / range",
  upper_wick: "mèche haute",
  lower_wick: "mèche basse",
  log_hl: "log(haut/bas)",
  close_loc: "position close",
  vol_z_30: "choc volume 30m",
  vol_z_60: "choc volume 60m",
  log_vol: "log volume",
  vol_shock_5: "choc volume 5m",
  range_z_30: "choc range 30m",
  is_eth: "ETH (dummy)",
};

function fmtFr(x: number, digits: number): string {
  return x.toFixed(digits).replace(".", ",");
}

export function displayFeature(key: string, value: number): string {
  if (key.startsWith("ret_")) return `${fmtFr(value * 1e4, 2)} bps`;
  if (key === "body_ratio" || key.endsWith("wick") || key === "close_loc") {
    return `${fmtFr(value * 100, 1)} %`;
  }
  if (key.startsWith("rv_")) return `${fmtFr(value * 100, 3)} %`;
  if (key === "is_eth") return value >= 0.5 ? "ETH" : "BTC";
  if (key.startsWith("vol_z") || key === "vol_shock_5" || key === "range_z_30") return fmtFr(value, 2);
  if (key === "log_vol" || key === "log_hl") return fmtFr(value, 4);
  return fmtFr(value, 3);
}

export function whyReasons(
  map: Record<string, number>,
  importance: { name: string; gain: number }[] | undefined,
): PredictReason[] {
  const ranked = (importance?.length ? importance.map((i) => i.name) : FEATURES).filter(
    (k) => k !== "is_eth",
  );
  const keys: string[] = [];
  for (const k of ranked) {
    if (keys.length >= 5) break;
    if (k in map) keys.push(k);
  }
  return keys.map((key) => ({
    key,
    label: FEATURE_LABELS_FR[key] ?? key,
    value: map[key],
    display: displayFeature(key, map[key]),
  }));
}

export function sparkFrom(klines: Kline[], n = 180): { t: number; p: number; o: number; h: number; l: number }[] {
  return sliceLast(klines, n).map((k) => ({ t: k.t, p: k.c, o: k.o, h: k.h, l: k.l }));
}
