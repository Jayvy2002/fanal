/**
 * Backtest paper Poly : fair value TWAP-proxy vs CLOB, E[USDC] après frais taker.
 *
 * Honest limitations :
 * - TWAP/strike = Coinbase 1m (pas le flux officiel Chainlink — pas d’historique RTDS)
 * - CLOB prices-history = last/mid, ask = p + 1 ¢, bid = p − 1 ¢
 * - Une position / slot, clip 25, redeem $1/$0 (sauf scalp optionnel)
 *
 * Run : npx tsx train/backtest_poly.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cryptoTakerFeeUsdc, intraRoundTripPnl, redeemPnl } from "../netlify/functions/lib/polymarket/fees";
import { minExitMid } from "../netlify/functions/lib/polymarket/fees";
import {
  CLIP_DEFAULT,
  decideFair,
  MID_BAND_MIN_EV_USDC,
  MIN_EV_USDC,
  SPREAD_PAD_DEFAULT,
  type FairOverrides,
} from "../netlify/functions/lib/predictor/fairvalue";

type Candle = [number, number, number, number, number, number];
type HistPt = { t: number; p: number };
type Market = {
  asset: "BTC" | "ETH";
  slot: number;
  winner: "up" | "down" | null;
  history: HistPt[];
};
type Payload = {
  hours: number;
  start_slot: number;
  end_slot: number;
  n_markets: number;
  markets: Market[];
  candles: Record<string, Candle[]>;
};

const ASK_PAD = 0.01;
const ROOT = path.resolve(import.meta.dirname, "..");
const HIST = path.join(ROOT, "data/poly/history.json");
const OUT = path.join(ROOT, "netlify/functions/lib/predictor/_models/poly_test.json");

function closeMap(rows: Candle[]): Map<number, { o: number; c: number }> {
  const m = new Map<number, { o: number; c: number }>();
  for (const [t, , , o, c] of rows) {
    if (c > 0) m.set(Number(t), { o, c });
  }
  return m;
}

function closesAtOrBefore(m: Map<number, { o: number; c: number }>, t: number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n + 5 && out.length < n; i++) {
    const ts = t - i * 60;
    const row = m.get(ts);
    if (row) out.push(row.c);
  }
  return out.reverse();
}

function rvOf(closes: number[]): number {
  if (closes.length < 4) return 0.001;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (!rets.length) return 0.001;
  const mu = rets.reduce((a, b) => a + b, 0) / rets.length;
  let s = 0;
  for (const r of rets) s += (r - mu) ** 2;
  return Math.max(Math.sqrt(s / rets.length), 1e-6);
}

function lastClose(m: Map<number, { o: number; c: number }>, t: number): number | null {
  for (let i = 0; i < 8; i++) {
    const row = m.get(t - i * 60);
    if (row) return row.c;
  }
  return null;
}

/** Dernière close 1 m *complète* à l’instant t (pas la bougie en cours). */
function lastCompletedClose(m: Map<number, { o: number; c: number }>, tSec: number): number | null {
  const lastStart = Math.floor((tSec - 60) / 60) * 60;
  return lastClose(m, lastStart);
}

type Trade = {
  asset: string;
  slot: number;
  side: "up" | "down";
  ask: number;
  pnl: number;
  win: boolean;
  strat: string;
};

type Cfg = FairOverrides & {
  name: string;
  lock_only?: boolean;
  scalp?: boolean;
  maker?: boolean;
};

