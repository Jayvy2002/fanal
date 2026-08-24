import {
  CLIP_USD,
  DEFAULT_PAPER_HORIZON_S,
  DEFAULT_PAPER_MODE,
  EXCHANGE_FEE,
  FEE_CAVEAT,
  FEE_PRODUCT,
  FEE_SOURCE_ADVANCED,
  FEE_SOURCE_EXCHANGE,
  FEE_TIER_LABEL,
  FEE_VERIFIED_VS_OFFICIAL,
  LEDGER_VERSION,
  MAKER_FEE_BPS,
  MAX_RECENT,
  STARTING_CASH_USD,
  TAKER_FEE_BPS,
  feePublicView,
  feeUsd,
  isPaperHorizon,
  makerRoundTripBps,
  paperGateBps,
  roundTripFeeBps,
  takerRoundTripBps,
  type FillRole,
  type PaperHorizonS,
  type PaperMode,
} from "./paperFees";
import { loadLedger, saveLedger, storeKind, type StoreKind } from "./paperStore";
import type { Ledger, PaperOrder, PaperPosition, PaperTrade } from "./paperTypes";
import type { Paper, PaperRow, Signal } from "./types";

export type MarketBar = { t: number; h: number; l: number };

export type MarketPx = {
  now: number;
  /** Horloge Coinbase (dernier ticker). Les barres 1s sont datées ainsi. */
  exch_now?: number;
  mid: number;
  bid: number;
  ask: number;
  last: number;
  low: number;
  high: number;
  bars?: MarketBar[];
};

export type PaperSignals = {
  five: Signal;
  sixty: Signal;
};

export { storeKind as paperStoreKind } from "./paperStore";

function horizonOf(led: Ledger): number {
  return led.horizon_s > 0 ? led.horizon_s : DEFAULT_PAPER_HORIZON_S;
}

function horizonMs(led: Ledger): number {
  return horizonOf(led) * 1000;
}

function emptyLedger(
  now: number,
  mode: PaperMode = DEFAULT_PAPER_MODE,
  horizonS: number = DEFAULT_PAPER_HORIZON_S,
): Ledger {
  const h = isPaperHorizon(horizonS) ? horizonS : DEFAULT_PAPER_HORIZON_S;
  return {
    v: LEDGER_VERSION,
    started_ts: now,
    updated_ts: now,
    mode,
    horizon_s: h,
    starting_cash_usd: STARTING_CASH_USD,
    cash_usd: STARTING_CASH_USD,
    btc: 0,
    realized_pnl_usd: 0,
    fees_usd: 0,
    n: 0,
    hits: 0,
    hits_after_fees: 0,
    n_cancelled: 0,
    n_maker_fills: 0,
    n_taker_fills: 0,
    clip_usd: CLIP_USD,
    min_move_bps: paperGateBps(h),
    last_entry_attempt_ts: 0,
    mark_px: 0,
    open: null,
    pending: null,
    recent: [],
  };
}

function clipQty(px: number): number {
  if (!(px > 0)) return 0;
  return CLIP_USD / px;
}

function buyPx(m: MarketPx): number {
  return m.ask > 0 ? m.ask : m.mid;
}

function sellPx(m: MarketPx): number {
  return m.bid > 0 ? m.bid : m.mid;
}

function exchOf(m: MarketPx, wallTs: number): number {
  if (m.exch_now && m.now) return wallTs - (m.now - m.exch_now);
  return wallTs;
}

/** Achat faiseur : fill seulement si le marché trade *sous* la limite (trade-through).
 *  Touch du bid/ask ou last/mid ne remplissent pas — sinon chaque bounce fill le paper.
 *  Pas de lookahead : on ignore la barre 1s qui a commencé avant l’ordre (horloge exchange). */
