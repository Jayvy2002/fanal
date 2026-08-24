/**
 * Logic tests for the applied trading/prediction pipeline.
 * Run: node --experimental-strip-types --no-warnings netlify/functions/lib/pipeline.test.ts
 */
import { completedKlines } from "./bars";
import { expectedAbsMoveBps, type Calib } from "./forecasts";
import { applyPaperStep, makerFill, newLedger, type MarketPx } from "./paper";
import { CLIP_USD, HORIZON_MS, TAKER_FEE_BPS } from "./paperFees";
import type { Signal } from "./types";
import { adaptLiveFeatures, BINANCE_VS_COINBASE_VOL_RATIO, LOG_VOL_OFFSET } from "./venue";

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

function sig(over: Partial<Signal> = {}): Signal {
  return {
    side: "up",
    label: "HAUSSIER",
    p_up: 0.7,
    confidence: 0.7,
    gated: true,
    horizon_s: 5,
    why: "test",
    close: 100,
    tau: 0.58,
    expected_move_bps: 1.2,
    target_px: 100.012,
    min_move_bps: 1,
    gate_block: null,
    ...over,
  };
}

const T0 = 1_700_000_000_000;

function mkt(over: Partial<MarketPx> = {}): MarketPx {
  return {
    now: T0,
    exch_now: T0,
    mid: 100,
    bid: 99.9,
    ask: 100.1,
    last: 100,
    low: 99.9,
    high: 100.1,
    bars: [],
    ...over,
  };
}

/* 1. Completed bars — current 1s bucket excluded. */
{
  const now = 5_000;
  const bars = [3000, 4000, 5000].map((t) => ({
    t, o: 1, h: 1, l: 1, c: 1, v: 1, n: 1, tb: 0.5,
  }));
  const done = completedKlines(bars, now);
  assert(done.length === 2 && done[0].t === 3000 && done[1].t === 4000, "drop incomplete current 1s bar");
}

/* 2. expected_abs_move matches train 0.40/0.35/0.25 when abs_* present. */
{
  const conf = 0.08;
  const p = 0.5 + conf;
  const vol = 1.0;
  const rv = vol / (Math.sqrt(5) * 1e4);
  const calib: Calib = {
    abs_intercept: 0.475,
    abs_beta_conf: -0.734,
    abs_beta_vol: 0.554,
    mean_abs_bps: 1.67,
    abs_bins: [],
  };
  const lin = Math.max(0.475 + -0.734 * conf + 0.554 * vol, 0.05);
  const typical = Math.max(1.67, 0.5) * (0.45 + 0.55 * Math.min(1, conf / 0.5));
  const binE = 1.67;
  const expect = Math.max(0.05, Math.min(25, 0.4 * lin + 0.35 * binE + 0.25 * typical));
  const got = expectedAbsMoveBps(p, calib, { rv_5: rv, rv_60: rv });
  assert(almost(got, expect, 1e-9), `abs-move formula train=live (${got} vs ${expect})`);
}

/* 3. Gate cannot fire when blended |move| < 1bp (no TEST-gated mean substitution). */
{
  const calib: Calib = {
    abs_intercept: 0.2,
    abs_beta_conf: 0,
    abs_beta_vol: 0.1,
    mean_abs_bps: 0.4,
    abs_bins: [],
  };
  const e = expectedAbsMoveBps(0.58, calib, { rv_5: 0, rv_60: 0 });
  assert(e < 1, `1bp gate stays shut on tiny expected move (e=${e})`);
}

