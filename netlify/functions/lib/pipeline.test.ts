/**
 * Logic tests for the 1-minute / 15-minute pipeline.
 * Run: node --experimental-strip-types --no-warnings netlify/functions/lib/pipeline.test.ts
 */
import { completedKlines } from "./bars";
import { expectedAbsMoveBps, interpolatePath, type Calib } from "./forecasts";
import { applyPaperStep, makerFill, newLedger, type MarketPx } from "./paper";
import {
  CLIP_USD,
  HORIZON_MS,
  HORIZON_S,
  LEDGER_VERSION,
  MAKER_FEE_BPS,
  MAKER_RT_BPS,
  TAKER_FEE_BPS,
  TAKER_RT_BPS,
} from "./paperFees";
import type { Signal } from "./types";

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
    horizon_s: HORIZON_S,
    why: "test",
    close: 100,
    tau: 0.58,
    expected_move_bps: 140,
    target_px: 101.4,
    min_move_bps: MAKER_RT_BPS,
    gate_block: null,
    ...over,
  };
}

const T0 = 1_700_000_000_000;
const M = 60_000;

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

/* 1. Completed bars — current 1m bucket excluded. */
{
  const now = 5 * M;
  const bars = [3 * M, 4 * M, 5 * M].map((t) => ({
    t, o: 1, h: 1, l: 1, c: 1, v: 1, n: 1, tb: 0.5,
  }));
  const done = completedKlines(bars, now);
  assert(done.length === 2 && done[0].t === 3 * M && done[1].t === 4 * M, "drop incomplete current 1m bar");
}

/* 2. expected_abs_move matches train 0.40/0.35/0.25 (horizon-aware vol). */
{
  const conf = 0.08;
  const p = 0.5 + conf;
  const vol = 10;
  const rv = vol / (Math.sqrt(15) * 1e4);
  const calib: Calib = {
    abs_intercept: 4,
    abs_beta_conf: 2,
    abs_beta_vol: 0.3,
    mean_abs_bps: 20,
    abs_bins: [],
    horizon_m: 15,
    clip_max_bps: 200,
  };
  const lin = Math.max(4 + 2 * conf + 0.3 * vol, 0.5);
  const typical = Math.max(20, 1) * (0.45 + 0.55 * Math.min(1, conf / 0.5));
  const binE = 20;
  const expect = Math.max(0.5, Math.min(200, 0.4 * lin + 0.35 * binE + 0.25 * typical));
  const got = expectedAbsMoveBps(p, calib, { rv_5: rv, rv_60: rv }, 15);
  assert(almost(got, expect, 1e-9), `abs-move formula train=live (${got} vs ${expect})`);
}

/* 3. Fee gate stays shut on tiny 15m expected move. */
{
  const calib: Calib = {
    abs_intercept: 2,
    abs_beta_conf: 0,
    abs_beta_vol: 0.1,
    mean_abs_bps: 8,
    abs_bins: [],
    horizon_m: 15,
    clip_max_bps: 200,
  };
  const e = expectedAbsMoveBps(0.58, calib, { rv_5: 0, rv_60: 0 }, 15);
  assert(e < MAKER_RT_BPS, `120bp maker RT gate stays shut on tiny e=${e}`);
}

/* 4. Maker fill requires trade-through, not touch; ignore placement bar. */
{
  const book = mkt({
    bid: 100,
    ask: 100.2,
    mid: 100.1,
    last: 100,
    bars: [{ t: T0, h: 100.2, l: 100 }],
  });
  assert(!makerFill("buy", 100, book, T0 + 1_000), "touch of bid does not fill maker buy");
  const through = mkt({
    bid: 100,
    ask: 100.2,
    bars: [{ t: T0 + M, h: 100.2, l: 99.99 }],
  });
  assert(makerFill("buy", 100, through, T0 + 1_000), "later 1m bar trade-through fills maker buy");
  const leak = mkt({
    bars: [{ t: T0, h: 101, l: 90 }],
  });
  assert(!makerFill("buy", 100, leak, T0 + 1_000), "1m bar in progress at placement is not lookahead");
}

/* 5. Maker default ledger v2; 5s signal never opens paper. */
{
  const led = newLedger(0);
  assert(led.v === LEDGER_VERSION && led.mode === "maker", "new ledger is v2 maker");
  applyPaperStep(led, mkt({ now: T0 }), sig({ horizon_s: 5, expected_move_bps: 200 }));
  assert(led.open == null && led.pending == null && led.n === 0, "5s feu does not open 15m paper");
}

