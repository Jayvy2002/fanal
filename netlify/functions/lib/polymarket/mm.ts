/**
 * Paper MM two-sided style Bonereaper — maker par défaut, redeem $1/$0.
 * Aucun ordre CLOB live. Pas de copie de wallet.
 */
import { cryptoTakerFeeUsdc, FEE_FORMULA } from "./fees";
import { normCdf } from "./lock";
import type { PairBook, SideBook } from "./clob";
import {
  MM_ASSETS,
  MM_CLIP_USDC,
  MM_HARD_CAP,
  MM_LEAN_RATIO,
  MM_LEDGER_V,
  MM_MAX_FILLS_SLOT,
  MM_MAX_RECENT,
  MM_MAX_SHARES,
  MM_PAIR_TIMEOUT_MS,
  MM_STARTING_CASH,
  MM_TARGET_PAIR,
  MM_TICK,
  type MmAsset,
  type MmLedger,
  type MmMarketView,
  type MmQuote,
  type MmSide,
  type MmSlot,
  type MmSnapshot,
  type MmStepInput,
  type MmTrade,
} from "./mmtypes";
import type { DiscoveredMarket } from "./markets";
import { getMmTest } from "./mmtest";
import { twapSymbolOf, type TwapTick } from "./twap";

export const MM_HONEST =
  "Paper MM two-sided ON — maker (frais 0), pair < 1 $, hold des locks jusqu’à résolution. " +
  "Jambe nue : flatten / scratch, pas une loterie $1. Pas d’ordres live, aucune clé. " +
  "Bonereaper est du websocket sub-seconde ; ce paper est plus lent " +
  "(poll 1 s + cron 1 min) donc E attendu = borne basse / autre régime. " +
  "Le prédicteur 1 h / 4 h est un jouet UI et ne trade pas.";

export function tickRound(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return Math.round(p * 100) / 100;
}

export function emptyMmLedger(now: number): MmLedger {
  return {
    v: MM_LEDGER_V,
    started_ts: now,
    updated_ts: now,
    cash_usdc: MM_STARTING_CASH,
    starting_cash_usdc: MM_STARTING_CASH,
    realized_pnl_usdc: 0,
    fees_usdc: 0,
    n: 0,
    n_pairs: 0,
    n_maker_fills: 0,
    n_taker_fills: 0,
    n_scratch: 0,
    hits: 0,
    clip_usdc: MM_CLIP_USDC,
    quotes: [],
    slots: [],
    recent: [],
    strikes: {},
    last_twap: {},
    spot_open: {},
  };
}

export function isMmLedger(x: unknown): x is MmLedger {
  return Boolean(x && typeof x === "object" && (x as MmLedger).v === MM_LEDGER_V);
}

function idOf(prefix: string, now: number): string {
  return `${prefix}-${now}-${Math.floor(Math.random() * 1e6)}`;
}

export function strikeKey(asset: string, slot: number): string {
  return `${asset}:${slot}`;
}

export function mmAssetOk(asset: string): asset is MmAsset {
  return (MM_ASSETS as readonly string[]).includes(asset);
}

export function pairAsk(book: PairBook): number | null {
  if (!(book.up.ask > 0) || !(book.down.ask > 0)) return null;
  return book.up.ask + book.down.ask;
}

export function pairBid(book: PairBook): number | null {
  if (!(book.up.bid > 0) || !(book.down.bid > 0)) return null;
  return book.up.bid + book.down.bid;
}

export function clobPUp(book: PairBook): number | null {
  const mid = book.up.mid;
  if (mid > 0 && mid < 1) return mid;
  const a = pairAsk(book);
  if (a && book.up.ask > 0) return book.up.ask / a;
  return null;
}

/** Frais taker des deux jambes pour `shares` Up + `shares` Down. */
export function takerPairCostPerShare(askUp: number, askDown: number): number {
  const fee = cryptoTakerFeeUsdc(1, askUp) + cryptoTakerFeeUsdc(1, askDown);
  return askUp + askDown + fee;
}

