/**
 * Tests du contrat prédicteur + paper Polymarket (pas d’ordres live).
 * Run: node --experimental-strip-types --no-warnings netlify/functions/lib/fanal.test.ts
 */
import { completedKlines } from "./predictor/coinbase";
import { decisionFromVector } from "./predictor/score";
import { calibrateP } from "./predictor/scorer";
import type { PredictResponse } from "./predictor/contract";
import {
  CRYPTO_TAKER_RATE,
  cryptoTakerFeeUsdc,
  intraRoundTripPnl,
  lockBreakEvenP,
  lockEdgeUsdc,
  minExitMid,
} from "./polymarket/fees";
import { shouldEnterIntra, shouldExitIntra } from "./polymarket/intra";
import { projectLock } from "./polymarket/lock";
import { applyPolyStep, newPolyLedger } from "./polymarket/paper";
import type { DiscoveredMarket } from "./polymarket/markets";
import type { PairBook } from "./polymarket/clob";

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (!cond) {
    failed += 1;
    console.error("FAIL", msg);
  } else {
    console.log("ok ", msg);
  }
}
function almost(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

/* 1. Frais officiels crypto : fee = C * 0.07 * p * (1-p), pic à 50¢, makers 0. */
{
  const table: [number, number][] = [
    [0.25, 100 * 0.07 * 0.25 * 0.75],
    [0.5, 100 * 0.07 * 0.5 * 0.5],
    [0.9, 100 * 0.07 * 0.9 * 0.1],
  ];
  for (const [p, expect] of table) {
    const got = cryptoTakerFeeUsdc(100, p);
    assert(almost(got, Math.round(expect * 1e5) / 1e5, 1e-5), `fee C=100 p=${p} → ${got} vs ${expect}`);
  }
  assert(almost(cryptoTakerFeeUsdc(100, 0.5), 1.75, 1e-5), "peak 50¢ = 1.75 USDC / 100 shares");
  assert(cryptoTakerFeeUsdc(100, 0.5) > cryptoTakerFeeUsdc(100, 0.9), "fee lower at 90¢ than at 50¢");
  assert(almost(lockBreakEvenP(0.9), 0.9 + 0.07 * 0.9 * 0.1, 1e-6), "90¢ break-even ≈ 91 %");
  assert(lockBreakEvenP(0.9) > 0.90 && lockBreakEvenP(0.9) < 0.92, "lock 90¢ needs ~91% true wins");
  assert(CRYPTO_TAKER_RATE === 0.07, "crypto taker rate 0.07");
}

/* 2. Intra exit math : mid doit couvrir les deux jambes taker + pad. */
{
  const shares = 10;
  const entry = 0.25;
  const { pnl, feeIn, feeOut } = intraRoundTripPnl(shares, 0.25, 0.6);
  const expectFeeIn = 10 * 0.07 * 0.25 * 0.75;
  const expectFeeOut = 10 * 0.07 * 0.6 * 0.4;
  assert(almost(feeIn, Math.round(expectFeeIn * 1e5) / 1e5, 1e-5), "entry taker fee");
  assert(almost(feeOut, Math.round(expectFeeOut * 1e5) / 1e5, 1e-5), "exit taker fee");
  assert(almost(pnl, shares * (0.6 - 0.25) - feeIn - feeOut, 1e-6), "intra pnl = Δp*C − fees both legs");
  const minMid = minExitMid(entry, shares, 0.02);
  assert(minMid > entry, "min exit mid above entry");
  const hold = shouldExitIntra({ entryAsk: entry, mid: entry + 0.01, shares, held_s: 5, remaining_slot_s: 200 });
  assert(!hold.exit, "small mid move does not exit");
  const win = shouldExitIntra({ entryAsk: entry, mid: 0.55, shares, held_s: 5, remaining_slot_s: 200 });
  assert(win.exit && !win.scratch, "large mid move exits after fees");
  const stop = shouldExitIntra({ entryAsk: entry, mid: entry, shares, held_s: 91, remaining_slot_s: 200 });
  assert(stop.exit && stop.scratch, "time-stop scratches");
}

/* 3. Lock skip when TWAP stale — jamais de substitut Coinbase. */
{
  const stale = projectLock({
    twap: 65000,
    strike: 64900,
    remaining_s: 20,
    rv_1m: 0.001,
    twap_stale: true,
    has_strike: true,
    strike_late: false,
  });
  assert(stale.skip && stale.skip_reason === "twap_stale", "stale TWAP skips lock");
  const missing = projectLock({
    twap: 65000,
    strike: 0,
    remaining_s: 20,
    rv_1m: 0.001,
    twap_stale: false,
    has_strike: false,
    strike_late: false,
  });
  assert(missing.skip && missing.skip_reason === "no_official_strike", "no strike skips lock");
  const ok = projectLock({
    twap: 65100,
    strike: 65000,
    remaining_s: 20,
    rv_1m: 0.0004,
    twap_stale: false,
    has_strike: true,
    strike_late: false,
  });
  assert(!ok.skip && ok.p_up > 0.5, "fresh TWAP above strike → P(up) > 0.5");
}

/* 4. no fire ⇒ no trade (intra). */
{
  const pred: PredictResponse = {
    ts: 1,
    symbol: "BTC-USD",
    horizon_s: 60,
    p_up: 0.51,
    expected_move_bps: 0.2,
    confidence: 0.51,
    fire: false,
    side: "flat",
    reasons: [],
    label: "NEUTRE",
    close: 65000,
    bar_ts: 1,
    tau: 0.58,
    min_edge_bps: 4,
    gate_block: "prob",
    venue: "coinbase",
    bar_s: 60,
    kind: "lgbm",
    test: { gated_acc: null, n: 0, coverage: 0, naive_last_acc: 0.5, mean_abs_move_bps: null, expectancy_1bp: null, expectancy_2bp: null },
    error: null,
  };
  const book: PairBook = {
    up: { bid: 0.74, ask: 0.75, mid: 0.745, spread: 0.01, bids: [], asks: [] },
    down: { bid: 0.24, ask: 0.25, mid: 0.245, spread: 0.01, bids: [], asks: [] },
  };
  const ent = shouldEnterIntra(pred, book);
  assert(!ent.ok && ent.reason === "no_fire", "shouldEnterIntra blocks on fire=false");

  const market: DiscoveredMarket = {
    asset: "BTC",
    symbol: "BTC-USD",
    slug: "btc-updown-5m-1",
    title: "t",
    question: "q",
    description: "d",
    resolution_source: "https://data.chain.link/streams/btc-usd-twap-60s-streams",
    twap_window_s: 60,
    slot_start_s: 1_000_000,
    slot_end_s: 1_000_300,
    remaining_s: 200,
    up_token: "1",
    down_token: "2",
    outcomes: ["Up", "Down"],
    fee_rate: 0.07,
    fee_taker_only: true,
    condition_id: null,
  };
  const led = newPolyLedger(1_000_000_000);
  applyPolyStep(led, {
    now: 1_000_000_000,
    markets: [market],
    books: { BTC: book },
    twaps: {},
    preds: { "BTC-USD": { intra: pred, slot: pred } },
  });
  assert(led.open.length === 0 && led.n === 0, "applyPolyStep opens nothing when fire=false");
  assert(led.n_skip_nofire >= 1, "silent predictor is counted as skip");
}

/* 5. Fire + cheap Down ask → intra take at ask. */
{
  const pred: PredictResponse = {
    ts: 1,
    symbol: "BTC-USD",
    horizon_s: 60,
    p_up: 0.2,
    expected_move_bps: -8,
    confidence: 0.8,
    fire: true,
    side: "down",
    reasons: [],
    label: "BAISSIER",
    close: 65000,
    bar_ts: 1,
    tau: 0.58,
    min_edge_bps: 4,
    gate_block: null,
    venue: "coinbase",
    bar_s: 60,
    kind: "lgbm",
    test: { gated_acc: null, n: 0, coverage: 0, naive_last_acc: 0.5, mean_abs_move_bps: null, expectancy_1bp: null, expectancy_2bp: null },
    error: null,
  };
  const book: PairBook = {
    up: { bid: 0.74, ask: 0.75, mid: 0.745, spread: 0.01, bids: [], asks: [] },
    down: { bid: 0.24, ask: 0.25, mid: 0.245, spread: 0.01, bids: [], asks: [] },
  };
  const ent = shouldEnterIntra(pred, book);
  assert(ent.ok && ent.side === "down" && ent.ask === 0.25, "stale cheap Down is taken at 25¢ ask");
  const already = shouldEnterIntra(pred, {
    up: book.up,
    down: { ...book.down, ask: 0.82, bid: 0.81, mid: 0.815 },
  });
  assert(!already.ok && already.reason === "clob_already_moved", "no intra if CLOB already priced the dump");
}

/* 6. Completed 1m bars — current minute excluded. */
{
  const now = 120_000;
  const bars = [0, 60_000, 120_000].map((t) => ({ t, o: 1, h: 1, l: 1, c: 1, v: 1 }));
  const done = completedKlines(bars, now);
  assert(done.length === 2 && done[1].t === 60_000, "drop incomplete current 1m bar");
}

/* 7. Fire gate : direction AND |move| — consumer min_edge. */
{
  const map: Record<string, number> = {};
  for (const k of [
    "ret_1","ret_3","ret_5","ret_15","ret_30","ret_60",
    "rv_5","rv_15","rv_30","rv_60",
    "body_ratio","upper_wick","lower_wick","log_hl","close_loc",
    "vol_z_30","vol_z_60","log_vol","vol_shock_5","range_z_30","is_eth",
  ]) map[k] = 0;
  map.rv_5 = 0.0004;
  map.rv_60 = 0.0004;
  /* vecteur dummy : on teste le gate via decisionFromVector si les modèles existent.
     Ici on vérifie seulement calibrateP ne fabrique pas 99 %. */
  const hi = calibrateP(0.999, [{ lo: 0.9, hi: 1.01, mean_y: 0.61, n: 100 }]);
  assert(hi < 0.93, `calibrated confidence is not a fake 99% (got ${hi})`);
  const mid = calibrateP(0.5, undefined);
  assert(mid >= 0.05 && mid <= 0.95, "raw p clipped to [0.05, 0.95]");
  void decisionFromVector;
}

/* 8. Lock EV négatif à 90¢ si P=80 %. */
{
  const ev = lockEdgeUsdc(10, 0.9, 0.8);
  assert(ev < 0, "buying 90¢ at 80% true win is -EV after crypto fees");
  const evSure = lockEdgeUsdc(10, 0.9, 0.97);
  assert(evSure > 0, "97% at 90¢ clears the 91% fee hurdle");
}

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log("\nall fanal tests passed");
