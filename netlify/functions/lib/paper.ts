import {
  CLIP_USD,
  FEE_TIER_LABEL,
  HORIZON_MS,
  MAKER_FEE_BPS,
  MAX_RECENT,
  PAPER_MIN_MOVE_BPS,
  STARTING_CASH_USD,
  TAKER_FEE_BPS,
  feeUsd,
  roundTripFeeBps,
  type FillRole,
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

function emptyLedger(now: number, mode: PaperMode = "taker"): Ledger {
  return {
    v: 1,
    started_ts: now,
    updated_ts: now,
    mode,
    starting_cash_usd: STARTING_CASH_USD,
    cash_usd: STARTING_CASH_USD,
    btc: 0,
    realized_pnl_usd: 0,
    fees_usd: 0,
    n: 0,
    hits: 0,
    n_cancelled: 0,
    n_maker_fills: 0,
    n_taker_fills: 0,
    clip_usd: CLIP_USD,
    min_move_bps: PAPER_MIN_MOVE_BPS,
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

function hasQuotes(m: MarketPx): boolean {
  return m.bid > 0 && m.ask > 0 && m.ask >= m.bid;
}

function buyPx(m: MarketPx): number {
  return m.ask > 0 ? m.ask : 0;
}

function sellPx(m: MarketPx): number {
  return m.bid > 0 ? m.bid : 0;
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
    led.mode,
    led.n,
    led.hits,
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
    horizon_s: HORIZON_MS / 1000,
  };
  led.n += 1;
  if (hit) led.hits += 1;
  led.realized_pnl_usd += pnl;
  led.recent.unshift(trade);
  if (led.recent.length > MAX_RECENT) led.recent.pop();
  led.open = null;
  led.pending = null;
  led.updated_ts = now;
}

function flattenTaker(led: Ledger, pos: PaperPosition, m: MarketPx): void {
  if (!hasQuotes(m)) return;
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
      flatten_ts: m.now + HORIZON_MS,
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
      flatten_ts: m.now + HORIZON_MS,
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
    expire_ts: m.now + HORIZON_MS,
    expected_move_bps: signal.expected_move_bps,
  };
  led.last_entry_attempt_ts = m.now;
  led.updated_ts = m.now;
}

function fillMakerEntry(led: Ledger, order: PaperOrder, m: MarketPx): void {
  const horizonEnd = order.placed_ts + HORIZON_MS;
  /* Flatten à l’horizon du signal (placement), pas +5s après le fill. */
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
    horizon_s: HORIZON_MS / 1000,
  };
  led.recent.unshift(trade);
  if (led.recent.length > MAX_RECENT) led.recent.pop();
  led.pending = null;
  led.n_cancelled += 1;
  led.updated_ts = now;
}

function canEnter(led: Ledger, signal: Signal, m: MarketPx): boolean {
  if (led.open || led.pending) return false;
  if (!signal.gated || signal.side === "flat") return false;
  /* Paper = tête 5s uniquement. Un feu 15s ne doit pas ouvrir une position. */
  if ((signal.horizon_s ?? 5) !== HORIZON_MS / 1000) return false;
  const minMove = signal.min_move_bps ?? led.min_move_bps;
  if (!(Math.abs(signal.expected_move_bps) >= minMove - 1e-12)) return false;
  if (led.last_entry_attempt_ts > 0 && m.now - led.last_entry_attempt_ts < HORIZON_MS - 200) {
    return false;
  }
  if (!hasQuotes(m)) return false;
  return true;
}

function enforceOnePosition(led: Ledger): void {
  if (led.open && led.pending?.kind === "entry") led.pending = null;
}