export function sharesForBid(bid: number, clip: number): number {
  if (!(bid > 0) || !(clip > 0)) return 0;
  return Math.min(clip / bid, MM_MAX_SHARES);
}

export function takerLockOk(askUp: number, askDown: number): boolean {
  if (!(askUp > 0) || !(askDown > 0)) return false;
  const c = takerPairCostPerShare(askUp, askDown);
  return c < 1 && c <= MM_HARD_CAP;
}

export type QuotePlan = {
  why: string;
  taker: { ask_up: number; ask_down: number; shares: number; fee: number; pair: number } | null;
  up: { bid: number; shares: number } | null;
  down: { bid: number; shares: number } | null;
};

export function planQuotes(book: PairBook, clip: number, pFair: number | null): QuotePlan {
  const empty: QuotePlan = { why: "no_book", taker: null, up: null, down: null };
  const au = book.up.ask;
  const ad = book.down.ask;
  const bu = book.up.bid;
  const bd = book.down.bid;
  if (!(au > 0) || !(ad > 0)) return empty;

  if (takerLockOk(au, ad)) {
    const pair = takerPairCostPerShare(au, ad);
    const shares = Math.min(sharesForBid(au, clip), sharesForBid(ad, clip));
    const fee = cryptoTakerFeeUsdc(shares, au) + cryptoTakerFeeUsdc(shares, ad);
    const ev = shares * 1 - shares * (au + ad) - fee;
    if (ev > 0 && pair < 1) {
      return {
        why: "taker_lock",
        taker: { ask_up: au, ask_down: ad, shares, fee, pair },
        up: null,
        down: null,
      };
    }
  }

  let bidUp = bu > 0 ? bu : MM_TICK;
  let bidDown = bd > 0 ? bd : MM_TICK;
  const join = bidUp + bidDown;
  if (join > MM_TARGET_PAIR) {
    const scale = MM_TARGET_PAIR / join;
    bidUp = tickRound(bidUp * scale);
    bidDown = tickRound(MM_TARGET_PAIR - bidUp);
  }
  bidUp = tickRound(Math.min(bidUp, au - MM_TICK));
  bidDown = tickRound(Math.min(bidDown, ad - MM_TICK));
  if (bidUp < MM_TICK || bidDown < MM_TICK) return { ...empty, why: "no_room" };
  if (bidUp < 0.05 || bidDown < 0.05) return { ...empty, why: "too_cheap" };
  const sum = bidUp + bidDown;
  if (sum > 1) return { ...empty, why: "pair_over_1" };
  if (sum > MM_HARD_CAP) return { ...empty, why: "cap" };

  let sh = Math.min(sharesForBid(bidUp, clip), sharesForBid(bidDown, clip));
  if (!(sh > 0)) return { ...empty, why: "no_size" };
  let shUp = sh;
  let shDown = sh;
  /* Lean extra seulement si ratio demandée ≥ 2 (on skip 1.0–1.5×). */
  const implied = clobPUp(book);
  if (MM_LEAN_RATIO >= 2 && pFair != null && implied != null) {
    const edge = pFair - implied;
    if (Math.abs(edge) >= 0.04) {
      if (edge > 0) shUp *= MM_LEAN_RATIO;
      else shDown *= MM_LEAN_RATIO;
    }
  }
  return {
    why: "maker_pair",
    taker: null,
    up: { bid: bidUp, shares: shUp },
    down: { bid: bidDown, shares: shDown },
  };
}

/** Fill maker : trade-through d’un snapshot *ultérieur* (pas le placement). */
export function makerBidFills(q: MmQuote, later: SideBook, now: number): boolean {
  if (now <= q.placed_ts) return false;
  if (!(q.bid > 0)) return false;
  const askHit = later.ask > 0 && later.ask <= q.bid + 1e-12 && later.ask < q.placed_ask - 1e-12;
  const midCross = later.mid > 0 && later.mid <= q.bid + 1e-12 && q.placed_mid > q.bid + 1e-12;
  return askHit || midCross;
}

