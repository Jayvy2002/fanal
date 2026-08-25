import type { PredictMarketContext, PredictResponse } from "../predictor/contract";
import { MIN_EV_USDC } from "../predictor/fairvalue";
import { getPolyTest, tradeAssetOk } from "../predictor/polytest";
import { predict } from "../predictor/score";
import { fetchPairBook } from "./clob";
import {
  CRYPTO_TAKER_RATE,
  FEE_FORMULA,
  cryptoTakerFeeUsdc,
  intraRoundTripPnl,
  lockBreakEvenP,
  redeemPnl,
} from "./fees";
import { shouldEnterIntra, shouldExitIntra } from "./intra";
import { projectLock } from "./lock";
import { discoverCurrent, type DiscoveredMarket } from "./markets";
import { loadLedger, saveLedger, storeKind } from "./store";
import {
  CLIP_USDC,
  LEDGER_V,
  MAX_RECENT,
  STARTING_CASH,
  type MarketView,
  type PolyLedger,
  type PolyPosition,
  type PolySnapshot,
  type PolyTrade,
  type StrikeRec,
} from "./types";
import { markStale, pollTwap, twapSymbolOf, type TwapMap, type TwapTick } from "./twap";

function twapWindowFromSrc(src: string): 30 | 60 {
  return /twap-30s|30s-streams/i.test(src) ? 30 : 60;
}

function emptyLedger(now: number): PolyLedger {
  return {
    v: LEDGER_V,
    started_ts: now,
    updated_ts: now,
    cash_usdc: STARTING_CASH,
    starting_cash_usdc: STARTING_CASH,
    realized_pnl_usdc: 0,
    fees_usdc: 0,
    n: 0,
    n_intra: 0,
    n_lock: 0,
    hits: 0,
    n_scratch: 0,
    n_skip_stale: 0,
    n_skip_nofire: 0,
    clip_usdc: CLIP_USDC,
    open: [],
    recent: [],
    strikes: {},
    last_twap: {},
  };
}

function isCurrentLedger(x: unknown): x is PolyLedger {
  return Boolean(x && typeof x === "object" && (x as PolyLedger).v === LEDGER_V);
}

function idOf(prefix: string, now: number): string {
  return `${prefix}-${now}-${Math.floor(Math.random() * 1e6)}`;
}

function strikeKey(asset: string, slotStart: number): string {
  return `${asset}:${slotStart}`;
}

function rvFromSlotHead(pred: PredictResponse): number {
  const r = pred.reasons.find((x) => x.key === "rv_5" || x.key === "rv_15");
  return r && Number.isFinite(r.value) ? Math.max(r.value, 1e-6) : 0.001;
}

function captureStrike(
  led: PolyLedger,
  market: DiscoveredMarket,
  tick: TwapTick | undefined,
  now: number,
): void {
  const key = strikeKey(market.asset, market.slot_start_s);
  if (led.strikes[key] || !tick || !(tick.value > 0)) return;
  const openMs = market.slot_start_s * 1000;
  const late = Math.abs(tick.observed_ts - openMs) > 20_000;
  /* On n’enregistre un strike « à l’open » que si l’obs est proche du début. */
  if (now / 1000 - market.slot_start_s > 25 && late) {
    led.strikes[key] = { twap: tick.value, observed_ts: tick.observed_ts, window_s: tick.window_s, late: true };
    return;
  }
  led.strikes[key] = { twap: tick.value, observed_ts: tick.observed_ts, window_s: tick.window_s, late };
}

function maybePromoteLastTwap(led: PolyLedger, market: DiscoveredMarket): void {
  const key = strikeKey(market.asset, market.slot_start_s);
  if (led.strikes[key]) return;
  const prev = led.last_twap[twapSymbolOf(market.asset)];
  if (!prev || !(prev.value > 0)) return;
  const openMs = market.slot_start_s * 1000;
  if (Math.abs(prev.observed_ts - openMs) <= 20_000) {
    led.strikes[key] = {
      twap: prev.value,
      observed_ts: prev.observed_ts,
      window_s: prev.window_s,
      late: false,
    };
  }
}

function sharesFor(ask: number, clip: number): number {
  if (!(ask > 0)) return 0;
  return clip / ask;
}