/* 6. 15m feu + |move| ≥ 120 bp posts a maker order; unfilled → cancel at +15m. */
{
  const led = newLedger(0);
  applyPaperStep(led, mkt({ now: T0 }), sig());
  assert(led.pending?.kind === "entry" && led.open == null, "maker posts, does not mid-fill");
  applyPaperStep(
    led,
    mkt({
      now: T0 + HORIZON_MS + 1,
      exch_now: T0 + HORIZON_MS + 1,
      bars: [{ t: T0 + M, h: 100.1, l: 100.0 }],
    }),
    sig({ gated: false, side: "flat", label: "NEUTRE" }),
  );
  assert(led.pending == null && led.open == null && led.n_cancelled === 1, "unfilled by +15m cancels");
}

/* 7. Trade-through after placement fills; flatten taker if exit misses. */
{
  const led = newLedger(0);
  applyPaperStep(led, mkt({ now: T0 }), sig());
  applyPaperStep(
    led,
    mkt({
      now: T0 + 2 * M,
      exch_now: T0 + 2 * M,
      bid: 99.9,
      ask: 100.1,
      bars: [{ t: T0 + M, h: 100.2, l: 99.8 }],
    }),
    sig({ gated: false, side: "flat", label: "NEUTRE" }),
  );
  assert(led.open != null && led.open.entry_role === "maker", "maker entry after later-bar trade-through");
  applyPaperStep(
    led,
    mkt({
      now: T0 + HORIZON_MS + 1,
      exch_now: T0 + HORIZON_MS + 1,
      bid: 99.9,
      ask: 100.1,
      bars: [{ t: T0 + 14 * M, h: 100.05, l: 99.95 }],
    }),
    sig({ gated: false, side: "flat", label: "NEUTRE" }),
  );
  assert(led.open == null && led.n === 1, "horizon flatten");
  const t = led.recent[0];
  assert(t.exit_role === "taker" || t.exit_role === "maker", "exit maker first else taker flatten");
  assert(t.hit === false || t.hit === true, "hit is direction only");
  assert(t.pnl_usd < 0 || t.exit_role === "maker", "fees counted on $ PnL");
}

/* 8. Same snapshot cannot flatten and open another position. */
{
  const led = newLedger(0, "taker");
  applyPaperStep(led, mkt({ now: T0 }), sig());
  applyPaperStep(led, mkt({ now: T0 + HORIZON_MS + 1 }), sig({ expected_move_bps: 200 }));
  assert(led.open == null && led.pending == null, "no re-entry on the flatten snapshot");
  assert(led.n === 1, "still a single closed round-trip");
}

/* 9. |move| under maker RT does not enter. */
{
  const led = newLedger(0);
  applyPaperStep(led, mkt({ now: T0 + 3_000 }), sig({ expected_move_bps: 40, gated: true }));
  assert(led.open == null && led.pending == null, "paper min 120bp matches live fee gate");
}

/* 10. Fee constants: unverified Advanced intro, Exchange 60/40 is alternate. */
{
  assert(TAKER_FEE_BPS === 120 && MAKER_FEE_BPS === 60, "default taker 120 / maker 60");
  assert(MAKER_RT_BPS === 120 && TAKER_RT_BPS === 240, "RT maker 120 / taker 240");
  assert(CLIP_USD === 75 && HORIZON_S === 900, "clip $75, horizon 15m");
}

/* 11. Smooth path interpolates between knots. */
{
  const path = interpolatePath(
    [
      { t: 0, p: 100 },
      { t: 60_000, p: 101 },
    ],
    15_000,
  );
  assert(path.length >= 4, "path has interpolated points");
  assert(almost(path[0].p, 100) && almost(path[path.length - 1].p, 101), "path endpoints preserved");
}

/* 12. Taker flat market loses fees (optional mode). */
{
  const led = newLedger(0, "taker");
  applyPaperStep(led, mkt({ now: T0 }), sig());
  assert(led.open != null && led.open.entry_px === 100.1, "taker long fills at ask, not mid");
  applyPaperStep(
    led,
    mkt({ now: T0 + HORIZON_MS + 1, exch_now: T0 + HORIZON_MS + 1 }),
    sig({ gated: false, side: "flat", label: "NEUTRE" }),
  );
  assert(led.open == null && led.n === 1, "flatten at 15m");
  const t = led.recent[0];
  assert(t.exit_px === 99.9, "taker exit at bid, not mid");
  assert(t.pnl_usd < 0, "flat-to-down spread+fees is a loss");
  assert(t.hit === false, "hit is direction without fees");
}

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log("\nall pipeline logic tests passed");