export function makerAskFills(q: MmQuote, later: SideBook, now: number): boolean {
  /* flatten : on a stocké le prix de vente dans bid (ask de vente). */
  if (now <= q.placed_ts) return false;
  if (!(q.bid > 0)) return false;
  const bidHit = later.bid > 0 && later.bid >= q.bid - 1e-12 && later.bid > q.placed_bid + 1e-12;
  const midCross = later.mid > 0 && later.mid >= q.bid - 1e-12 && q.placed_mid < q.bid - 1e-12;
  return bidHit || midCross;
}

export function pFairOf(opts: {
  twap: number | null;
  twap_stale: boolean;
  strike: number | null;
  strike_late: boolean;
  remaining_s: number;
  rv_1m: number;
  spot: number | null;
  spot_open: number | null;
}): number | null {
  const t = Math.max(opts.remaining_s, 1);
  const sigma = Math.max(opts.rv_1m, 5e-4);
  const vol = sigma * Math.sqrt(t / 60);
  if (opts.twap && opts.twap > 0 && !opts.twap_stale && opts.strike && opts.strike > 0 && !opts.strike_late) {
    const z = Math.log(opts.twap / opts.strike) / vol;
    return Math.min(0.995, Math.max(0.005, normCdf(z)));
  }
  if (opts.spot && opts.spot > 0 && opts.spot_open && opts.spot_open > 0) {
    const z = Math.log(opts.spot / opts.spot_open) / vol;
    return Math.min(0.995, Math.max(0.005, normCdf(z)));
  }
  return null;
}

function ensureSlot(led: MmLedger, mkt: DiscoveredMarket): MmSlot {
  let s = led.slots.find((x) => x.asset === mkt.asset && x.slot_start_s === mkt.slot_start_s);
  if (s) return s;
  s = {
    asset: mkt.asset as MmAsset,
    symbol: mkt.symbol,
    slug: mkt.slug,
    slot_start_s: mkt.slot_start_s,
    shares_up: 0,
    shares_down: 0,
    cost_up: 0,
    cost_down: 0,
    fees_usdc: 0,
    matched: 0,
    paired_cost: 0,
    naked_since_ts: null,
    n_fills: 0,
    n_maker: 0,
    n_taker: 0,
    flatten_quote: null,
  };
  led.slots.push(s);
  return s;
}

function rematch(slot: MmSlot): void {
  const m = Math.min(slot.shares_up, slot.shares_down);
  if (m <= slot.matched + 1e-12) {
    if (Math.abs(slot.shares_up - slot.shares_down) < 1e-9) slot.naked_since_ts = null;
    return;
  }
  const add = m - slot.matched;
  const avgU = slot.shares_up > 0 ? slot.cost_up / slot.shares_up : 0;
  const avgD = slot.shares_down > 0 ? slot.cost_down / slot.shares_down : 0;
  slot.paired_cost += add * (avgU + avgD);
  slot.matched = m;
  if (Math.abs(slot.shares_up - slot.shares_down) < 1e-9) slot.naked_since_ts = null;
}

function buy(
  led: MmLedger,
  slot: MmSlot,
  side: MmSide,
  shares: number,
  px: number,
  fee: number,
  now: number,
  maker: boolean,
): boolean {
  if (!(shares > 0) || !(px > 0)) return false;
  const cost = shares * px + fee;
  if (cost > led.cash_usdc + 1e-9) return false;
  if (slot.n_fills >= MM_MAX_FILLS_SLOT) return false;
  led.cash_usdc -= cost;
  led.fees_usdc += fee;
  slot.fees_usdc += fee;
  slot.n_fills += 1;
  if (maker) {
    slot.n_maker += 1;
    led.n_maker_fills += 1;
  } else {
    slot.n_taker += 1;
    led.n_taker_fills += 1;
  }
  if (side === "up") {
    slot.shares_up += shares;
    slot.cost_up += cost;
  } else {
    slot.shares_down += shares;
    slot.cost_down += cost;
  }
  const naked = Math.abs(slot.shares_up - slot.shares_down) > 1e-9;
  if (naked && slot.naked_since_ts == null) slot.naked_since_ts = now;
  rematch(slot);
  return true;
}