function markUnrealized(open: PolyPosition[], views: MarketView[]): number {
  let u = 0;
  for (const pos of open) {
    const v = views.find((x) => x.market.asset === pos.asset);
    if (!v) continue;
    if (pos.strat === "lock") {
      const pSide =
        v.p_lock_up == null ? null : pos.side === "up" ? v.p_lock_up : 1 - v.p_lock_up;
      if (pSide != null) {
        u += pos.shares * pSide - pos.shares * pos.entry_ask - pos.entry_fee;
        continue;
      }
    }
    const side = pos.side === "up" ? v.book.up : v.book.down;
    const bid = side.bid;
    if (!(bid > 0)) continue;
    const { pnl } = intraRoundTripPnl(pos.shares, pos.entry_ask, bid);
    u += pnl;
  }
  return u;
}

function pushTrade(
  led: PolyLedger,
  pos: PolyPosition,
  now: number,
  exitBid: number,
  entryFee: number,
  exitFee: number,
  pnl: number,
  hit: boolean,
  scratch: boolean,
  reason: string,
): void {
  led.n += 1;
  if (pos.strat === "intra") led.n_intra += 1;
  else led.n_lock += 1;
  if (hit) led.hits += 1;
  if (scratch) led.n_scratch += 1;
  led.realized_pnl_usdc += pnl;
  const row: PolyTrade = {
    id: pos.id,
    ts: now,
    asset: pos.asset,
    slug: pos.slug,
    strat: pos.strat,
    side: pos.side,
    shares: pos.shares,
    entry_ask: pos.entry_ask,
    exit_bid: exitBid,
    entry_fee: entryFee,
    exit_fee: exitFee,
    pnl,
    hit,
    scratch,
    reason,
  };
  led.recent.unshift(row);
  if (led.recent.length > MAX_RECENT) led.recent.pop();
}

function closePos(
  led: PolyLedger,
  pos: PolyPosition,
  exitBid: number,
  now: number,
  reason: string,
  scratch: boolean,
): void {
  const { pnl, feeIn, feeOut } = intraRoundTripPnl(pos.shares, pos.entry_ask, exitBid);
  const proceeds = pos.shares * exitBid - feeOut;
  led.cash_usdc += proceeds;
  /* feeIn déjà compté à l’ouverture */
  led.fees_usdc += feeOut;
  pushTrade(led, pos, now, exitBid, feeIn, feeOut, pnl, exitBid > pos.entry_ask, scratch, reason);
}

function closeRedeem(led: PolyLedger, pos: PolyPosition, win: boolean, now: number, reason: string): void {
  const { pnl, feeIn, feeOut, exit } = redeemPnl(pos.shares, pos.entry_ask, win);
  led.cash_usdc += pos.shares * exit;
  pushTrade(led, pos, now, exit, feeIn, feeOut, pnl, win, false, reason);
}

function tryRedeem(led: PolyLedger, pos: PolyPosition, now: number): boolean {
  if (now / 1000 < pos.slot_start_s + 300) return false;
  const strike = led.strikes[strikeKey(pos.asset, pos.slot_start_s)];
  const tick = led.last_twap[twapSymbolOf(pos.asset)];
  if (!strike || !(strike.twap > 0) || !tick || !(tick.value > 0)) return false;
  const outcome: "up" | "down" = tick.value >= strike.twap ? "up" : "down";
  closeRedeem(led, pos, pos.side === outcome, now, "slot_redeem_1_0");
  return true;
}

function noteSkip(led: PolyLedger, key: string): boolean {
  led.noted_skips = led.noted_skips ?? {};
  if (led.noted_skips[key]) return false;
  led.noted_skips[key] = true;
  return true;
}

function hasOpen(led: PolyLedger, asset: string, slot: number): boolean {
  return led.open.some((p) => p.asset === asset && p.slot_start_s === slot);
}