export function makerFill(side: "buy" | "sell", limit: number, m: MarketPx, sinceTs?: number): boolean {
  if (!(limit > 0)) return false;
  let low = Infinity;
  let high = -Infinity;
  const placed = sinceTs != null ? exchOf(m, sinceTs) : 0;
  if (m.bars?.length) {
    for (const b of m.bars) {
      if (b.t < placed) continue;
      if (b.l > 0) low = Math.min(low, b.l);
      if (b.h > 0) high = Math.max(high, b.h);
    }
  }
  if (side === "buy") {
    return Number.isFinite(low) && low < limit - 1e-9;
  }
  return Number.isFinite(high) && high > limit + 1e-9;
}

function applyFee(led: Ledger, usd: number, role: FillRole): void {
  led.fees_usd += usd;
  if (role === "maker") led.n_maker_fills += 1;
  else led.n_taker_fills += 1;
}

function fingerprint(led: Ledger): string {
  const open = led.open;
  const pend = led.pending;
  const last = led.recent[0];
  return [
    led.v,
    led.mode,
    led.horizon_s,
    led.n,
    led.hits,
    led.hits_after_fees,
    led.n_cancelled,
    led.cash_usd.toFixed(6),
    led.btc.toFixed(10),
    led.fees_usd.toFixed(6),
    led.realized_pnl_usd.toFixed(6),
    open ? `${open.side}:${open.entry_ts}:${open.qty}` : "",
    pend ? `${pend.kind}:${pend.side}:${pend.placed_ts}:${pend.limit_px}` : "",
    last?.id ?? "",
  ].join("|");
}

function closeRoundTrip(
  led: Ledger,
  pos: PaperPosition,
  exitPx: number,
  exitFee: number,
  exitRole: FillRole | "cancel",
  now: number,
): void {
  const notional = pos.entry_px * pos.qty;
  const gross =
    pos.side === "up" ? (exitPx - pos.entry_px) * pos.qty : (pos.entry_px - exitPx) * pos.qty;
  const pnl = gross - pos.entry_fee_usd - exitFee;
  const signed =
    pos.entry_px > 0
      ? pos.side === "up"
        ? ((exitPx - pos.entry_px) / pos.entry_px) * 1e4
        : ((pos.entry_px - exitPx) / pos.entry_px) * 1e4
      : 0;
  const hit = pos.side === "up" ? exitPx > pos.entry_px : exitPx < pos.entry_px;
  const trade: PaperTrade = {
    id: `${pos.entry_ts}-${pos.side}-${led.n + 1}`,
    ts: pos.entry_ts,
    side: pos.side,
    label: pos.label,
    mode: led.mode,
    entry_px: pos.entry_px,
    exit_px: exitPx,
    qty: pos.qty,
    notional_usd: notional,
    entry_role: pos.entry_role,
    exit_role: exitRole,
    entry_fee_usd: pos.entry_fee_usd,
    exit_fee_usd: exitFee,
    pnl_usd: pnl,
    pnl_bps: notional > 0 ? (pnl / notional) * 1e4 : 0,
    signed_bps: signed,
    hit,
    cancelled: false,
    horizon_s: horizonOf(led),
  };
  led.n += 1;
  if (hit) led.hits += 1;
  if (pnl > 0) led.hits_after_fees += 1;
  led.realized_pnl_usd += pnl;
  led.recent.unshift(trade);
  if (led.recent.length > MAX_RECENT) led.recent.pop();
  led.open = null;
  led.pending = null;
  led.updated_ts = now;
}

function flattenTaker(led: Ledger, pos: PaperPosition, m: MarketPx): void {
  if (pos.side === "up") {
    const px = sellPx(m);
    const notional = px * pos.qty;
    const fee = feeUsd(notional, TAKER_FEE_BPS);
    led.cash_usd += notional - fee;
    led.btc -= pos.qty;
    applyFee(led, fee, "taker");
    closeRoundTrip(led, pos, px, fee, "taker", m.now);
    return;
  }
  const px = buyPx(m);
  const notional = px * pos.qty;
  const fee = feeUsd(notional, TAKER_FEE_BPS);
  led.cash_usd -= notional + fee;
  led.btc += pos.qty;
  applyFee(led, fee, "taker");
  closeRoundTrip(led, pos, px, fee, "taker", m.now);
}