function simulate(
  payload: Payload,
  cfg: Cfg,
  assetFilter?: "BTC" | "ETH",
): { trades: Trade[]; slots: number; naive: Trade[] } {
  const trades: Trade[] = [];
  const naive: Trade[] = [];
  let slots = 0;
  const pad = cfg.spread_pad ?? SPREAD_PAD_DEFAULT;
  const clip = cfg.clip_usdc ?? CLIP_DEFAULT;

  for (const mkt of payload.markets) {
    if (assetFilter && mkt.asset !== assetFilter) continue;
    const symbol = mkt.asset === "ETH" ? "ETH-USD" : "BTC-USD";
    const cmap = closeMap(payload.candles[symbol] ?? []);
    /* Strike connu à l’open = close de la dernière barre complète (pas l’open de la bougie en cours). */
    const strike = lastCompletedClose(cmap, mkt.slot);
    if (strike == null) continue;
    const hist = [...(mkt.history ?? [])].filter((h) => h.p > 0 && h.p < 1).sort((a, b) => a.t - b.t);
    if (hist.length < 2) continue;

    let winner = mkt.winner;
    if (!winner) {
      const endC = lastCompletedClose(cmap, mkt.slot + 300);
      if (endC == null) continue;
      winner = endC >= strike ? "up" : "down";
    }
    slots += 1;

    /* Naive : take favorite au 1er print, hold to res, 1 frais. */
    const p0 = hist[0].p;
    const naiveSide: "up" | "down" = p0 >= 0.5 ? "up" : "down";
    const naiveP = naiveSide === "up" ? p0 : 1 - p0;
    const naiveAsk = Math.min(0.99, naiveP + ASK_PAD);
    const nShares = clip / naiveAsk;
    const nWin = naiveSide === winner;
    const nPnl = redeemPnl(nShares, naiveAsk, nWin).pnl;
    naive.push({ asset: mkt.asset, slot: mkt.slot, side: naiveSide, ask: naiveAsk, pnl: nPnl, win: nWin, strat: "naive" });

    let taken = false;
    for (let i = 0; i < hist.length; i++) {
      const h = hist[i];
      const remaining = mkt.slot + 300 - h.t;
      if (cfg.lock_only && remaining > 60) continue;
      if (remaining < 8 || remaining > 300) continue;
      const twap = lastCompletedClose(cmap, h.t);
      if (twap == null) continue;
      const lastBar = Math.floor((h.t - 60) / 60) * 60;
      const closes = closesAtOrBefore(cmap, lastBar, 16);
      const rv = Math.max(rvOf(closes), 0.0005);
      const pUp = h.p;
      const upAsk = cfg.maker ? Math.max(0.01, pUp - ASK_PAD) : Math.min(0.99, pUp + ASK_PAD);
      const upBid = Math.max(0.01, pUp - ASK_PAD);
      const downAsk = cfg.maker ? Math.max(0.01, 1 - pUp - ASK_PAD) : Math.min(0.99, 1 - pUp + ASK_PAD);
      const downBid = Math.max(0.01, 1 - pUp - ASK_PAD);

      if (cfg.maker) {
        /* Fill seulement si le print suivant traverse le bid (pas de lookahead sur le fill). */
        const nxt = hist[i + 1];
        if (!nxt) continue;
        const dec = decideFair({
          remaining_s: remaining,
          twap,
          strike,
          twap_stale: false,
          has_strike: true,
          strike_late: false,
          rv_1m: rv,
          up_ask: upAsk,
          up_bid: upBid,
          down_ask: downAsk,
          down_bid: downBid,
          spread_pad: pad,
          clip_usdc: clip,
          min_ev_usdc: cfg.min_ev_usdc,
          mid_band_min_ev_usdc: cfg.mid_band_min_ev_usdc,
          wings_only: cfg.wings_only,
          cheap_only: cfg.cheap_only,
          min_gap: cfg.min_gap,
        });
        if (!dec.fire || dec.side === "flat") continue;
        const thru = dec.side === "up" ? nxt.p <= upAsk + 1e-9 : 1 - nxt.p <= downAsk + 1e-9;
        if (!thru) continue;
        const win = dec.side === winner;
        const { pnl } = redeemPnl(dec.shares, dec.ask, win);
        trades.push({
          asset: mkt.asset,
          slot: mkt.slot,
          side: dec.side,
          ask: dec.ask,
          pnl,
          win,
          strat: "maker",
        });
        taken = true;
        break;
      }

      const dec = decideFair({
        remaining_s: remaining,
        twap,
        strike,
        twap_stale: false,
        has_strike: true,
        strike_late: false,
        rv_1m: rv,
        up_ask: upAsk,
        up_bid: upBid,
        down_ask: downAsk,
        down_bid: downBid,
        spread_pad: pad,
        clip_usdc: clip,
        min_ev_usdc: cfg.min_ev_usdc,
        mid_band_min_ev_usdc: cfg.mid_band_min_ev_usdc,
        wings_only: cfg.wings_only,
        cheap_only: cfg.cheap_only,
        min_gap: cfg.min_gap,
      });
      if (!dec.fire || dec.side === "flat") continue;

      if (cfg.scalp && remaining > 60) {
        const minMid = minExitMid(dec.ask, dec.shares, 0.02);
        let exited = false;
        for (let j = i + 1; j < hist.length; j++) {
          const rem2 = mkt.slot + 300 - hist[j].t;
          const pSide = dec.side === "up" ? hist[j].p : 1 - hist[j].p;
          const mid = pSide;
          const bid = Math.max(0.01, pSide - ASK_PAD);
          if (mid >= minMid && bid > 0) {
            const { pnl } = intraRoundTripPnl(dec.shares, dec.ask, bid);
            trades.push({
              asset: mkt.asset,
              slot: mkt.slot,
              side: dec.side,
              ask: dec.ask,
              pnl,
              win: pnl > 0,
              strat: "scalp",
            });
            exited = true;
            break;
          }
          if (rem2 <= 60) break;
        }
        if (!exited) {
          const win = dec.side === winner;
          const { pnl } = redeemPnl(dec.shares, dec.ask, win);
          trades.push({
            asset: mkt.asset,
            slot: mkt.slot,
            side: dec.side,
            ask: dec.ask,
            pnl,
            win,
            strat: "intra_hold",
          });
        }
      } else {
        const win = dec.side === winner;
        const { pnl } = redeemPnl(dec.shares, dec.ask, win);
        trades.push({
          asset: mkt.asset,
          slot: mkt.slot,
          side: dec.side,
          ask: dec.ask,
          pnl,
          win,
          strat: dec.strat ?? "hold",
        });
      }
      taken = true;
      break;
    }
    void taken;
  }
  return { trades, slots, naive };
}