export function applyPolyStep(
  led: PolyLedger,
  input: {
    now: number;
    markets: DiscoveredMarket[];
    books: Record<string, Awaited<ReturnType<typeof fetchPairBook>>>;
    twaps: TwapMap;
    preds: Record<string, { intra: PredictResponse; slot: PredictResponse }>;
  },
): MarketView[] {
  const views: MarketView[] = [];
  const now = input.now;

  for (const [sym, tick] of Object.entries(input.twaps)) {
    if (tick) led.last_twap[sym as keyof TwapMap] = tick;
  }

  /* Sorties d’abord — lock / intra en fin de slot : redeem $1/$0, jamais flatten CLOB. */
  const still: PolyPosition[] = [];
  for (const pos of led.open) {
    const mkt = input.markets.find((m) => m.asset === pos.asset && m.slot_start_s === pos.slot_start_s);
    const book = input.books[pos.asset];
    const remaining = mkt
      ? mkt.remaining_s
      : pos.slot_start_s + 300 - now / 1000;
    if (remaining <= 0 || !mkt) {
      if (!tryRedeem(led, pos, now)) still.push(pos);
      continue;
    }
    if (!book) {
      still.push(pos);
      continue;
    }
    const sideBook = pos.side === "up" ? book.up : book.down;
    const bid = sideBook.bid;
    const mid = sideBook.mid;
    if (pos.strat === "intra") {
      const pWin = pWinOf(led, pos, remaining);
      const dec = shouldExitIntra({
        entryAsk: pos.entry_ask,
        mid,
        shares: pos.shares,
        held_s: (now - pos.entry_ts) / 1000,
        remaining_slot_s: remaining,
        pWin,
        bid,
      });
      if (dec.convert_lock) {
        pos.strat = "lock";
        still.push(pos);
        continue;
      }
      if (dec.exit && bid > 0) {
        closePos(led, pos, bid, now, dec.reason, dec.scratch);
        continue;
      }
    }
    still.push(pos);
  }
  led.open = still;

  for (const mkt of input.markets) {
    const book = input.books[mkt.asset];
    const pred = input.preds[mkt.symbol];
    const tick = input.twaps[twapSymbolOf(mkt.asset)];
    maybePromoteLastTwap(led, mkt);
    if (tick) captureStrike(led, mkt, tick, now);
    const strike = led.strikes[strikeKey(mkt.asset, mkt.slot_start_s)] ?? null;
    const intra = pred?.intra;
    const slot = pred?.slot;
    let pLockUp: number | null = null;
    let lockSkip: string | null = null;
    if (tick) {
      const proj = projectLock({
        twap: tick.value,
        strike: strike?.twap ?? 0,
        remaining_s: mkt.remaining_s,
        rv_1m: slot ? rvFromSlotHead(slot) : 0.001,
        twap_stale: tick.stale,
        has_strike: Boolean(strike && !strike.late),
        strike_late: Boolean(strike?.late),
      });
      pLockUp = proj.p_up;
      lockSkip = proj.skip ? proj.skip_reason : null;
      if (proj.skip && proj.skip_reason === "twap_stale" && mkt.remaining_s <= 60) {
        if (noteSkip(led, `stale:${mkt.asset}:${mkt.slot_start_s}`)) led.n_skip_stale += 1;
      }
    } else {
      lockSkip = "twap_missing";
    }

    if (book && intra && slot) {
      const pred = mkt.remaining_s > 60 ? intra : slot;
      tryEnter(led, mkt, book, pred, mkt.remaining_s, now);
    } else if (intra && !intra.fire) {
      if (noteSkip(led, `nofire:${mkt.asset}:${mkt.slot_start_s}`)) led.n_skip_nofire += 1;
    }

    views.push({
      market: mkt,
      book: book ?? { up: emptySide(), down: emptySide() },
      twap: tick ?? null,
      strike,
      p_lock_up: pLockUp,
      lock_skip: lockSkip,
      predict_intra: intra ?? silent(mkt.symbol, 60, now),
      predict_slot: slot ?? silent(mkt.symbol, 300, now),
    });
  }

  led.updated_ts = now;
  return views;
}

function emptySide() {
  return { bid: 0, ask: 0, mid: 0, spread: 0, bids: [], asks: [] };
}

function silent(symbol: PredictResponse["symbol"], horizon: number, now: number): PredictResponse {
  return {
    ts: now,
    symbol,
    horizon_s: horizon,
    p_up: 0.5,
    expected_move_bps: 0,
    confidence: 0.5,
    fire: false,
    side: "flat",
    reasons: [],
    label: "NEUTRE",
    close: 0,
    bar_ts: null,
    tau: 0.58,
    min_edge_bps: 4,
    min_edge_usdc: MIN_EV_USDC,
    edge_usdc: 0,
    fee_usdc: 0,
    p_fair: 0.5,
    p_clob: null,
    strat: null,
    lock_hurdle_90c: lockBreakEvenP(0.9),
    gate_block: "warmup",
    venue: "coinbase",
    bar_s: 60,
    kind: "fairvalue",
    test: getPolyTest(symbol),
    error: null,
  };
}

