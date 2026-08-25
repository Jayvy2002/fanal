import type { PredictTest } from "./contract";
import { CLIP_DEFAULT, SPREAD_PAD_DEFAULT } from "./fairvalue";
import polyTestJson from "./_models/poly_test.json";

const empty: PredictTest = {
  n: 0,
  coverage: 0,
  win_rate: null,
  e_usdc: null,
  naive_n: 0,
  naive_win_rate: null,
  naive_e_usdc: null,
  clip_usdc: CLIP_DEFAULT,
  spread_pad: SPREAD_PAD_DEFAULT,
  gated_acc: null,
  naive_last_acc: 0.5,
  mean_abs_move_bps: null,
  expectancy_1bp: null,
  expectancy_2bp: null,
};

export type PolyTestFile = {
  asof: string;
  note: string;
  best_name: string;
  blocked_by: string | null;
  trade_assets?: string[];
  combined: PredictTest;
  by_symbol: Record<string, PredictTest>;
  naive: PredictTest;
  configs?: { name: string; e_usdc: number | null; n: number; win_rate: number | null; coverage: number }[];
};

export function getPolyTest(symbol?: string): PredictTest {
  const file = polyTestJson as PolyTestFile;
  if (symbol && file.by_symbol?.[symbol]) return { ...empty, ...file.by_symbol[symbol] };
  if (file.combined) return { ...empty, ...file.combined };
  return empty;
}

export function getPolyTestFile(): PolyTestFile {
  return polyTestJson as PolyTestFile;
}

export function tradeAssetOk(asset: string): boolean {
  const allow = (polyTestJson as PolyTestFile).trade_assets;
  if (!allow?.length) return true;
  return allow.includes(asset);
}
