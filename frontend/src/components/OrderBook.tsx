import { nfP, nfPrice, type Book, type BookLevel } from "../lib/types";

function DepthRow({
  level,
  maxQ,
  side,
}: {
  level: BookLevel;
  maxQ: number;
  side: "bid" | "ask";
}) {
  const pct = maxQ > 0 ? Math.min(100, (level.q / maxQ) * 100) : 0;
  const color = side === "bid" ? "#3dd68c" : "#f0616d";
  return (
    <div className="relative grid grid-cols-2 px-1 py-[3px] font-mono text-[11px] tabular">
      <div
        className="absolute inset-y-0 right-0 opacity-20"
        style={{ width: `${pct}%`, background: color }}
      />
      <span style={{ color }}>{nfPrice.format(level.p)}</span>
      <span className="text-right text-white/80">{level.q.toFixed(5)}</span>
    </div>
  );
}

export function OrderBook({ book }: { book: Book }) {
  const asks = [...book.asks].reverse();
  const maxQ = Math.max(0, ...book.bids.map((l) => l.q), ...book.asks.map((l) => l.q));
  const obi = book.obi_10;
  const pos = Math.max(-1, Math.min(1, obi));
  const fillW = Math.abs(pos) * 50;
  return (
    <aside className="rounded-xl border border-line bg-card px-4 py-4">
      <div className="text-[11px] tracking-[0.16em] text-muted">CARNET · OBI LIVE</div>
      <div className="mt-4 text-[11px] text-muted">Inclinaison</div>
      <div className="relative mt-1 h-2 rounded-full bg-white/8">
        <div className="absolute left-1/2 top-0 h-full w-px bg-white/30" />
        <div
          className="absolute top-0 h-full rounded-full"
          style={{
            left: pos >= 0 ? "50%" : `${50 - fillW}%`,
            width: `${fillW}%`,
            background: pos >= 0 ? "#3dd68c" : "#f0616d",
          }}
        />
      </div>
      <div className="mt-1 flex justify-between text-[10px] uppercase tracking-wide">
        <span className="text-up">achat</span>
        <span className="text-down">vente</span>
      </div>
      <div className="mt-3">
        <div className="text-[11px] text-muted">OBI 10</div>
        <div className={`font-mono text-xl tabular ${obi >= 0 ? "text-up" : "text-down"}`}>
          {nfP.format(obi)}
        </div>
      </div>
      <div className="mt-4 space-y-0.5">
        {asks.map((l) => (
          <DepthRow key={`a-${l.p}`} level={l} maxQ={maxQ} side="ask" />
        ))}
        <div className="py-2 text-center font-mono text-sm text-white tabular">
          {book.mid ? nfPrice.format(book.mid) : "—"}
        </div>
        {book.bids.map((l) => (
          <DepthRow key={`b-${l.p}`} level={l} maxQ={maxQ} side="bid" />
        ))}
      </div>
      <div className="mt-4 text-[10px] text-muted">
        spread {nfP.format(book.spread_bps)} bps
      </div>
    </aside>
  );
}