function pWinOf(led: PolyLedger, pos: PolyPosition, remaining: number): number | null {
  const tick = led.last_twap[twapSymbolOf(pos.asset)];
  const strike = led.strikes[strikeKey(pos.asset, pos.slot_start_s)];
  if (!tick || !strike || strike.late) return null;
  const proj = projectLock({
    twap: tick.value,
    strike: strike.twap,
    remaining_s: remaining,
    rv_1m: 0.001,
    twap_stale: tick.stale,
    has_strike: true,
    strike_late: false,
  });
  if (proj.skip) return null;
  return pos.side === "up" ? proj.p_up : proj.p_down;
}

function tryEnter(
  led: PolyLedger,
  mkt: DiscoveredMarket,
  book: Awaited<ReturnType<typeof fetchPairBook>>,
  pred: PredictResponse,
  remaining: number,
  now: number,
): void {
  if (hasOpen(led, mkt.asset, mkt.slot_start_s)) return;
  if (!tradeAssetOk(mkt.asset)) return;
  if (led.cash_usdc < 5) return;
  if (remaining < 8) return;
  const ent = shouldEnterIntra(pred, book);
  if (!ent.ok) {
    if (ent.reason === "no_fire" && noteSkip(led, `nofire:${mkt.asset}:${mkt.slot_start_s}`)) {
      led.n_skip_nofire += 1;
    }
    return;
  }
  const strat = remaining > 60 ? "intra" : "lock";
  openTake(led, mkt, ent.side!, ent.ask, strat, now, book);
}

function openTake(
  led: PolyLedger,
  mkt: DiscoveredMarket,
  side: "up" | "down",
  ask: number,
  strat: "intra" | "lock",
  now: number,
  book: Awaited<ReturnType<typeof fetchPairBook>>,
): void {
  const shares = sharesFor(ask, led.clip_usdc);
  if (!(shares > 0)) return;
  const fee = cryptoTakerFeeUsdc(shares, ask);
  const cost = shares * ask + fee;
  if (cost > led.cash_usdc) return;
  led.cash_usdc -= cost;
  led.fees_usdc += fee;
  const token = side === "up" ? mkt.up_token : mkt.down_token;
  led.open.push({
    id: idOf(strat, now),
    asset: mkt.asset,
    symbol: mkt.symbol,
    slug: mkt.slug,
    slot_start_s: mkt.slot_start_s,
    strat,
    side,
    shares,
    entry_ask: ask,
    entry_ts: now,
    entry_fee: fee,
    token_id: token,
  });
  void book;
}

export function snapshotOf(led: PolyLedger, views: MarketView[], store: "blobs" | "file"): PolySnapshot {
  const unreal = markUnrealized(led.open, views);
  return {
    v: LEDGER_V,
    cash_usdc: led.cash_usdc,
    starting_cash_usdc: led.starting_cash_usdc,
    equity_usdc: led.cash_usdc + unreal,
    realized_pnl_usdc: led.realized_pnl_usdc,
    unrealized_usdc: unreal,
    fees_usdc: led.fees_usdc,
    n: led.n,
    n_intra: led.n_intra,
    n_lock: led.n_lock,
    hits: led.hits,
    hit_rate: led.n > 0 ? led.hits / led.n : null,
    n_scratch: led.n_scratch,
    n_skip_stale: led.n_skip_stale,
    n_skip_nofire: led.n_skip_nofire,
    clip_usdc: led.clip_usdc,
    open: led.open,
    recent: led.recent,
    markets: views,
    store,
    persisted: store === "blobs" || true,
    started_ts: led.started_ts,
    updated_ts: led.updated_ts,
    live_orders: false,
    honest: honestBlurb(),
    fee_formula: FEE_FORMULA,
    lock_90c_math: `À 90 ¢, fee/share = ${CRYPTO_TAKER_RATE}×0,90×0,10 = 0,0063 USDC. Break-even P = ${lockBreakEvenP(0.9).toFixed(4)} ≈ 91 %.`,
  };
}

