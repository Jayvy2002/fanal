/**
 * Backtest paper MM two-sided vs naive one-sided.
 * CLOB prices-history = last/mid ; bid/ask = ±1 ¢. Pas de carnet L2 historique.
 * Run : npx tsx train/backtest_mm.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cryptoTakerFeeUsdc } from "../netlify/functions/lib/polymarket/fees";
import {
  makerBidFills,
  planQuotes,
  takerLockOk,
  tickRound,
} from "../netlify/functions/lib/polymarket/mm";
import type { MmQuote } from "../netlify/functions/lib/polymarket/mmtypes";
import type { PairBook, SideBook } from "../netlify/functions/lib/polymarket/clob";

type HistPt = { t: number; p: number };
type Market = {
  asset: "BTC" | "ETH";
  slot: number;
  winner: "up" | "down" | null;
  history: HistPt[];
};
type Payload = { hours: number; n_markets: number; markets: Market[] };

const ASK_PAD = 0.01;
const CLIP = 8;
const ROOT = path.resolve(import.meta.dirname, "..");
const HIST = path.join(ROOT, "data/poly/history.json");
const OUT = path.join(ROOT, "netlify/functions/lib/predictor/_models/mm_test.json");

function side(p: number): SideBook {
  const mid = Math.min(0.99, Math.max(0.01, p));
  const bid = tickRound(Math.max(0.01, mid - ASK_PAD));
  const ask = tickRound(Math.min(0.99, mid + ASK_PAD));
  return { bid, ask, mid, spread: ask - bid, bids: [], asks: [] };
}

function bookAt(pUp: number): PairBook {
  const up = side(pUp);
  const down = side(1 - pUp);
  return { up, down };
}

function qFrom(plan: { bid: number; shares: number }, side: "up" | "down", book: SideBook, ts: number): MmQuote {
  return {
    id: `${side}-${ts}`,
    asset: "BTC",
    slug: "bt",
    slot_start_s: 0,
    side,
    bid: plan.bid,
    shares: plan.shares,
    placed_ts: ts,
    placed_ask: book.ask,
    placed_mid: book.mid,
    placed_bid: book.bid,
  };
}

type Row = { pnl: number; pair: number | null; kind: string; asset: string };

function simulateMaker(mkt: Market): Row | null {
  if (!mkt.winner || mkt.history.length < 3) return null;
  const hist = [...mkt.history].sort((a, b) => a.t - b.t);
  let invU = 0;
  let invD = 0;
  let costU = 0;
  let costD = 0;
  let fees = 0;
  let qUp: MmQuote | null = null;
  let qDn: MmQuote | null = null;
  let nMaker = 0;
  let nTaker = 0;

  for (let i = 0; i < hist.length; i++) {
    const pt = hist[i];
    const tMs = pt.t * 1000;
    const book = bookAt(pt.p);
    const elapsed = pt.t - mkt.slot;
    if (elapsed < 5 || elapsed > 290) continue;

    if (invU === 0 && invD === 0 && takerLockOk(book.up.ask, book.down.ask) && nTaker === 0) {
      const plan = planQuotes(book, CLIP, null);
      if (plan.taker) {
        const sh = plan.taker.shares;
        const fu = cryptoTakerFeeUsdc(sh, plan.taker.ask_up);
        const fd = cryptoTakerFeeUsdc(sh, plan.taker.ask_down);
        invU += sh;
        invD += sh;
        costU += sh * plan.taker.ask_up + fu;
        costD += sh * plan.taker.ask_down + fd;
        fees += fu + fd;
        nTaker += 1;
        continue;
      }
    }

    if (qUp && makerBidFills(qUp, book.up, tMs) && invU === 0) {
      invU += qUp.shares;
      costU += qUp.shares * qUp.bid;
      nMaker += 1;
      qUp = null;
    }
    if (qDn && makerBidFills(qDn, book.down, tMs) && invD === 0) {
      invD += qDn.shares;
      costD += qDn.shares * qDn.bid;
      nMaker += 1;
      qDn = null;
    }

    if (invU > 0 && invD > 0) break;

    const plan = planQuotes(book, CLIP, null);
    if (!qUp && plan.up && invU === 0) qUp = qFrom(plan.up, "up", book.up, tMs);
    if (!qDn && plan.down && invD === 0) qDn = qFrom(plan.down, "down", book.down, tMs);
  }

  const last = hist[hist.length - 1];
  const lastBook = bookAt(last.p);
  const matched = Math.min(invU, invD);
  const avgU = costU / Math.max(invU, 1e-12);
  const avgD = costD / Math.max(invD, 1e-12);
  let pnl = 0;
  let pair: number | null = null;
  if (matched > 0) {
    const paired = matched * (avgU + avgD);
    pair = paired / matched;
    pnl += matched - paired;
  }
  const nakedU = invU - matched;
  const nakedD = invD - matched;
  if (nakedU > 0) {
    const bid = lastBook.up.bid;
    const fee = cryptoTakerFeeUsdc(nakedU, bid);
    pnl += nakedU * bid - fee - avgU * nakedU;
  }
  if (nakedD > 0) {
    const bid = lastBook.down.bid;
    const fee = cryptoTakerFeeUsdc(nakedD, bid);
    pnl += nakedD * bid - fee - avgD * nakedD;
  }
  if (matched <= 0 && nakedU <= 0 && nakedD <= 0) return null;
  return {
    pnl,
    pair,
    kind: nTaker ? "taker" : "maker",
    asset: mkt.asset,
  };
}

function simulateNaive(mkt: Market): Row | null {
  if (!mkt.winner || mkt.history.length < 2) return null;
  const hist = [...mkt.history].sort((a, b) => a.t - b.t);
  const pt = hist.find((x) => x.t >= mkt.slot + 8) ?? hist[0];
  const book = bookAt(pt.p);
  const fav: "up" | "down" = book.up.ask <= book.down.ask ? "up" : "down";
  const ask = fav === "up" ? book.up.ask : book.down.ask;
  const sh = CLIP / ask;
  const fee = cryptoTakerFeeUsdc(sh, ask);
  const win = fav === mkt.winner;
  const pnl = (win ? sh : 0) - sh * ask - fee;
  return { pnl, pair: null, kind: "naive", asset: mkt.asset };
}

function stats(rows: Row[]) {
  if (!rows.length) return { n: 0, e: null as number | null, mean_pair: null as number | null };
  const e = rows.reduce((s, r) => s + r.pnl, 0) / rows.length;
  const pairs = rows.filter((r) => r.pair != null).map((r) => r.pair as number);
  return {
    n: rows.length,
    e,
    mean_pair: pairs.length ? pairs.reduce((a, b) => a + b, 0) / pairs.length : null,
  };
}

function main(): void {
  let payload: Payload;
  try {
    payload = JSON.parse(readFileSync(HIST, "utf8")) as Payload;
  } catch {
    console.error("pas de data/poly/history.json — lancer python3 train/fetch_poly_history.py");
    process.exit(1);
  }
  const btc = payload.markets.filter((m) => m.asset === "BTC");
  const mm: Row[] = [];
  const naive: Row[] = [];
  for (const m of btc) {
    const a = simulateMaker(m);
    if (a) mm.push(a);
    const n = simulateNaive(m);
    if (n) naive.push(n);
  }
  const matchedRows = mm.filter((r) => r.pair != null);
  const sMm = stats(mm);
  const sMatch = stats(matchedRows);
  const sNv = stats(naive);
  const nTaker = mm.filter((r) => r.kind === "taker").length;
  const nMaker = mm.filter((r) => r.kind === "maker").length;
  const out = {
    n: sMm.n,
    e_usdc: sMm.e,
    e_matched_usdc: sMatch.e,
    n_matched: sMatch.n,
    naive_e_usdc: sNv.e,
    naive_n: sNv.n,
    coverage: btc.length ? sMatch.n / btc.length : 0,
    mean_pair: sMatch.mean_pair,
    n_taker: nTaker,
    n_maker: nMaker,
    lean_skipped: "ratio 1,0–1,5× skippé ; live = pair 1:1 maker",
    note:
      "BTC 5 m, 18 h. prices-history last/mid ±1 ¢. E primaire = tous les slots (scratch nues inclus). " +
      "E apparié seul est un sous-ensemble. Bonereaper sub-seconde ≠ ce régime. Pas une promesse.",
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

main();