function sellScratch(led: MmLedger, slot: MmSlot, side: MmSide, px: number, now: number, taker: boolean): void {
  const sh = side === "up" ? slot.shares_up - slot.matched : slot.shares_down - slot.matched;
  if (!(sh > 1e-9) || !(px > 0)) return;
  const fee = taker ? cryptoTakerFeeUsdc(sh, px) : 0;
  const proceeds = sh * px - fee;
  led.cash_usdc += proceeds;
  led.fees_usdc += fee;
  const avg = side === "up" ? slot.cost_up / Math.max(slot.shares_up, 1e-12) : slot.cost_down / Math.max(slot.shares_down, 1e-12);
  const pnl = proceeds - avg * sh;
  if (side === "up") {
    slot.cost_up -= avg * sh;
    slot.shares_up -= sh;
  } else {
    slot.cost_down -= avg * sh;
    slot.shares_down -= sh;
  }
  slot.naked_since_ts = null;
  slot.flatten_quote = null;
  led.n_scratch += 1;
  pushTrade(led, {
    id: idOf("scratch", now),
    ts: now,
    asset: slot.asset,
    slug: slot.slug,
    kind: "scratch",
    matched: 0,
    paired_cost: avg * sh,
    pair_avg: null,
    pnl,
    winner: null,
    reason: taker ? "scratch_taker_naked" : "scratch_maker_naked",
  });
}

function pushTrade(led: MmLedger, row: MmTrade): void {
  led.n += 1;
  if (row.pnl > 0) led.hits += 1;
  led.realized_pnl_usdc += row.pnl;
  led.recent.unshift(row);
  if (led.recent.length > MM_MAX_RECENT) led.recent.pop();
}

function captureSpotOpen(led: MmLedger, mkt: DiscoveredMarket, spot: number, now: number): void {
  const key = strikeKey(mkt.asset, mkt.slot_start_s);
  if (led.spot_open[key] || !(spot > 0)) return;
  const openMs = mkt.slot_start_s * 1000;
  const late = Math.abs(now - openMs) > 25_000;
  led.spot_open[key] = { px: spot, ts: now, late };
}

function captureStrike(led: MmLedger, mkt: DiscoveredMarket, tick: TwapTick | undefined, now: number): void {
  const key = strikeKey(mkt.asset, mkt.slot_start_s);
  if (led.strikes[key] || !tick || !(tick.value > 0)) return;
  const openMs = mkt.slot_start_s * 1000;
  const late = Math.abs(tick.observed_ts - openMs) > 20_000;
  if (now / 1000 - mkt.slot_start_s > 25 && late) {
    led.strikes[key] = { twap: tick.value, observed_ts: tick.observed_ts, window_s: tick.window_s, late: true };
    return;
  }
  led.strikes[key] = { twap: tick.value, observed_ts: tick.observed_ts, window_s: tick.window_s, late };
}

function winnerOf(led: MmLedger, slot: MmSlot, now: number): MmSide | null {
  const key = strikeKey(slot.asset, slot.slot_start_s);
  const strike = led.strikes[key];
  const tick = led.last_twap[twapSymbolOf(slot.asset)];
  if (strike && strike.twap > 0 && !strike.late && tick && tick.value > 0 && !tick.stale) {
    return tick.value >= strike.twap ? "up" : "down";
  }
  const open = led.spot_open[key];
  /* proxy Coinbase seulement si le TWAP officiel manque — paper, pas un claim live. */
  void now;
  if (open && open.px > 0 && tick && tick.value > 0) {
    return tick.value >= open.px ? "up" : "down";
  }
  return null;
}

