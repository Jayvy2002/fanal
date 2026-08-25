/**
 * Tests du contrat prédicteur + paper Polymarket (pas d’ordres live).
 * Run: npx tsx netlify/functions/lib/fanal.test.ts
 */
import { completedKlines } from "./predictor/coinbase";
import { decisionFromVector } from "./predictor/score";
import { calibrateP } from "./predictor/scorer";
import { decideFair, inMidBand, LOCK_90C_HURDLE } from "./predictor/fairvalue";
import type { PredictResponse } from "./predictor/contract";
import { getPolyTest } from "./predictor/polytest";
import {
  CRYPTO_TAKER_RATE,
  cryptoTakerFeeUsdc,
  intraRoundTripPnl,
  lockBreakEvenP,
  lockEdgeUsdc,
  minExitMid,
  redeemPnl,
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

function dummyPred(over: Partial<PredictResponse> = {}): PredictResponse {
  return {
    ts: 1,
    symbol: "BTC-USD",
    horizon_s: 60,
    p_up: 0.5,
    expected_move_bps: 0,
    confidence: 0.5,
    fire: false,
    side: "flat",
    reasons: [],
    label: "NEUTRE",
    close: 65000,
    bar_ts: 1,
    tau: 0.58,
    min_edge_bps: 4,
    min_edge_usdc: 0.5,
    edge_usdc: 0,
    fee_usdc: 0,
    p_fair: 0.5,
    p_clob: 0.5,
    strat: null,
    lock_hurdle_90c: LOCK_90C_HURDLE,
    gate_block: "prob",
    venue: "coinbase",
    bar_s: 60,
    kind: "fairvalue",
    test: getPolyTest("BTC-USD"),
    error: null,
    ...over,
  };
}

function market(over: Partial<DiscoveredMarket> = {}): DiscoveredMarket {
  return {
    asset: "BTC",
    symbol: "BTC-USD",
    slug: "btc-updown-5m-1000000",
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
    ...over,
  };
}

const cheapDown: PairBook = {
  up: { bid: 0.74, ask: 0.75, mid: 0.745, spread: 0.01, bids: [], asks: [] },
  down: { bid: 0.24, ask: 0.25, mid: 0.245, spread: 0.01, bids: [], asks: [] },
};

const mid50: PairBook = {
  up: { bid: 0.49, ask: 0.51, mid: 0.5, spread: 0.02, bids: [], asks: [] },
  down: { bid: 0.49, ask: 0.51, mid: 0.5, spread: 0.02, bids: [], asks: [] },
};

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
  assert(lockBreakEvenP(0.9) > 0.9 && lockBreakEvenP(0.9) < 0.92, "lock 90¢ needs ~91% true wins");
  assert(CRYPTO_TAKER_RATE === 0.07, "crypto taker rate 0.07");
}

/* 2. Intra exit math : mid doit couvrir les deux jambes taker + pad. Convert lock ≤ 60 s. */
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
  assert(!hold.exit && !hold.convert_lock, "small mid move does not exit");
  const win = shouldExitIntra({ entryAsk: entry, mid: 0.55, shares, held_s: 5, remaining_slot_s: 200 });
  assert(win.exit && !win.scratch, "large mid move exits after fees");
  const stop = shouldExitIntra({ entryAsk: entry, mid: entry, shares, held_s: 41, remaining_slot_s: 200 });
  assert(stop.exit && stop.scratch, "time-stop scratches if odds stall");
  const conv = shouldExitIntra({ entryAsk: entry, mid: entry, shares, held_s: 10, remaining_slot_s: 50 });
  assert(conv.convert_lock && !conv.exit, "intra converts to lock in last 60s (no flatten)");
  const red = redeemPnl(10, 0.25, true);
  assert(red.feeOut === 0 && almost(red.pnl, 10 * (1 - 0.25) - red.feeIn, 1e-6), "redeem $1 has one fee");
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
  const pred = dummyPred({ fire: false, side: "flat", gate_block: "prob" });
  const ent = shouldEnterIntra(pred, cheapDown);
  assert(!ent.ok && ent.reason === "no_fire", "shouldEnterIntra blocks on fire=false");

  const led = newPolyLedger(1_000_000_000);
  applyPolyStep(led, {
    now: 1_000_000_000,
    markets: [market()],
    books: { BTC: cheapDown },
    twaps: {},
    preds: { "BTC-USD": { intra: pred, slot: pred } },
  });
  assert(led.open.length === 0 && led.n === 0, "applyPolyStep opens nothing when fire=false");
  assert(led.n_skip_nofire >= 1, "silent predictor is counted as skip");
}