function stats(trades: Trade[], slots: number) {
  const n = trades.length;
  const wins = trades.filter((t) => t.win).length;
  const sum = trades.reduce((a, t) => a + t.pnl, 0);
  return {
    n,
    coverage: slots > 0 ? n / slots : 0,
    win_rate: n > 0 ? wins / n : null,
    e_usdc: n > 0 ? sum / n : null,
    sum_usdc: sum,
    slots,
  };
}

function asTest(
  s: ReturnType<typeof stats>,
  naive: ReturnType<typeof stats>,
  clip: number,
  pad: number,
) {
  return {
    n: s.n,
    coverage: s.coverage,
    win_rate: s.win_rate,
    e_usdc: s.e_usdc,
    naive_n: naive.n,
    naive_win_rate: naive.win_rate,
    naive_e_usdc: naive.e_usdc,
    clip_usdc: clip,
    spread_pad: pad,
    gated_acc: s.win_rate,
    naive_last_acc: naive.win_rate ?? 0.5,
    mean_abs_move_bps: null,
    expectancy_1bp: null,
    expectancy_2bp: null,
  };
}

const CFGS: Cfg[] = [
  { name: "default_gap12_ev50", spread_pad: 0.015, min_ev_usdc: 0.5, min_gap: 0.12, mid_band_min_ev_usdc: 0.75 },
  { name: "gap15_ev75", spread_pad: 0.02, min_ev_usdc: 0.75, min_gap: 0.15, mid_band_min_ev_usdc: 1.0 },
  { name: "gap20_ev100", spread_pad: 0.02, min_ev_usdc: 1.0, min_gap: 0.2, mid_band_min_ev_usdc: 1.5 },
  { name: "cheap30_gap10", cheap_only: true, spread_pad: 0.015, min_ev_usdc: 0.4, min_gap: 0.1 },
  { name: "cheap30_gap15", cheap_only: true, spread_pad: 0.02, min_ev_usdc: 0.6, min_gap: 0.15 },
  { name: "wings_gap15", wings_only: true, spread_pad: 0.015, min_ev_usdc: 0.5, min_gap: 0.15 },
  { name: "lock_gap15", lock_only: true, spread_pad: 0.02, min_ev_usdc: 0.5, min_gap: 0.15, mid_band_min_ev_usdc: 1.0 },
  { name: "lock_cheap", lock_only: true, cheap_only: true, spread_pad: 0.015, min_ev_usdc: 0.4, min_gap: 0.1 },
  { name: "scalp_gap15", scalp: true, spread_pad: 0.02, min_ev_usdc: 0.75, min_gap: 0.15 },
  { name: "maker_cheap", maker: true, cheap_only: true, spread_pad: 0.01, min_ev_usdc: 0.3, min_gap: 0.08 },
];