function enterTaker(led: Ledger, signal: Signal, m: MarketPx): void {
  const side = signal.side as "up" | "down";
  const label = signal.label as "HAUSSIER" | "BAISSIER";
  const hz = horizonMs(led);
  if (side === "up") {
    const px = buyPx(m);
    const qty = clipQty(px);
    const notional = px * qty;
    const fee = feeUsd(notional, TAKER_FEE_BPS);
    if (led.cash_usd < notional + fee || qty <= 0) return;
    led.cash_usd -= notional + fee;
    led.btc += qty;
    applyFee(led, fee, "taker");
    led.open = {
      side,
      label,
      qty,
      entry_px: px,
      entry_ts: m.now,
      entry_fee_usd: fee,
      entry_role: "taker",
      flatten_ts: m.now + hz,
      expected_move_bps: signal.expected_move_bps,
    };
  } else {
    const px = sellPx(m);
    const qty = clipQty(px);
    const notional = px * qty;
    const fee = feeUsd(notional, TAKER_FEE_BPS);
    if (qty <= 0 || led.cash_usd < fee) return;
    led.cash_usd += notional - fee;
    led.btc -= qty;
    applyFee(led, fee, "taker");
    led.open = {
      side,
      label,
      qty,
      entry_px: px,
      entry_ts: m.now,
      entry_fee_usd: fee,
      entry_role: "taker",
      flatten_ts: m.now + hz,
      expected_move_bps: signal.expected_move_bps,
    };
  }
  led.last_entry_attempt_ts = m.now;
  led.updated_ts = m.now;
}

function placeMakerEntry(led: Ledger, signal: Signal, m: MarketPx): void {
  const side = signal.side as "up" | "down";
  /* Post-only : achat au bid, vente à l’ask. */
  const limit = side === "up" ? sellPx(m) : buyPx(m);
  const qty = clipQty(limit);
  if (!(qty > 0) || !(limit > 0)) return;
  const notional = limit * qty;
  const fee = feeUsd(notional, MAKER_FEE_BPS);
  if (side === "up" && led.cash_usd < notional + fee) return;
  if (side === "down" && led.cash_usd < fee) return;
  led.pending = {
    kind: "entry",
    side,
    label: signal.label as "HAUSSIER" | "BAISSIER",
    limit_px: limit,
    qty,
    placed_ts: m.now,
    expire_ts: m.now + horizonMs(led),
    expected_move_bps: signal.expected_move_bps,
  };
  led.last_entry_attempt_ts = m.now;
  led.updated_ts = m.now;
}

function fillMakerEntry(led: Ledger, order: PaperOrder, m: MarketPx): void {
  const horizonEnd = order.placed_ts + horizonMs(led);
  /* Flatten à l’horizon du signal (placement), pas +H après le fill. */
  if (m.now >= horizonEnd) {
    cancelEntry(led, order, m.now);
    return;
  }
  const px = order.limit_px;
  const qty = order.qty;
  const notional = px * qty;
  const fee = feeUsd(notional, MAKER_FEE_BPS);
  if (order.side === "up") {
    if (led.cash_usd < notional + fee) {
      cancelEntry(led, order, m.now);
      return;
    }
    led.cash_usd -= notional + fee;
    led.btc += qty;
  } else {
    led.cash_usd += notional - fee;
    led.btc -= qty;
  }
  applyFee(led, fee, "maker");
  led.open = {
    side: order.side,
    label: order.label,
    qty,
    entry_px: px,
    entry_ts: m.now,
    entry_fee_usd: fee,
    entry_role: "maker",
    flatten_ts: horizonEnd,
    expected_move_bps: order.expected_move_bps,
  };
  const exitLimit = order.side === "up" ? buyPx(m) : sellPx(m);
  led.pending = {
    kind: "exit",
    side: order.side,
    label: order.label,
    limit_px: exitLimit,
    qty,
    placed_ts: m.now,
    expire_ts: horizonEnd,
    expected_move_bps: order.expected_move_bps,
  };
  led.updated_ts = m.now;
}

