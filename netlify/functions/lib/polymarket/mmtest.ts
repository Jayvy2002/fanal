import mmTestJson from "../predictor/_models/mm_test.json";
import type { MmTest } from "./mmtypes";

const empty: MmTest = {
  n: 0,
  e_usdc: null,
  naive_e_usdc: null,
  naive_n: 0,
  coverage: 0,
  mean_pair: null,
  n_taker: 0,
  n_maker: 0,
  lean_skipped: "ratio 1,0–1,5× skippé (TEST)",
  note: "TEST CLOB pas encore chargé.",
};

export function getMmTest(): MmTest {
  const raw = mmTestJson as Partial<MmTest>;
  if (!raw || typeof raw !== "object") return empty;
  return { ...empty, ...raw };
}
