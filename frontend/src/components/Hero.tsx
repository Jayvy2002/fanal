import {
  fmtCd,
  nfP,
  nfPct,
  nfPrice,
  signalColor,
  type LiveResponse,
} from "../lib/types";

export function Hero({ live }: { live: LiveResponse }) {
  const { signal, paper, flux } = live;
  const color = signalColor(signal.label);
  const hitRate = paper.hit_rate;
  return (
    <section
      className="relative overflow-hidden rounded-xl border bg-card px-6 py-5"
      style={{
        borderColor: `${color}55`,
        boxShadow: `0 0 48px ${color}22, inset 0 0 40px ${color}0c`,
      }}
    >
      <div className="text-[11px] font-medium tracking-[0.18em] text-muted">
        PRÉDICTION 5 SECONDES
      </div>
      <div
        className="mt-1 font-sans text-5xl font-semibold tracking-wide sm:text-6xl"
        style={{ color }}
      >
        {signal.label}
      </div>
      <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <Metric label="Confiance" value={`${nfPrice.format(signal.confidence * 100)} %`} />
        <Metric
          label="Compte à rebours"
          value={`${fmtCd(paper.remaining_s)} / 0:05`}
        />
        <Metric label="P(↑)" value={nfP.format(signal.p_up)} />
        <Metric
          label="Paper"
          value={
            hitRate === null
              ? "—"
              : `${nfPrice.format(hitRate * 100)} % (${paper.n})`
          }
        />
      </div>
      <div className="mt-5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
        <span>{signal.why}</span>
        <span>
          rendement 5s
          {flux.ret_5_bps !== null ? ` ${nfPct.format(flux.ret_5_bps)} bps` : ""}
          {" · "}
          vol. réalisée 60s
          {flux.rv_60 !== null ? ` ${nfP.format(flux.rv_60 * 100)} %` : ""}
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
