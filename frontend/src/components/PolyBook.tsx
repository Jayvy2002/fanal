import { nfP, type LiveResponse } from "../lib/types";

export function PolyBook({ live }: { live: LiveResponse }) {
  const mkt = (live.poly.markets ?? []).find((x) => live.symbol.startsWith(x.market.asset));
  if (!mkt) {
    return (
      <aside className="rounded-xl border border-line bg-card px-4 py-4">
        <div className="text-[11px] tracking-[0.16em] text-muted">CLOB POLYMARKET · ÉTEINT</div>
        <div className="mt-4 text-sm text-muted">Lecture publique seulement — le paper n’envoie aucun ordre.</div>
      </aside>
    );
  }
  const up = mkt.book.up;
  const down = mkt.book.down;
  return (
    <aside className="rounded-xl border border-line bg-card px-4 py-4">
      <div className="text-[11px] tracking-[0.16em] text-muted">CLOB · {mkt.market.asset} · lecture · OFF</div>
      <div className="mt-2 text-[11px] text-muted truncate">{mkt.market.slug}</div>
      <Side title="Up" book={up} color="#3dd68c" />
      <Side title="Down" book={down} color="#f0616d" />
      <div className="mt-3 text-[10px] leading-relaxed text-muted">
        Carnet public. Paper éteint — pas de take, pas de lock.
      </div>
    </aside>
  );
}

function Side({
  title,
  book,
  color,
}: {
  title: string;
  book: { bid: number; ask: number; mid: number; asks: { price: number; size: number }[]; bids: { price: number; size: number }[] };
  color: string;
}) {
  return (
    <div className="mt-4">
      <div className="flex justify-between text-[12px]" style={{ color }}>
        <span>{title}</span>
        <span className="font-mono tabular">
          {nfP.format(book.bid)} / {nfP.format(book.ask)}
        </span>
      </div>
      <div className="mt-1 space-y-0.5 font-mono text-[11px] tabular">
        {book.asks.slice(0, 3).map((l) => (
          <div key={`a-${l.price}`} className="flex justify-between text-down">
            <span>{nfP.format(l.price)}</span>
            <span className="text-white/70">{l.size.toFixed(0)}</span>
          </div>
        ))}
        {book.bids.slice(0, 3).map((l) => (
          <div key={`b-${l.price}`} className="flex justify-between text-up">
            <span>{nfP.format(l.price)}</span>
            <span className="text-white/70">{l.size.toFixed(0)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