function fillMakerExit(led: Ledger, pos: PaperPosition, order: PaperOrder, m: MarketPx): void {
  const px = order.limit_px;
  const notional = px * pos.qty;
  const fee = feeUsd(notional, MAKER_FEE_BPS);
  if (pos.side === "up") {
    led.cash_usd += notional - fee;
    led.btc -= pos.qty;
  } else {
    led.cash_usd -= notional + fee;
    led.btc += pos.qty;
  }
  applyFee(led, fee, "maker");
  closeRoundTrip(led, pos, px, fee, "maker", m.now);
}

function cancelEntry(led: Ledger, order: PaperOrder, now: number): void {
  const trade: PaperTrade = {
    id: `${order.placed_ts}-${order.side}-c${led.n_cancelled + 1}`,
    ts: order.placed_ts,
    side: order.side,
    label: order.label,
    mode: led.mode,
    entry_px: order.limit_px,
    exit_px: order.limit_px,
    qty: order.qty,
    notional_usd: order.limit_px * order.qty,
    entry_role: "maker",
    exit_role: "cancel",
    entry_fee_usd: 0,
    exit_fee_usd: 0,
    pnl_usd: 0,
    pnl_bps: 0,
    signed_bps: null,
    hit: null,
    cancelled: true,
    horizon_s: horizonOf(led),
  };
  led.recent.unshift(trade);
  if (led.recent.length > MAX_RECENT) led.recent.pop();
  led.pending = null;
  led.n_cancelled += 1;
  led.updated_ts = now;
}

function pickSignal(led: Ledger, signals: PaperSignals | Signal): Signal {
  if ("five" in signals && "sixty" in signals) {
    return horizonOf(led) === 5 ? signals.five : signals.sixty;
  }
  return signals;
}

function canEnter(led: Ledger, signal: Signal, m: MarketPx): boolean {
  if (led.open || led.pending) return false;
  if (!signal.gated || signal.side === "flat") return false;
  const want = horizonOf(led);
  if ((signal.horizon_s ?? want) !== want) return false;
  const minMove = paperGateBps(want);
  if (!(Math.abs(signal.expected_move_bps) >= minMove - 1e-12)) return false;
  if (led.last_entry_attempt_ts > 0 && m.now - led.last_entry_attempt_ts < horizonMs(led) - 200) {
    return false;
  }
  if (!(m.mid > 0) || !(buyPx(m) > 0) || !(sellPx(m) > 0)) return false;
  return true;
}

function enforceOnePosition(led: Ledger): void {
  if (led.open && led.pending?.kind === "entry") led.pending = null;
}

function step(led: Ledger, m: MarketPx, signals: PaperSignals | Signal): void {
  if (!(m.now > 0) || !(m.mid > 0)) return;
  led.mark_px = m.mid;
  led.min_move_bps = paperGateBps(horizonOf(led));
  if (typeof led.hits_after_fees !== "number") led.hits_after_fees = 0;
  enforceOnePosition(led);
  const signal = pickSignal(led, signals);

  let freed = false;
  if (led.pending?.kind === "exit" && led.open) {
    const buy = led.open.side === "down";
    if (makerFill(buy ? "buy" : "sell", led.pending.limit_px, m, led.pending.placed_ts)) {
      fillMakerExit(led, led.open, led.pending, m);
      freed = true;
    } else if (m.now >= led.pending.expire_ts) {
      flattenTaker(led, led.open, m);
      freed = true;
    }
  } else if (led.open && !led.pending) {
    if (m.now >= led.open.flatten_ts) {
      flattenTaker(led, led.open, m);
      freed = true;
    }
  }

  if (led.pending?.kind === "entry" && !led.open) {
    const buy = led.pending.side === "up";
    if (makerFill(buy ? "buy" : "sell", led.pending.limit_px, m, led.pending.placed_ts)) {
      fillMakerEntry(led, led.pending, m);
    } else if (m.now >= led.pending.expire_ts) {
      cancelEntry(led, led.pending, m.now);
      freed = true;
    }
  }

  /* Pas de ré-entrée sur le même snapshot que flatten/cancel : une position, un prix. */
  if (!freed && canEnter(led, signal, m)) {
    if (led.mode === "maker") placeMakerEntry(led, signal, m);
    else enterTaker(led, signal, m);
  }
  enforceOnePosition(led);
}

