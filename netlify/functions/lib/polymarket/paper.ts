import type { PredictResponse } from "../predictor/contract";
import { predict } from "../predictor/score";
import { fetchPairBook } from "./clob";
import {
  CRYPTO_TAKER_RATE,
  FEE_FORMULA,
  cryptoTakerFeeUsdc,
  intraRoundTripPnl,
  lockBreakEvenP,
  lockEdgeUsdc,
} from "./fees";
import { shouldEnterIntra, shouldExitIntra } from "./intra";
import { expensiveAskOk, projectLock } from "./lock";
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
    const side = pos.side === "up" ? v.book.up : v.book.down;
    const bid = side.bid;
    if (!(bid > 0)) continue;
    const { pnl } = intraRoundTripPnl(pos.shares, pos.entry_ask, bid);
    u += pnl;
  }
  return u;
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
  led.fees_usdc += feeIn + feeOut;
  led.realized_pnl_usdc += pnl;
  led.n += 1;
  if (pos.strat === "intra") led.n_intra += 1;
  else led.n_lock += 1;
  const hit = exitBid > pos.entry_ask;
  if (hit) led.hits += 1;
  if (scratch) led.n_scratch += 1;
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
    entry_fee: feeIn,
    exit_fee: feeOut,
    pnl,
    hit,
    scratch,
    reason,
  };
  led.recent.unshift(row);
  if (led.recent.length > MAX_RECENT) led.recent.pop();
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

  /* Sorties d’abord. */
  const still: PolyPosition[] = [];
  for (const pos of led.open) {
    const mkt = input.markets.find((m) => m.asset === pos.asset);
    const book = input.books[pos.asset];
    if (!mkt || !book) {
      still.push(pos);
      continue;
    }
    const sideBook = pos.side === "up" ? book.up : book.down;
    const bid = sideBook.bid;
    const mid = sideBook.mid;
    const remaining = mkt.remaining_s;
    if (pos.strat === "intra") {
      const dec = shouldExitIntra({
        entryAsk: pos.entry_ask,
        mid,
        shares: pos.shares,
        held_s: (now - pos.entry_ts) / 1000,
        remaining_slot_s: remaining,
      });
      if (dec.exit && bid > 0) {
        closePos(led, pos, bid, now, dec.reason, dec.scratch);
        continue;
      }
    } else {
      /* Lock : on porte jusqu’à la résolution / fin de slot (flatten au bid si le slot est clos). */
      if (remaining <= 0 && bid > 0) {
        closePos(led, pos, bid, now, "slot_resolved_mark", false);
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

    if (book && intra) {
      tryEnter(led, mkt, book, intra, {
        remaining: mkt.remaining_s,
        pLockUp,
        lockSkip,
        now,
      });
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
    gate_block: "warmup",
    venue: "coinbase",
    bar_s: 60,
    kind: "lgbm",
    test: { gated_acc: null, n: 0, coverage: 0, naive_last_acc: 0.5, mean_abs_move_bps: null, expectancy_1bp: null, expectancy_2bp: null },
    error: null,
  };
}

function tryEnter(
  led: PolyLedger,
  mkt: DiscoveredMarket,
  book: Awaited<ReturnType<typeof fetchPairBook>>,
  intra: PredictResponse,
  ctx: { remaining: number; pLockUp: number | null; lockSkip: string | null; now: number },
): void {
  if (hasOpen(led, mkt.asset, mkt.slot_start_s)) return;
  if (led.cash_usdc < 5) return;

  /* Intra : exige fire. */
  if (ctx.remaining > 60) {
    const ent = shouldEnterIntra(intra, book);
    if (!ent.ok) {
      if (ent.reason === "no_fire" && noteSkip(led, `nofire:${mkt.asset}:${mkt.slot_start_s}`)) {
        led.n_skip_nofire += 1;
      }
      return;
    }
    openTake(led, mkt, ent.side!, ent.ask, "intra", ctx.now, book);
    return;
  }

  /* Lock : 60 dernières secondes, projecteur mécanique. Pas de last-tick snipe. */
  if (ctx.remaining > 60 || ctx.remaining < 8) return;
  if (ctx.lockSkip) {
    return;
  }
  if (ctx.pLockUp == null) return;
  const pUp = ctx.pLockUp;
  const pDown = 1 - pUp;
  const cand: { side: "up" | "down"; ask: number; p: number }[] = [
    { side: "up", ask: book.up.ask, p: pUp },
    { side: "down", ask: book.down.ask, p: pDown },
  ];
  let best: (typeof cand)[number] | null = null;
  let bestEv = 0;
  for (const c of cand) {
    if (!(c.ask > 0) || c.ask >= 0.99) continue;
    if (!expensiveAskOk(c.ask, c.p)) continue;
    const sh = sharesFor(c.ask, led.clip_usdc);
    const ev = lockEdgeUsdc(sh, c.ask, c.p);
    if (ev > bestEv) {
      bestEv = ev;
      best = c;
    }
  }
  if (!best) return;
  openTake(led, mkt, best.side, best.ask, "lock", ctx.now, book);
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
    "Intra n’entre que si /api/predict fire=true ET le CLOB a encore le côté cheap. " +
    "Le lock skip si le TWAP officiel est stale (pas de mid Coinbase). " +
    "L’intra ne bat le CLOB que si le prédicteur est en avance sur les cotes."
  );
}

export async function stepPolyPaper(): Promise<PolySnapshot> {
  const now = Date.now();
  const loaded = await loadLedger();
  const led = isCurrentLedger(loaded.ledger) ? loaded.ledger : emptyLedger(now);
  const markets = await discoverCurrent(now);
  const windowS = markets[0] ? twapWindowFromSrc(markets[0].resolution_source) : 60;
  const [twapsRaw, booksPairs, preds] = await Promise.all([
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
    Promise.all(
      (["BTC-USD", "ETH-USD"] as const).map(async (symbol) => {
        const intra = await predict({ symbol, horizon_s: 60 });
        const slot = await predict({ symbol, horizon_s: 300 });
        return [symbol, { intra, slot }] as const;
      }),
    ),
  ]);
  const books: Record<string, NonNullable<(typeof booksPairs)[number][1]>> = {};
  for (const [asset, book] of booksPairs) {
    if (book) books[asset] = book;
  }
  const predMap: Record<string, { intra: PredictResponse; slot: PredictResponse }> = {};
  for (const [symbol, p] of preds) predMap[symbol] = p;
  const twaps: TwapMap = {};
  for (const [k, v] of Object.entries(twapsRaw)) {
    if (v) twaps[k as keyof TwapMap] = markStale(v, now);
  }
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
