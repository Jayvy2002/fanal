import {
  fmtCd,
  nfBps,
  nfP,
  nfPrice,
  signalColor,
  type LiveResponse,
} from "../lib/types";

export function Hero({ live }: { live: LiveResponse }) {
  const { signal, paper } = live;
  const color = signalColor(signal.label);
  const hitRate = paper.hit_rate;
  const minMove = signal.min_move_bps ?? live.min_move_bps ?? 1;
  const absMove = Math.abs(signal.expected_move_bps);
  const blockedMove = signal.gate_block === "move";
  const paperHz = paper.horizon_s ?? live.paper_horizon_s ?? 60;
  const paperGate = paper.min_move_bps ?? 120;
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
            AFFICHAGE {signal.horizon_s} SECONDES · PAS LE PAPER
          </div>
          <div
            className="mt-1 font-sans text-4xl font-semibold tracking-wide sm:text-5xl"
            style={{ color }}
          >
            {signal.label}
          </div>
          {blockedMove && (
            <div className="mt-1 text-[12px] text-gold/90">
              |move| prévu {nfBps.format(absMove)} bp sous le seuil {nfPrice.format(minMove)} bp
            </div>
          )}
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          <Metric label="Confiance" value={`${nfPrice.format(signal.confidence * 100)} %`} />
          <Metric
            label={`Paper ${paperHz}s`}
            value={`${fmtCd(paper.remaining_s)} / ${fmtCd(paperHz)}`}
          />
          <Metric label="P(↑) 5s" value={nfP.format(signal.p_up)} />
          <Metric
            label="Hits paper"
            value={
              hitRate === null ? "—" : `${nfPrice.format(hitRate * 100)} % (${paper.n})`
            }
          />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[12px] text-white/80 tabular">
        <span>
          cible 5s {nfPrice.format(signal.target_px)}{" "}
          <span className="text-gold">{nfBps.format(signal.expected_move_bps)} bps</span>
        </span>
        <span className="text-muted">
          feu 5s si |move| ≥ {nfPrice.format(minMove)} bp — le paper n’entre pas là-dessus
        </span>
      </div>
      <div className="mt-2 rounded-md border border-gold/20 bg-gold/5 px-3 py-1.5 text-[12px] text-gold/90">
        Paper = {paper.mode === "taker" ? "preneur" : "faiseur"} {paperHz}s, gate{" "}
        {nfPrice.format(paperGate)} bp (RT faiseur). L’affichage 5s ≠ le paper {paperHz}s. Pas
        d’ordres live.
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
