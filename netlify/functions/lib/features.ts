import type { Kline } from "./binance";
import type { SparkPoint } from "./types";

export const FEATURES = [
  "ret_1",
  "ret_3",
  "ret_5",
  "ret_15",
  "ret_30",
  "rv_15",
  "rv_30",
  "rv_60",
  "tbr",
  "tbr_5",
  "tbr_15",
  "body_ratio",
  "upper_wick",
  "lower_wick",
  "log_hl",
  "close_loc",
  "vol_z_30",
  "vol_z_60",
  "log_vol",
  "imb_5",
  "imb_15",
  "imb_30",
  "cvd_5",
  "cvd_15",
  "trade_z_30",
] as const;

const EPS = 1e-12;

function mean(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
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

/** Leak-free features for the latest completed 1s bar. Matches train/train_fanal.py. */
export function computeFeatures(klines: Kline[]): number[] {
  const n = klines.length;
  if (n < 61) throw new Error("not_enough_klines");
  const last = klines[n - 1];
  const logc = klines.map((k) => Math.log(Math.max(k.c, EPS)));

  const ret = (k: number) => logc[n - 1] - logc[n - 1 - k];
  const rets1 = (window: number) => {
    const out: number[] = [];
    for (let i = n - window; i < n; i++) out.push(logc[i] - logc[i - 1]);
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
  const tr30 = sliceLast(trades, 30);
  const s5 = sliceLast(signed, 5);
  const s15 = sliceLast(signed, 15);
  const s30 = sliceLast(signed, 30);
  const v5 = sliceLast(vols, 5);
  const v15 = sliceLast(vols, 15);
  const v30 = sliceLast(vols, 30);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

  const map: Record<(typeof FEATURES)[number], number> = {
    ret_1: ret(1),
    ret_3: ret(3),
    ret_5: ret(5),
    ret_15: ret(15),
    ret_30: ret(30),
    rv_15: stdPop(rets1(15)),
    rv_30: stdPop(rets1(30)),
    rv_60: stdPop(rets1(60)),
    tbr: tbrOf(last),
    tbr_5: mean(sliceLast(tbrs, 5)),
    tbr_15: mean(sliceLast(tbrs, 15)),
    body_ratio: body / rng,
    upper_wick: upper / rng,
    lower_wick: lower / rng,
    log_hl: Math.log(Math.max(h, EPS) / Math.max(l, EPS)),
    close_loc: (c - l) / rng,
    vol_z_30: (last.v - mean(vol30)) / Math.max(stdPop(vol30), EPS),
    vol_z_60: (last.v - mean(vol60)) / Math.max(stdPop(vol60), EPS),
    log_vol: Math.log(last.v + EPS),
    imb_5: sum(s5) / Math.max(sum(v5), EPS),
    imb_15: sum(s15) / Math.max(sum(v15), EPS),
    imb_30: sum(s30) / Math.max(sum(v30), EPS),
    cvd_5: sum(s5),
    cvd_15: sum(s15),
    trade_z_30: (last.n - mean(tr30)) / Math.max(stdPop(tr30), EPS),
  };

  return FEATURES.map((f) => {
    const v = map[f];
    return Number.isFinite(v) ? v : 0;
  });
}

export function sparkFrom(klines: Kline[], n = 180): SparkPoint[] {
  return sliceLast(klines, n).map((k) => ({ t: k.t, p: k.c, side: null }));
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