function main() {
  const payload = JSON.parse(readFileSync(HIST, "utf8")) as Payload;
  console.log(`history slots=${payload.n_markets} hours=${payload.hours}`);
  const rows: {
    name: string;
    asset: string;
    e_usdc: number | null;
    n: number;
    win_rate: number | null;
    coverage: number;
    sum: number;
  }[] = [];

  for (const cfg of CFGS) {
    for (const asset of [undefined, "BTC", "ETH"] as const) {
      const { trades, slots, naive } = simulate(payload, cfg, asset);
      const s = stats(trades, slots);
      const label = asset ?? "BOTH";
      rows.push({
        name: cfg.name,
        asset: label,
        e_usdc: s.e_usdc,
        n: s.n,
        win_rate: s.win_rate,
        coverage: s.coverage,
        sum: s.sum_usdc,
      });
      const wr = s.win_rate == null ? "—" : (s.win_rate * 100).toFixed(1);
      const e = s.e_usdc == null ? "—" : s.e_usdc.toFixed(3);
      console.log(
        `${cfg.name.padEnd(24)} ${label.padEnd(4)} n=${String(s.n).padStart(4)} cov=${(s.coverage * 100).toFixed(1).padStart(5)}% wr=${wr.padStart(5)}% E=${e.padStart(8)} sum=${s.sum_usdc.toFixed(1)}`,
      );
      if (!asset) {
        const ns = stats(naive, slots);
        console.log(
          `${"naive_favorite".padEnd(24)} BOTH n=${String(ns.n).padStart(4)} cov=${(ns.coverage * 100).toFixed(1).padStart(5)}% wr=${((ns.win_rate ?? 0) * 100).toFixed(1).padStart(5)}% E=${(ns.e_usdc ?? 0).toFixed(3).padStart(8)} sum=${ns.sum_usdc.toFixed(1)}`,
        );
      }
    }
  }

  const both = rows.filter((r) => r.asset === "BOTH" && r.n >= 5);
  const plus = both.filter((r) => (r.e_usdc ?? 0) > 0 && r.coverage <= 0.25);
  const selective = both.filter((r) => r.coverage <= 0.2);
  plus.sort((a, b) => (b.e_usdc ?? -999) - (a.e_usdc ?? -999));
  selective.sort((a, b) => (b.e_usdc ?? -999) - (a.e_usdc ?? -999));
  both.sort((a, b) => (b.e_usdc ?? -999) - (a.e_usdc ?? -999));
  const best = plus[0] ?? selective[0] ?? both[0];
  console.log("\nBEST BOTH:", best);

  const bestCfg = CFGS.find((c) => c.name === best?.name) ?? CFGS[0];
  const btc = simulate(payload, bestCfg, "BTC");
  const eth = simulate(payload, bestCfg, "ETH");
  const all = simulate(payload, bestCfg);
  const naiveS = stats(all.naive, all.slots);
  const btcS = stats(btc.trades, btc.slots);
  const ethS = stats(eth.trades, eth.slots);
  const allS = stats(all.trades, all.slots);

  const dropWorse = (btcS.e_usdc ?? 0) < (ethS.e_usdc ?? 0) ? "BTC" : "ETH";
  const keepS = dropWorse === "BTC" ? ethS : btcS;
  const keepAsset = dropWorse === "BTC" ? "ETH" : "BTC";
  const keep = dropWorse === "BTC" ? eth : btc;

  const useKeep = keepS.n >= 8 && (keepS.e_usdc ?? -999) > (allS.e_usdc ?? -999) + 0.25;
  const finalTrades = useKeep ? keep.trades : all.trades;
  const finalSlots = useKeep ? keep.slots : all.slots;
  const finalNaive = useKeep ? keep.naive : all.naive;
  const finalS = stats(finalTrades, finalSlots);
  const finalN = stats(finalNaive, finalSlots);
  const pad = bestCfg.spread_pad ?? SPREAD_PAD_DEFAULT;

  const e = finalS.e_usdc;
  const blocked =
    e != null && e > 0
      ? null
      : "CLOB déjà informé (proxy Coinbase 1m ≠ TWAP Chainlink live) + frais taker p(1-p) + pad 1–2 ¢. On n’est pas avant le livre ; le naive « take favorite » n’est pas un edge non plus après friction réaliste.";

  const file = {
    asof: new Date().toISOString().slice(0, 10),
    note:
      "TWAP/strike = proxy Coinbase 1m (pas l’historique officiel Chainlink). CLOB = prices-history last/mid + 1 ¢ ask pad. Redeem $1/$0, 1 frais taker (2 si scalp). Clip 25 USDC. Une position / slot.",
    best_name: useKeep ? `${bestCfg.name} [${keepAsset} only]` : bestCfg.name,
    blocked_by: blocked,
    hours: payload.hours,
    n_slots: finalSlots,
    trade_assets: useKeep ? [keepAsset] : ["BTC", "ETH"],
    combined: asTest(finalS, finalN, CLIP_DEFAULT, pad),
    by_symbol: {
      "BTC-USD": asTest(btcS, stats(btc.naive, btc.slots), CLIP_DEFAULT, pad),
      "ETH-USD": asTest(ethS, stats(eth.naive, eth.slots), CLIP_DEFAULT, pad),
    },
    naive: asTest(finalN, finalN, CLIP_DEFAULT, pad),
    configs: both.map((r) => ({
      name: r.name,
      e_usdc: r.e_usdc,
      n: r.n,
      win_rate: r.win_rate,
      coverage: r.coverage,
    })),
  };
  writeFileSync(OUT, JSON.stringify(file, null, 2));
  console.log("wrote", OUT);
  console.log(JSON.stringify({ best: file.best_name, e_usdc: file.combined.e_usdc, n: file.combined.n, naive_e: file.combined.naive_e_usdc, blocked }, null, 2));
}

void cryptoTakerFeeUsdc;
void MID_BAND_MIN_EV_USDC;
void MIN_EV_USDC;
main();
