import { fmtCd, nfBps, nfP, nfPrice, signalColor, type LiveResponse } from "../lib/types";

export function Hero({ live }: { live: LiveResponse }) {
  const signal = live.predict.intra;
  const slot = live.predict.slot;
  const color = signalColor(signal.label);
  const mkt = live.poly.markets.find((x) => live.symbol.startsWith(x.market.asset));
  return (
    <section
      className="relative overflow-hidden rounded-xl border bg-card px-5 py-4"
      style={{
        borderColor: `${color}55`,
        boxShadow: `0 0 36px ${color}18, inset 0 0 28px ${color}0a`,
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-[11px] font-medium tracking-[0.18em] text-muted">
            PRÉDICTEUR · {live.symbol} · intra {signal.horizon_s}s
          </div>
          <div className="mt-1 font-sans text-4xl font-semibold tracking-wide sm:text-5xl" style={{ color }}>
            {signal.label}
          </div>
          <div className="mt-1 text-[12px] text-muted">
            {signal.fire ? "feu — le bot paper peut entrer en intra" : "silence — le bot intra ne fait rien"}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          <Metric label="Confiance" value={`${nfPrice.format(signal.confidence * 100)} %`} />
          <Metric label="P(↑) intra" value={nfP.format(signal.p_up)} />
          <Metric label="|move| prévu" value={`${nfBps.format(Math.abs(signal.expected_move_bps))} bp`} />
          <Metric
            label="Créneau 5 m"
            value={mkt ? fmtCd(mkt.market.remaining_s) : "—"}
          />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[12px] text-white/80 tabular">
        <span>
          spot {nfPrice.format(signal.close)}{" "}
          <span className="text-gold">{nfBps.format(signal.expected_move_bps)} bps</span>
        </span>
        <span className="text-muted">
          slot 5 m : {slot.label} · P(↑) {nfP.format(slot.p_up)} · feu {slot.fire ? "oui" : "non"}
        </span>
        <span className="text-muted">
          τ {nfP.format(signal.tau)} · min |move| {nfPrice.format(signal.min_edge_bps)} bp
        </span>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] tracking-wide text-muted">{label}</div>
      <div className="font-mono text-lg text-white tabular">{value}</div>
    </div>
  );
}