function tradeToRow(t: PaperTrade): PaperRow {
  return {
    id: t.id,
    ts: t.ts,
    side: t.side,
    label: t.label,
    mid: t.entry_px,
    mid_end: t.cancelled ? null : t.exit_px,
    hit: t.hit,
    signed_bps: t.cancelled ? null : t.pnl_bps,
    horizon_s: t.horizon_s,
    pnl_usd: t.pnl_usd,
    fee_usd: t.entry_fee_usd + t.exit_fee_usd,
    entry_role: t.entry_role,
    exit_role: t.exit_role,
    status: t.cancelled ? "cancelled" : "closed",
  };
}

function pendingRow(led: Ledger, now: number): PaperRow | null {
  const hz = horizonOf(led);
  if (led.open) {
    return {
      ts: led.open.entry_ts,
      side: led.open.side,
      label: led.open.label,
      mid: led.open.entry_px,
      mid_end: null,
      hit: null,
      signed_bps: null,
      horizon_s: hz,
      entry_role: led.open.entry_role,
      status: "open",
      posted_px: led.pending?.kind === "exit" ? led.pending.limit_px : led.open.entry_px,
      age_s: Math.max(0, (now - led.open.entry_ts) / 1000),
    };
  }
  if (led.pending?.kind === "entry") {
    return {
      ts: led.pending.placed_ts,
      side: led.pending.side,
      label: led.pending.label,
      mid: led.pending.limit_px,
      mid_end: null,
      hit: null,
      signed_bps: null,
      horizon_s: hz,
      status: "pending_entry",
      posted_px: led.pending.limit_px,
      age_s: Math.max(0, (now - led.pending.placed_ts) / 1000),
    };
  }
  return null;
}

function remainingS(led: Ledger, now: number): number {
  const t = led.open?.flatten_ts ?? (led.pending ? led.pending.expire_ts : 0);
  if (!t) return 0;
  return Math.max(0, (t - now) / 1000);
}

function exitMarkPx(pos: PaperPosition, m: MarketPx): number {
  return pos.side === "up" ? sellPx(m) : buyPx(m);
}

function exitFeeBps(led: Ledger): number {
  if (led.mode === "maker" && led.pending?.kind === "exit") return MAKER_FEE_BPS;
  return TAKER_FEE_BPS;
}

function unrealizedUsd(led: Ledger, m: MarketPx): number {
  if (!led.open) return 0;
  const pos = led.open;
  const px = exitMarkPx(pos, m);
  if (!(px > 0)) return 0;
  const gross =
    pos.side === "up" ? (px - pos.entry_px) * pos.qty : (pos.entry_px - px) * pos.qty;
  const fee = feeUsd(px * pos.qty, exitFeeBps(led));
  return gross - pos.entry_fee_usd - fee;
}

function equityUsd(led: Ledger, m: MarketPx): number {
  if (!led.open) return led.cash_usd;
  const pos = led.open;
  const px = exitMarkPx(pos, m);
  if (!(px > 0)) return led.cash_usd;
  const fee = feeUsd(px * pos.qty, exitFeeBps(led));
  if (pos.side === "up") return led.cash_usd + pos.qty * px - fee;
  return led.cash_usd - pos.qty * px - fee;
}

