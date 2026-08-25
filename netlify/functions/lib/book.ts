import type { CoinbaseBook } from "./predictor/coinbase";
import type { Book, BookLevel } from "./types";

function levels(rows: [string, string, number][], n: number): BookLevel[] {
  return rows.slice(0, n).map(([p, q]) => ({ p: +p, q: +q }));
}

export function bookFromDepth(depth: CoinbaseBook, nObi = 10, nShow = 5): Book {
  const bidsAll = levels(depth.bids ?? [], nObi);
  const asksAll = levels(depth.asks ?? [], nObi);
  const bid1 = bidsAll[0]?.p ?? 0;
  const ask1 = asksAll[0]?.p ?? 0;
  const mid = bid1 > 0 && ask1 > 0 ? (bid1 + ask1) / 2 : bid1 || ask1;
  const spread_bps = mid > 0 && bid1 > 0 && ask1 > 0 ? ((ask1 - bid1) / mid) * 1e4 : 0;

  let bidQty = 0;
  let askQty = 0;
  for (const l of bidsAll) bidQty += l.q;
  for (const l of asksAll) askQty += l.q;
  const den = bidQty + askQty;
  const obi_10 = den > 0 ? (bidQty - askQty) / den : 0;

  let tilt: Book["tilt"] = "neutre";
  if (obi_10 > 0.04) tilt = "achat";
  else if (obi_10 < -0.04) tilt = "vente";

  return {
    mid,
    obi_10,
    tilt,
    bids: bidsAll.slice(0, nShow),
    asks: asksAll.slice(0, nShow),
    spread_bps,
  };
}