/* 5. Fire fee-aware : cheap Down ok ; bande 50 ¢ skippée. */
{
  const pred = dummyPred({
    fire: true,
    side: "down",
    p_up: 0.15,
    p_fair: 0.15,
    confidence: 0.85,
    edge_usdc: 2.0,
    label: "BAISSIER",
    gate_block: null,
    strat: "intra",
  });
  const ent = shouldEnterIntra(pred, cheapDown);
  assert(ent.ok && ent.side === "down" && ent.ask === 0.25, "stale cheap Down is taken at 25¢ ask");
  const midPred = dummyPred({
    fire: true,
    side: "up",
    p_up: 0.62,
    edge_usdc: 0.1,
    gate_block: null,
  });
  const mid = shouldEnterIntra(midPred, mid50);
  assert(!mid.ok && mid.reason === "midband", "fee-aware skip around 50¢ unless EV is huge");
  assert(inMidBand(0.5) && !inMidBand(0.25), "mid-band helper");
}

/* 6. Completed 1m bars — current minute excluded. */
{
  const now = 120_000;
  const bars = [0, 60_000, 120_000].map((t) => ({ t, o: 1, h: 1, l: 1, c: 1, v: 1 }));
  const done = completedKlines(bars, now);
  assert(done.length === 2 && done[1].t === 60_000, "drop incomplete current 1m bar");
}

/* 7. Calibration LightGBM — lecture seulement, pas le feu. */
{
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

/* 9. decideFair : skip 50 ¢ ; fire seulement si gap >> fee+pad. */
{
  const around50 = decideFair({
    remaining_s: 180,
    twap: 65020,
    strike: 65000,
    twap_stale: false,
    has_strike: true,
    strike_late: false,
    rv_1m: 0.001,
    up_ask: 0.5,
    up_bid: 0.49,
    down_ask: 0.5,
    down_bid: 0.49,
    min_gap: 0.12,
    min_ev_usdc: 0.5,
  });
  assert(!around50.fire, "no fire around 50¢ with small TWAP gap");
  assert(around50.gate_block === "midband" || around50.gate_block === "fee" || around50.gate_block === "prob", `50¢ gate ${around50.gate_block}`);

  const staleCheap = decideFair({
    remaining_s: 180,
    twap: 64000,
    strike: 65000,
    twap_stale: false,
    has_strike: true,
    strike_late: false,
    rv_1m: 0.0005,
    up_ask: 0.82,
    up_bid: 0.8,
    down_ask: 0.2,
    down_bid: 0.18,
    min_gap: 0.12,
    min_ev_usdc: 0.5,
  });
  assert(staleCheap.fire && staleCheap.side === "down", `huge dump vs 20¢ Down fires (got fire=${staleCheap.fire} side=${staleCheap.side} why=${staleCheap.why})`);

  const noTwap = decideFair({
    remaining_s: 180,
    twap: 65000,
    strike: 65000,
    twap_stale: true,
    has_strike: true,
    strike_late: false,
    rv_1m: 0.001,
    up_ask: 0.2,
    up_bid: 0.19,
    down_ask: 0.8,
    down_bid: 0.79,
  });
  assert(!noTwap.fire && noTwap.gate_block === "twap", "stale TWAP → no fire");
}

/* 10. Lock : redeem $1/$0 en fin de slot, pas flatten bid. */
{
  const now = 1_000_300_000;
  const led = newPolyLedger(now - 300_000);
  led.strikes["BTC:1000000"] = { twap: 65000, observed_ts: now - 300_000, window_s: 60, late: false };
  led.open.push({
    id: "lock-1",
    asset: "BTC",
    symbol: "BTC-USD",
    slug: "btc-updown-5m-1000000",
    slot_start_s: 1_000_000,
    strat: "lock",
    side: "up",
    shares: 10,
    entry_ask: 0.4,
    entry_ts: now - 50_000,
    entry_fee: cryptoTakerFeeUsdc(10, 0.4),
    token_id: "1",
  });
  const cashBefore = led.cash_usdc;
  applyPolyStep(led, {
    now,
    markets: [market({ remaining_s: 0 })],
    books: { BTC: cheapDown },
    twaps: {
      "btc/usd": { symbol: "btc/usd", value: 65100, observed_ts: now, published_ts: now, window_s: 60, stale: false },
    },
    preds: { "BTC-USD": { intra: dummyPred(), slot: dummyPred() } },
  });
  assert(led.open.length === 0, "lock position closed at resolution");
  assert(led.n_lock === 1, "counted as lock trade");
  assert(led.recent[0]?.exit_bid === 1, "redeem $1 (TWAP ≥ strike), not CLOB bid");
  assert(led.recent[0]?.exit_fee === 0, "no second taker fee on redeem");
  assert(led.cash_usdc > cashBefore, "cash received $1 * shares");
}

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log("\nall fanal tests passed");