function redeemSlot(led: MmLedger, slot: MmSlot, now: number, winner: MmSide | null): void {
  const matched = slot.matched;
  const pairPnl = matched > 0 ? matched * 1 - slot.paired_cost : 0;
  if (matched > 0) {
    led.cash_usdc += matched;
    led.n_pairs += 1;
    pushTrade(led, {
      id: idOf("pair", now),
      ts: now,
      asset: slot.asset,
      slug: slot.slug,
      kind: "pair_redeem",
      matched,
      paired_cost: slot.paired_cost,
      pair_avg: slot.paired_cost / matched,
      pnl: pairPnl,
      winner,
      reason: "redeem_matched_1_0",
    });
  }
  const nakedUp = slot.shares_up - slot.matched;
  const nakedDown = slot.shares_down - slot.matched;
  if (nakedUp > 1e-9) {
    const avg = slot.cost_up / Math.max(slot.shares_up, 1e-12);
    const pnl = -avg * nakedUp;
    led.n_scratch += 1;
    pushTrade(led, {
      id: idOf("naked-up", now),
      ts: now,
      asset: slot.asset,
      slug: slot.slug,
      kind: "scratch",
      matched: 0,
      paired_cost: avg * nakedUp,
      pair_avg: null,
      pnl,
      winner: null,
      reason: "unpaired_writeoff_up",
    });
  }
  if (nakedDown > 1e-9) {
    const avg = slot.cost_down / Math.max(slot.shares_down, 1e-12);
    const pnl = -avg * nakedDown;
    led.n_scratch += 1;
    pushTrade(led, {
      id: idOf("naked-dn", now),
      ts: now,
      asset: slot.asset,
      slug: slot.slug,
      kind: "scratch",
      matched: 0,
      paired_cost: avg * nakedDown,
      pair_avg: null,
      pnl,
      winner: null,
      reason: "unpaired_writeoff_down",
    });
  }
}

function dropSlot(led: MmLedger, slot: MmSlot): void {
  led.slots = led.slots.filter((s) => s !== slot);
  led.quotes = led.quotes.filter((q) => !(q.asset === slot.asset && q.slot_start_s === slot.slot_start_s));
}

