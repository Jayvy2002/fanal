import { nfPct, nfPrice, type TickerResponse } from "../lib/types";

function Shield() {
  return (
    <svg viewBox="0 0 32 32" className="h-8 w-8 shrink-0" aria-hidden>
      <path
        fill="#c8a46a"
        d="M16 2.5 27 7v8.2c0 6.3-4.2 11.7-11 13.8C9.2 26.9 5 21.5 5 15.2V7l11-4.5z"
      />
    </svg>
  );
}

export function Header({
  ticker,
  symbol,
  onSymbol,
  fire,
  fallbackPrice,
}: {
  ticker: TickerResponse | null;
  symbol: "BTC-USD" | "ETH-USD";
  onSymbol: (s: "BTC-USD" | "ETH-USD") => void;
  fire: boolean;
  fallbackPrice: number;
}) {
  const last = ticker?.last || fallbackPrice;
  const chg = ticker?.change_pct ?? 0;
  const up = chg >= 0;
  return (
    <header className="grid grid-cols-1 items-center gap-4 border-b border-line px-5 py-3 lg:grid-cols-[1fr_auto_1fr]">
      <div className="flex items-center gap-3">
        <Shield />
        <div>
          <div className="text-[15px] font-semibold tracking-[0.22em] text-white">FANAL</div>
          <div className="text-[11px] tracking-wide text-muted">paper MM 5 m · prédicteur 1 h / 4 h (jouet)</div>
        </div>
      </div>
      <div className="flex items-baseline justify-center gap-3">
        <div className="font-mono text-3xl font-semibold tracking-tight text-white tabular sm:text-4xl">
          {last ? nfPrice.format(last) : "—"}
        </div>
        <div className={`font-mono text-sm tabular ${up ? "text-up" : "text-down"}`}>
          {ticker ? `${nfPct.format(chg)} %` : ""}
        </div>
      </div>
      <div className="flex items-center justify-end gap-2">
        <div className="flex rounded-full border border-line p-0.5 text-[12px]">
          {(["BTC-USD", "ETH-USD"] as const).map((s) => (
            <button
              key={s}
              type="button"
              className={`rounded-full px-3 py-1 ${symbol === s ? "bg-gold/20 text-gold" : "text-muted"}`}
              onClick={() => onSymbol(s)}
            >
              {s.replace("-USD", "")}
            </button>
          ))}
        </div>
        <div
          className={`rounded-full border px-3 py-1 font-mono text-[11px] tracking-wide ${
            fire ? "border-up/50 text-up" : "border-gold/50 text-gold"
          }`}
        >
          {fire ? "MM ON" : "MM …"}
        </div>
      </div>
    </header>
  );
}