function step(led: Ledger, m: MarketPx, signal: Signal): void {
  if (!(m.now > 0) || !(m.mid > 0)) return;
  led.mark_px = m.mid;
  led.min_move_bps = PAPER_MIN_MOVE_BPS;
  enforceOnePosition(led);

  let freed = false;
  if (led.pending?.kind === "exit" && led.open) {
    const buy = led.open.side === "down";
    if (makerFill(buy ? "buy" : "sell", led.pending.limit_px, m, led.pending.placed_ts)) {
      fillMakerExit(led, led.open, led.pending, m);
      freed = true;
    } else if (m.now >= led.pending.expire_ts && hasQuotes(m)) {
      flattenTaker(led, led.open, m);
      freed = true;
    }
  } else if (led.open && !led.pending) {
    if (m.now >= led.open.flatten_ts && hasQuotes(m)) {
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

function pendingRow(led: Ledger): PaperRow | null {
  if (led.open) {
    return {
      ts: led.open.entry_ts,
      side: led.open.side,
      label: led.open.label,
      mid: led.open.entry_px,
      mid_end: null,
      hit: null,
      signed_bps: null,
      horizon_s: HORIZON_MS / 1000,
      entry_role: led.open.entry_role,
      status: "open",
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
      horizon_s: HORIZON_MS / 1000,
      status: "pending_entry",
    };
  }
  return null;
}

function remainingS(led: Ledger, now: number): number {
  const t = led.open?.flatten_ts ?? (led.pending ? led.pending.expire_ts : 0);
  if (!t) return 0;
  return Math.max(0, (t - now) / 1000);
}

function markPx(led: Ledger, m: MarketPx): number {
  if (m.mid > 0) return m.mid;
  if (led.mark_px > 0) return led.mark_px;
  return 0;
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
  return gross - fee;
}

export function viewPaper(led: Ledger, m: MarketPx, kind: StoreKind): Paper {
  const mid = markPx(led, m);
  const u = unrealizedUsd(led, m);
  const equity = led.open
    ? led.starting_cash_usd + led.realized_pnl_usd + u
    : led.cash_usd + led.btc * (mid || 0);
  const open = pendingRow(led);
  return {
    n: led.n,
    hits: led.hits,
    hit_rate: led.n > 0 ? led.hits / led.n : null,
    pending: open,
    remaining_s: remainingS(led, m.now || led.updated_ts),
    recent: led.recent.map(tradeToRow),
    horizon_s: HORIZON_MS / 1000,
    mode: led.mode,
    cash_usd: led.cash_usd,
    equity_usd: equity,
    realized_pnl_usd: led.realized_pnl_usd,
    unrealized_usd: unrealizedUsd(led, m),
    fees_usd: led.fees_usd,
    starting_cash_usd: led.starting_cash_usd,
    clip_usd: led.clip_usd,
    min_move_bps: led.min_move_bps,
    n_cancelled: led.n_cancelled,
    fee_tier: FEE_TIER_LABEL,
    taker_fee_bps: TAKER_FEE_BPS,
    maker_fee_bps: MAKER_FEE_BPS,
    round_trip_fee_bps: roundTripFeeBps(led.mode),
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
        }
      : null,
    honest:
      "Aucun ordre Coinbase réel. Frais palier 0–10 k$ US (preneur 60 bp / faiseur 40 bp). " +
      "Aller-retour preneur = 120 bp, très au-dessus du |move| 5s typique (~1 bp) : le paper preneur devrait perdre. " +
      "Hit = direction mid/fill sans frais ; le PnL $ soustrait les deux jambes de frais. " +
      "Faiseur = trade-through (pas un touch). Short = notionnel virtuel. " +
      "Un jour vert ici voudrait dire qu’on peut parler live — pas avant.",
  };
}

function hydrate(loaded: Awaited<ReturnType<typeof loadLedger>>, now: number): Ledger {
  if (loaded.ledger && loaded.ledger.v === 1) {
    if (typeof loaded.ledger.mark_px !== "number") loaded.ledger.mark_px = 0;
    return loaded.ledger;
  }
  return emptyLedger(now);
}

let chain: Promise<unknown> = Promise.resolve();

async function transact(mut: (led: Ledger) => void): Promise<{ ledger: Ledger; kind: StoreKind }> {
  let last: { ledger: Ledger; kind: StoreKind } | null = null;
  for (let i = 0; i < 6; i++) {
    const loaded = await loadLedger();
    const created = !(loaded.ledger && loaded.ledger.v === 1);
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

export async function stepPaper(m: MarketPx, signal: Signal): Promise<Paper> {
  const run = chain.then(async () => {
    const { ledger, kind } = await transact((led) => step(led, m, signal));
    return viewPaper(ledger, m, kind);
  });
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function setPaperMode(mode: PaperMode): Promise<Paper> {
  if (mode !== "taker" && mode !== "maker") throw new Error("mode_invalide");
  const { ledger, kind } = await transact((led) => {
    led.mode = mode;
    led.updated_ts = Date.now();
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

export function newLedger(now: number, mode: PaperMode = "taker"): Ledger {
  return emptyLedger(now, mode);
}

export function applyPaperStep(led: Ledger, m: MarketPx, signal: Signal): Ledger {
  step(led, m, signal);
  return led;
}