export function applyMmStep(led: MmLedger, input: MmStepInput): MmMarketView[] {
  const now = input.now;
  const views: MmMarketView[] = [];

  /* Redeem créneaux clos : $1 / pair appariée ; nues = write-off (pas une loterie). */
  for (const slot of [...led.slots]) {
    const end = slot.slot_start_s + 300;
    if (now / 1000 < end) continue;
    const w = winnerOf(led, slot, now);
    redeemSlot(led, slot, now, w);
    dropSlot(led, slot);
  }

  for (const mkt of input.markets) {
    if (!mmAssetOk(mkt.asset)) continue;
    const book = input.books[mkt.asset];
    const tick = led.last_twap[twapSymbolOf(mkt.asset)];
    captureStrike(led, mkt, tick, now);
    const spot = input.spots[mkt.asset] ?? 0;
    captureSpotOpen(led, mkt, spot, now);
    const key = strikeKey(mkt.asset, mkt.slot_start_s);
    const strike = led.strikes[key];
    const open = led.spot_open[key];
    const pFair = pFairOf({
      twap: tick?.value ?? null,
      twap_stale: tick ? tick.stale : true,
      strike: strike && !strike.late ? strike.twap : null,
      strike_late: Boolean(strike?.late),
      remaining_s: mkt.remaining_s,
      rv_1m: input.rv[mkt.asset] ?? 0.001,
      spot: spot || null,
      spot_open: open && !open.late ? open.px : null,
    });

    if (!book) {
      views.push({
        market: mkt,
        book: { up: emptySide(), down: emptySide() },
        p_fair: pFair,
        p_clob: null,
        quotes: [],
        slot: led.slots.find((s) => s.asset === mkt.asset && s.slot_start_s === mkt.slot_start_s) ?? null,
        pair_ask: null,
        pair_bid: null,
      });
      continue;
    }

    const slot = ensureSlot(led, mkt);
    const plan = planQuotes(book, led.clip_usdc, pFair);

    /* Taker lock : une fois par créneau, seulement si encore vide. */
    if (
      plan.taker &&
      slot.n_fills === 0 &&
      mkt.remaining_s > 8 &&
      takerLockOk(plan.taker.ask_up, plan.taker.ask_down)
    ) {
      const sh = plan.taker.shares;
      const feeU = cryptoTakerFeeUsdc(sh, plan.taker.ask_up);
      const feeD = cryptoTakerFeeUsdc(sh, plan.taker.ask_down);
      const cost = sh * (plan.taker.ask_up + plan.taker.ask_down) + feeU + feeD;
      if (cost <= led.cash_usdc + 1e-9) {
        buy(led, slot, "up", sh, plan.taker.ask_up, feeU, now, false);
        buy(led, slot, "down", sh, plan.taker.ask_down, feeD, now, false);
        led.quotes = led.quotes.filter((q) => !(q.asset === mkt.asset && q.slot_start_s === mkt.slot_start_s));
      }
    } else if (mkt.remaining_s > 8 && slot.n_fills < MM_MAX_FILLS_SLOT && slot.matched < 1e-9) {
      /* Fills maker sur quotes *précédentes*. */
      const keep: MmQuote[] = [];
      for (const q of led.quotes) {
        if (q.asset !== mkt.asset || q.slot_start_s !== mkt.slot_start_s) {
          keep.push(q);
          continue;
        }
        const sideBook = q.side === "up" ? book.up : book.down;
        if (makerBidFills(q, sideBook, now)) {
          buy(led, slot, q.side, q.shares, q.bid, 0, now, true);
          continue;
        }
        keep.push(q);
      }
      led.quotes = keep;

      /* Une fois apparié : plus de quotes. Sinon requote le côté manquant. */
      if (slot.matched > 1e-9) {
        led.quotes = led.quotes.filter(
          (q) => !(q.asset === mkt.asset && q.slot_start_s === mkt.slot_start_s),
        );
      } else {
        const has = (side: MmSide) =>
          led.quotes.some((q) => q.asset === mkt.asset && q.slot_start_s === mkt.slot_start_s && q.side === side);
        if (plan.up && !has("up") && slot.shares_up <= slot.shares_down + 1e-9) {
          led.quotes.push(makeQuote(mkt, "up", plan.up.bid, plan.up.shares, book.up, now));
        }
        if (plan.down && !has("down") && slot.shares_down <= slot.shares_up + 1e-9) {
          led.quotes.push(makeQuote(mkt, "down", plan.down.bid, plan.down.shares, book.down, now));
        }
      }
    } else if (slot.matched > 1e-9) {
      led.quotes = led.quotes.filter(
        (q) => !(q.asset === mkt.asset && q.slot_start_s === mkt.slot_start_s),
      );
    }

    /* Naked : timeout ~60 s (ou fin de slot) → flatten maker puis scratch. Pas de hold loterie. */
    const remainingMs = Math.max(0, (mkt.slot_start_s + 300) * 1000 - now);
    const pairBudget = Math.min(MM_PAIR_TIMEOUT_MS, Math.max(8_000, remainingMs - 8_000));
    const nakedQty = Math.abs(slot.shares_up - slot.shares_down);
    if (slot.naked_since_ts != null && nakedQty > 1e-9) {
      const aged = now - slot.naked_since_ts >= pairBudget;
      const ending = remainingMs <= 12_000;
      if (aged || ending) {
        const nakedSide: MmSide = slot.shares_up > slot.shares_down ? "up" : "down";
        const sideBook = nakedSide === "up" ? book.up : book.down;
        const fq = slot.flatten_quote;
        led.quotes = led.quotes.filter(
          (q) => !(q.asset === mkt.asset && q.slot_start_s === mkt.slot_start_s),
        );
        if (fq && makerAskFills(fq, sideBook, now)) {
          sellScratch(led, slot, nakedSide, fq.bid, now, false);
        } else if (ending && sideBook.bid > 0) {
          sellScratch(led, slot, nakedSide, sideBook.bid, now, true);
        } else if (!fq && sideBook.ask > 0 && !ending) {
          const ask = tickRound(Math.max(sideBook.ask, MM_TICK));
          slot.flatten_quote = makeQuote(mkt, nakedSide, ask, 0, sideBook, now);
        } else if (fq && now - fq.placed_ts > 8_000 && sideBook.bid > 0) {
          sellScratch(led, slot, nakedSide, sideBook.bid, now, true);
        } else if (sideBook.bid > 0 && aged) {
          sellScratch(led, slot, nakedSide, sideBook.bid, now, true);
        }
      }
    }

    views.push({
      market: mkt,
      book,
      p_fair: pFair,
      p_clob: clobPUp(book),
      quotes: led.quotes.filter((q) => q.asset === mkt.asset && q.slot_start_s === mkt.slot_start_s),
      slot,
      pair_ask: pairAsk(book),
      pair_bid: pairBid(book),
    });
  }

  led.updated_ts = now;
  return views;
}