function honestBlurb(led: Ledger): string {
  const hz = horizonOf(led);
  const gate = paperGateBps(hz);
  if (hz === 60) {
    return (
      "Aucun ordre Coinbase réel. Paper = faiseur 60s par défaut, gate = aller-retour faiseur " +
      `(${makerRoundTripBps()} bp), pas le feu 5s du graphique. ` +
      `Frais Advanced Trade palier d’entrée (hypothèse non vérifiée vs table officielle derrière login) : ` +
      `preneur ${TAKER_FEE_BPS} bp / faiseur ${MAKER_FEE_BPS} bp. ` +
      `|move| 60s BTC ~10 bp vs ${makerRoundTripBps()} bp de friction faiseur : couverture minuscule, ` +
      "E après frais probablement négative. Hit* = direction sans frais ; hits après frais = PnL $ > 0. " +
      "Faiseur = trade-through strict (pas un touch). Sortie faiseur sinon flatten preneur. " +
      "Un jour vert ici voudrait dire qu’on peut parler live — pas avant."
    );
  }
  return (
    "Aucun ordre Coinbase réel. Paper 5s preneur = opt-in de comparaison (pas le défaut). " +
    `Frais Advanced Trade hypothèse intro : preneur ${TAKER_FEE_BPS} bp / faiseur ${MAKER_FEE_BPS} bp. ` +
    `Aller-retour preneur = ${takerRoundTripBps()} bp vs |move| 5s ~1 bp et gate ${gate} bp : ` +
    "le paper preneur 5s doit perdre. Hit* = direction sans frais. Pas d’ordres live."
  );
}

export function viewPaper(led: Ledger, m: MarketPx, kind: StoreKind): Paper {
  const now = m.now || led.updated_ts;
  const u = unrealizedUsd(led, m);
  const equity = equityUsd(led, m);
  const open = pendingRow(led, now);
  const fees = feePublicView();
  return {
    n: led.n,
    hits: led.hits,
    hits_after_fees: led.hits_after_fees ?? 0,
    hit_rate: led.n > 0 ? led.hits / led.n : null,
    hit_rate_after_fees: led.n > 0 ? (led.hits_after_fees ?? 0) / led.n : null,
    pending: open,
    remaining_s: remainingS(led, now),
    recent: led.recent.map(tradeToRow),
    horizon_s: horizonOf(led),
    mode: led.mode,
    cash_usd: led.cash_usd,
    equity_usd: equity,
    realized_pnl_usd: led.realized_pnl_usd,
    unrealized_usd: u,
    fees_usd: led.fees_usd,
    starting_cash_usd: led.starting_cash_usd,
    clip_usd: led.clip_usd,
    min_move_bps: led.min_move_bps,
    n_cancelled: led.n_cancelled,
    n_maker_fills: led.n_maker_fills,
    n_taker_fills: led.n_taker_fills,
    fee_product: FEE_PRODUCT,
    fee_tier: FEE_TIER_LABEL,
    taker_fee_bps: TAKER_FEE_BPS,
    maker_fee_bps: MAKER_FEE_BPS,
    round_trip_fee_bps: roundTripFeeBps(led.mode),
    round_trip_maker_bps: makerRoundTripBps(),
    round_trip_taker_bps: takerRoundTripBps(),
    fee_caveat: FEE_CAVEAT,
    fee_verified_vs_official: FEE_VERIFIED_VS_OFFICIAL,
    official_advanced_url: FEE_SOURCE_ADVANCED,
    official_exchange_url: FEE_SOURCE_EXCHANGE,
    exchange_alternate: {
      product: EXCHANGE_FEE.product,
      taker_bps: EXCHANGE_FEE.taker_bps,
      maker_bps: EXCHANGE_FEE.maker_bps,
      used: false,
    },
    persisted: true,
    store: kind,
    started_ts: led.started_ts,
    updated_ts: led.updated_ts,
    open_position: led.open
      ? {
          side: led.open.side,
          label: led.open.label,
          qty: led.open.qty,
          entry_px: led.open.entry_px,
          role: led.open.entry_role,
          posted_px: led.pending?.kind === "exit" ? led.pending.limit_px : led.open.entry_px,
          age_s: Math.max(0, (now - led.open.entry_ts) / 1000),
        }
      : led.pending?.kind === "entry"
        ? {
            side: led.pending.side,
            label: led.pending.label,
            qty: led.pending.qty,
            entry_px: led.pending.limit_px,
            role: "maker",
            posted_px: led.pending.limit_px,
            age_s: Math.max(0, (now - led.pending.placed_ts) / 1000),
          }
        : null,
    honest: honestBlurb(led),
  };
}