/* 4. Maker fill requires trade-through, not touch / last / mid. */
{
  const book = mkt({
    bid: 100,
    ask: 100.2,
    mid: 100.1,
    last: 100,
    bars: [{ t: 11_000, h: 100.2, l: 100 }],
  });
  assert(!makerFill("buy", 100, book, 10_000), "touch of bid does not fill maker buy");
  const through = mkt({
    bid: 100,
    ask: 100.2,
    bars: [{ t: 11_000, h: 100.2, l: 99.99 }],
  });
  assert(makerFill("buy", 100, through, 10_000), "trade-through below bid fills maker buy");
  const leak = mkt({
    bars: [{ t: 1_000, h: 101, l: 90 }],
  });
  assert(!makerFill("buy", 100, leak, 10_000), "bar that started before the order is not lookahead");
}

/* 5. Taker round-trip on a flat market loses fees (and spread) — not mid fills. */
{
  const led = newLedger(0);
  const entry = mkt({ now: T0, exch_now: T0 });
  applyPaperStep(led, entry, sig());
  assert(led.open != null && led.open.entry_px === 100.1, "taker long fills at ask, not mid");
  applyPaperStep(
    led,
    mkt({ now: T0 + HORIZON_MS + 1, exch_now: T0 + HORIZON_MS + 1 }),
    sig({ gated: false, side: "flat", label: "NEUTRE" }),
  );
  assert(led.open == null && led.n === 1, "flatten at 5s, one closed trade");
  const t = led.recent[0];
  assert(t.exit_px === 99.9, "taker exit at bid, not mid");
  const fees = t.entry_fee_usd + t.exit_fee_usd;
  const expectFee = (CLIP_USD * TAKER_FEE_BPS) / 1e4 + (99.9 * (CLIP_USD / 100.1) * TAKER_FEE_BPS) / 1e4;
  assert(almost(fees, expectFee, 1e-6), "both legs charged taker fee, no double-count in fee fields");
  assert(t.pnl_usd < 0, "flat-to-down spread+fees is a loss (not hidden)");
  assert(t.hit === false, "hit is direction without fees");
}

/* 6. Same snapshot cannot flatten and open another position. */
{
  const led = newLedger(0);
  applyPaperStep(led, mkt({ now: T0 }), sig());
  applyPaperStep(
    led,
    mkt({ now: T0 + HORIZON_MS + 1 }),
    sig({ expected_move_bps: 2 }),
  );
  assert(led.open == null && led.pending == null, "no re-entry on the flatten snapshot");
  assert(led.n === 1, "still a single closed round-trip");
}

/* 7. 15s signal never opens the 5s paper book. */
{
  const led = newLedger(0);
  applyPaperStep(led, mkt({ now: T0 + 2_000 }), sig({ horizon_s: 15, expected_move_bps: 3 }));
  assert(led.open == null && led.pending == null && led.n === 0, "15s path is not the paper horizon");
}

/* 8. |move| < 1bp does not enter even if gated flag were stale. */
{
  const led = newLedger(0);
  applyPaperStep(led, mkt({ now: T0 + 3_000 }), sig({ expected_move_bps: 0.4, gated: true }));
  assert(led.open == null, "paper min 1bp matches live gate");
}

/* 9. Venue adapter only rescales log_vol / cvd for Binance trees. */
{
  const raw = { ret_1: 0.001, tbr: 0.6, log_vol: -2, cvd_5: 0.05, cvd_15: 0.1, cvd_30: 0.2 };
  const binance = adaptLiveFeatures(raw, "binance_vision_btcusdt_1s");
  const coinbase = adaptLiveFeatures(raw, "coinbase_exchange_btc_usd_trades_1s");
  assert(binance.ret_1 === raw.ret_1 && binance.tbr === raw.tbr, "scale-free features untouched");
  assert(almost(binance.log_vol, raw.log_vol + LOG_VOL_OFFSET), "log_vol shifted toward Binance volume");
  assert(almost(binance.cvd_5, raw.cvd_5 * BINANCE_VS_COINBASE_VOL_RATIO), "cvd scaled");
  assert(coinbase.log_vol === raw.log_vol, "Coinbase-trained trees get raw Coinbase vectors");
}

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log("\nall pipeline logic tests passed");