function makeQuote(
  mkt: DiscoveredMarket,
  side: MmSide,
  bid: number,
  shares: number,
  book: SideBook,
  now: number,
): MmQuote {
  return {
    id: idOf(`q-${side}`, now),
    asset: mkt.asset as MmAsset,
    slug: mkt.slug,
    slot_start_s: mkt.slot_start_s,
    side,
    bid,
    shares,
    placed_ts: now,
    placed_ask: book.ask,
    placed_mid: book.mid,
    placed_bid: book.bid,
  };
}

function emptySide(): SideBook {
  return { bid: 0, ask: 0, mid: 0, spread: 0, bids: [], asks: [] };
}

function markUnrealized(led: MmLedger, views: MmMarketView[]): number {
  let u = 0;
  for (const slot of led.slots) {
    if (slot.matched > 0) u += slot.matched - slot.paired_cost;
    const v = views.find((x) => x.market.asset === slot.asset);
    const nakedU = slot.shares_up - slot.matched;
    const nakedD = slot.shares_down - slot.matched;
    if (v && nakedU > 0 && v.book.up.bid > 0) u += nakedU * v.book.up.bid;
    if (v && nakedD > 0 && v.book.down.bid > 0) u += nakedD * v.book.down.bid;
    if (nakedU > 0) u -= (slot.cost_up / Math.max(slot.shares_up, 1e-12)) * nakedU;
    if (nakedD > 0) u -= (slot.cost_down / Math.max(slot.shares_down, 1e-12)) * nakedD;
  }
  return u;
}

export function snapshotMm(led: MmLedger, views: MmMarketView[], store: "blobs" | "file"): MmSnapshot {
  const unreal = markUnrealized(led, views);
  return {
    v: MM_LEDGER_V,
    on: true,
    live_orders: false,
    cash_usdc: led.cash_usdc,
    starting_cash_usdc: led.starting_cash_usdc,
    equity_usdc: led.cash_usdc + unreal,
    realized_pnl_usdc: led.realized_pnl_usdc,
    unrealized_usdc: unreal,
    fees_usdc: led.fees_usdc,
    n: led.n,
    n_pairs: led.n_pairs,
    n_maker_fills: led.n_maker_fills,
    n_taker_fills: led.n_taker_fills,
    n_scratch: led.n_scratch,
    hits: led.hits,
    hit_rate: led.n > 0 ? led.hits / led.n : null,
    clip_usdc: led.clip_usdc,
    quotes: led.quotes,
    slots: led.slots,
    recent: led.recent,
    markets: views,
    store,
    honest: MM_HONEST,
    fee_formula: FEE_FORMULA,
    test: getMmTest(),
  };
}

export function newMmLedger(now = Date.now()): MmLedger {
  return emptyMmLedger(now);
}