function isV2Ledger(raw: unknown): raw is Ledger {
  if (!raw || typeof raw !== "object") return false;
  const led = raw as Ledger;
  return (
    led.v === LEDGER_VERSION &&
    isPaperHorizon(led.horizon_s) &&
    (led.mode === "taker" || led.mode === "maker") &&
    typeof led.cash_usd === "number"
  );
}

function hydrate(loaded: Awaited<ReturnType<typeof loadLedger>>, now: number): Ledger {
  if (isV2Ledger(loaded.ledger)) {
    const led = loaded.ledger;
    if (typeof led.mark_px !== "number") led.mark_px = 0;
    if (typeof led.hits_after_fees !== "number") led.hits_after_fees = 0;
    if (typeof led.n_maker_fills !== "number") led.n_maker_fills = 0;
    if (typeof led.n_taker_fills !== "number") led.n_taker_fills = 0;
    return led;
  }
  /* v1 5s taker (ou objet inconnu) : nouveau carnet 60s faiseur, cash 1000. */
  return emptyLedger(now);
}

let chain: Promise<unknown> = Promise.resolve();

async function transact(mut: (led: Ledger) => void): Promise<{ ledger: Ledger; kind: StoreKind }> {
  let last: { ledger: Ledger; kind: StoreKind } | null = null;
  for (let i = 0; i < 6; i++) {
    const loaded = await loadLedger();
    const created = !isV2Ledger(loaded.ledger);
    const led = hydrate(loaded, Date.now());
    const before = fingerprint(led);
    mut(led);
    last = { ledger: led, kind: loaded.kind };
    if (!created && fingerprint(led) === before) return last;
    const ok = await saveLedger(led, loaded.etag);
    if (ok) return last;
  }
  return last ?? { ledger: emptyLedger(Date.now()), kind: await storeKind() };
}

export async function stepPaper(m: MarketPx, signals: PaperSignals | Signal): Promise<Paper> {
  const run = chain.then(async () => {
    const { ledger, kind } = await transact((led) => step(led, m, signals));
    return viewPaper(ledger, m, kind);
  });
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function setPaperConfig(opts: {
  mode?: PaperMode;
  horizonSec?: number;
}): Promise<Paper> {
  const mode = opts.mode;
  const horizonSec = opts.horizonSec;
  if (mode != null && mode !== "taker" && mode !== "maker") throw new Error("mode_invalide");
  if (horizonSec != null && !isPaperHorizon(horizonSec)) throw new Error("horizon_invalide");
  const { ledger, kind } = await transact((led) => {
    const nextMode = mode ?? led.mode;
    const nextH = (horizonSec ?? led.horizon_s) as PaperHorizonS;
    if (led.mode !== nextMode || horizonOf(led) !== nextH) {
      const fresh = emptyLedger(Date.now(), nextMode, nextH);
      Object.assign(led, fresh);
    } else {
      led.updated_ts = Date.now();
    }
  });
  return viewPaper(
    ledger,
    {
      now: Date.now(),
      mid: ledger.mark_px,
      bid: 0,
      ask: 0,
      last: ledger.mark_px,
      low: 0,
      high: 0,
    },
    kind,
  );
}

/** @deprecated use setPaperConfig */
export async function setPaperMode(mode: PaperMode): Promise<Paper> {
  return setPaperConfig({ mode });
}

export async function snapshotPaper(m?: MarketPx): Promise<Paper> {
  const loaded = await loadLedger();
  const now = m?.now || Date.now();
  const led = hydrate(loaded, now);
  return viewPaper(
    led,
    m ?? {
      now,
      mid: led.mark_px,
      bid: 0,
      ask: 0,
      last: led.mark_px,
      low: 0,
      high: 0,
    },
    loaded.kind,
  );
}

export function newLedger(
  now: number,
  mode: PaperMode = DEFAULT_PAPER_MODE,
  horizonS: number = DEFAULT_PAPER_HORIZON_S,
): Ledger {
  return emptyLedger(now, mode, horizonS);
}

export function applyPaperStep(
  led: Ledger,
  m: MarketPx,
  signal: PaperSignals | Signal,
): Ledger {
  step(led, m, signal);
  return led;
}