function honestBlurb(): string {
  return (
    "Paper seulement — aucun ordre CLOB, aucune clé, aucun retrait. " +
    "Scoreboard = USDC après frais taker officiels (deux jambes si scalp, une si redeem). " +
    "Feu = |P(TWAP) − p_CLOB| > fee(p) + pad, hors bande 40–60 ¢. " +
    "Lock porté jusqu’à $1/$0 (pas de flatten bid). TWAP stale → skip, jamais un mid Coinbase."
  );
}

function contextOf(
  mkt: DiscoveredMarket,
  book: Awaited<ReturnType<typeof fetchPairBook>> | null | undefined,
  tick: TwapTick | undefined,
  strike: StrikeRec | undefined,
): PredictMarketContext {
  return {
    remaining_s: mkt.remaining_s,
    twap: tick?.value ?? null,
    twap_stale: tick ? tick.stale : true,
    strike: strike?.twap ?? null,
    strike_late: Boolean(strike?.late),
    has_strike: Boolean(strike && !strike.late && strike.twap > 0),
    up_ask: book?.up.ask ?? 0,
    up_bid: book?.up.bid ?? 0,
    down_ask: book?.down.ask ?? 0,
    down_bid: book?.down.bid ?? 0,
  };
}

export async function stepPolyPaper(): Promise<PolySnapshot> {
  const now = Date.now();
  const loaded = await loadLedger();
  const led = isCurrentLedger(loaded.ledger) ? loaded.ledger : emptyLedger(now);
  const markets = await discoverCurrent(now);
  const windowS = markets[0] ? twapWindowFromSrc(markets[0].resolution_source) : 60;
  const [twapsRaw, booksPairs] = await Promise.all([
    pollTwap({ windowS, now }),
    Promise.all(
      markets.map(async (m) => {
        try {
          return [m.asset, await fetchPairBook(m.up_token, m.down_token)] as const;
        } catch {
          return [m.asset, null] as const;
        }
      }),
    ),
  ]);
  const books: Record<string, NonNullable<(typeof booksPairs)[number][1]>> = {};
  for (const [asset, book] of booksPairs) {
    if (book) books[asset] = book;
  }
  const twaps: TwapMap = {};
  for (const [k, v] of Object.entries(twapsRaw)) {
    if (v) twaps[k as keyof TwapMap] = markStale(v, now);
  }
  for (const [sym, tick] of Object.entries(twaps)) {
    if (tick) led.last_twap[sym as keyof TwapMap] = tick;
  }
  for (const mkt of markets) {
    maybePromoteLastTwap(led, mkt);
    const tick = twaps[twapSymbolOf(mkt.asset)];
    if (tick) captureStrike(led, mkt, tick, now);
  }
  const predMap: Record<string, { intra: PredictResponse; slot: PredictResponse }> = {};
  await Promise.all(
    markets.map(async (mkt) => {
      const ctx = contextOf(
        mkt,
        books[mkt.asset],
        twaps[twapSymbolOf(mkt.asset)],
        led.strikes[strikeKey(mkt.asset, mkt.slot_start_s)],
      );
      const intra = await predict({ symbol: mkt.symbol, horizon_s: 60, now, context: ctx });
      const slot = await predict({ symbol: mkt.symbol, horizon_s: 300, now, context: ctx });
      predMap[mkt.symbol] = { intra, slot };
    }),
  );
  const views = applyPolyStep(led, { now, markets, books, twaps, preds: predMap });
  await saveLedger(led, loaded.etag);
  const kind = await storeKind();
  return snapshotOf(led, views, kind);
}

export async function snapshotPolyPaper(): Promise<PolySnapshot> {
  const now = Date.now();
  const loaded = await loadLedger();
  const led = isCurrentLedger(loaded.ledger) ? loaded.ledger : emptyLedger(now);
  const kind = await storeKind();
  return snapshotOf(led, [], kind);
}

export function newPolyLedger(now = Date.now()): PolyLedger {
  return emptyLedger(now);
}

function twapWindowFromMarket(m: DiscoveredMarket): 30 | 60 {
  return twapWindowFromSrc(m.resolution_source);
}

export { twapWindowFromMarket };
