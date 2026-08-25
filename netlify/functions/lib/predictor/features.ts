import type { Kline } from "./coinbase";
import type { PredictReason } from "./contract";

/** Features 5 m — identiques à train/train_horizon.py. */
export const FEATURES = [
  "ret_3",
  "ret_12",
  "ret_48",
  "ret_144",
  "ret_288",
  "rv_12",
  "rv_48",
  "rv_144",
  "rv_288",
  "body_ratio",
  "upper_wick",
  "lower_wick",
  "log_hl",
  "close_loc",
  "vol_z_48",
  "vol_z_288",
  "log_vol",
  "vol_shock_12",
  "range_z_48",
  "hour_sin",
  "hour_cos",
  "dow",
  "is_eth",
] as const;

export const FEATURE_LABELS_FR: Record<string, string> = {
  ret_3: "rendement 15 m",
  ret_12: "rendement 1 h",
  ret_48: "rendement 4 h",
  ret_144: "rendement 12 h",
  ret_288: "rendement 24 h",
  rv_12: "vol. réalisée 1 h",
  rv_48: "vol. réalisée 4 h",
  rv_144: "vol. réalisée 12 h",
  rv_288: "vol. réalisée 24 h",
  body_ratio: "corps / range",
  upper_wick: "mèche haute",
  lower_wick: "mèche basse",
  log_hl: "log(haut/bas)",
  close_loc: "position close",
  vol_z_48: "choc volume 4 h",
  vol_z_288: "choc volume 24 h",
  log_vol: "log volume",
  vol_shock_12: "choc volume 1 h",
  range_z_48: "choc range 4 h",
  hour_sin: "heure (sin UTC)",
  hour_cos: "heure (cos UTC)",
  dow: "jour de semaine",
  is_eth: "ETH (dummy)",
};

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

export const WARMUP_BARS = 289;

/** Features de la dernière barre 5 m *complète*. */
export function computeFeatureMap(klines: Kline[], isEth: boolean): Record<string, number> {
  const n = klines.length;
  if (n < WARMUP_BARS) throw new Error("not_enough_klines");
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
  const vol48 = sliceLast(vols, 48);
  const vol288 = sliceLast(vols, 288);
  const v12 = sliceLast(vols, 12);
  const ranges = klines.map((k) => Math.max(k.h - k.l, 0));
  const rng48 = sliceLast(ranges, 48);
  const d = new Date(last.t);
  const hour = d.getUTCHours();
  const dowMon0 = (d.getUTCDay() + 6) % 7;

  const map: Record<string, number> = {
    ret_3: ret(3),
    ret_12: ret(12),
    ret_48: ret(48),
    ret_144: ret(144),
    ret_288: ret(288),
    rv_12: stdPop(rets1(12)),
    rv_48: stdPop(rets1(48)),
    rv_144: stdPop(rets1(144)),
    rv_288: stdPop(rets1(288)),
    body_ratio: body / rng,
    upper_wick: upper / rng,
    lower_wick: lower / rng,
    log_hl: Math.log(Math.max(h, EPS) / Math.max(l, EPS)),
    close_loc: (c - l) / rng,
    vol_z_48: (last.v - mean(vol48)) / Math.max(stdPop(vol48), EPS),
    vol_z_288: (last.v - mean(vol288)) / Math.max(stdPop(vol288), EPS),
    log_vol: Math.log(last.v + EPS),
    vol_shock_12: last.v / Math.max(mean(v12), EPS),
    range_z_48: (rng - mean(rng48)) / Math.max(stdPop(rng48), EPS),
    hour_sin: Math.sin((2 * Math.PI * hour) / 24),
    hour_cos: Math.cos((2 * Math.PI * hour) / 24),
    dow: dowMon0,
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
  if (key === "dow") {
    const days = ["lun", "mar", "mer", "jeu", "ven", "sam", "dim"];
    return days[Math.max(0, Math.min(6, Math.round(value)))] ?? fmtFr(value, 0);
  }
  if (key.startsWith("vol_z") || key === "vol_shock_12" || key === "range_z_48") return fmtFr(value, 2);
  if (key === "log_vol" || key === "log_hl" || key.startsWith("hour_")) return fmtFr(value, 4);
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
