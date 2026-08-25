import { nfP, type Book, type BookLevel } from "../lib/types";

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
      <span style={{ color }}>{level.p.toFixed(2)}</span>
      <span className="text-right text-white/80">{level.q.toFixed(4)}</span>
    </div>
  );
}

export function OrderBook({ book }: { book: Book }) {
  const asks = [...book.asks].reverse();
  const maxQ = Math.max(0, ...book.bids.map((l) => l.q), ...book.asks.map((l) => l.q));
  return (
    <aside className="rounded-xl border border-line bg-card px-4 py-4">
      <div className="text-[11px] tracking-[0.16em] text-muted">COINBASE · L2 public</div>
      <div className="mt-3 space-y-0.5">
        {asks.map((l) => (
          <DepthRow key={`a-${l.p}`} level={l} maxQ={maxQ} side="ask" />
        ))}
        <div className="py-2 text-center font-mono text-sm text-white tabular">
          {book.mid ? book.mid.toFixed(2) : "—"}
        </div>
        {book.bids.map((l) => (
          <DepthRow key={`b-${l.p}`} level={l} maxQ={maxQ} side="bid" />
        ))}
      </div>
      <div className="mt-3 text-[10px] text-muted">spread {nfP.format(book.spread_bps)} bps · features live</div>
    </aside>
  );
}
