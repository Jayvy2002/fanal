import { type LiveResponse } from "../lib/types";

export function PolyPaper({ live }: { live: LiveResponse }) {
  const p = live.poly;
  return (
    <section className="rounded-xl border border-line bg-card px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[11px] tracking-[0.16em] text-muted">PAPER POLYMARKET · 5 m UP/DOWN</div>
          <div className="mt-1 text-[15px] font-semibold tracking-wide text-gold">OFF · éteint</div>
        </div>
        <div className="rounded-full border border-gold/40 px-3 py-1 text-[11px] text-gold">
          fire forcé false · aucun ticket
        </div>
      </div>
      <div className="mt-3 rounded-lg border border-gold/25 bg-gold/5 px-3 py-2 text-[12px] leading-relaxed text-gold/90">
        {p.honest ||
          "Paper Polymarket éteint. Pas d’intra, pas de lock, pas de take CLOB. Conservé dans le code, ce n’est plus le produit. Aucun ordre live, aucune clé."}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <OffStat label="Tickets ouverts" value={String(p.open?.length ?? 0)} />
        <OffStat label="Trades (historique)" value={String(p.n ?? 0)} />
        <OffStat label="Skip (éteint)" value={String(p.n_skip_nofire ?? 0)} />
        <OffStat label="Ordres live" value="aucun" />
      </div>
      <p className="mt-3 text-[12px] text-muted">
        Le cerveau live est <code>/api/predict?horizon_s=3600|14400</code>. Le paper n’ouvre plus de ticket même si
        l’UI affiche HAUSSIER / BAISSIER.
      </p>
    </section>
  );
}

function OffStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line/80 bg-bg/40 px-3 py-2">
      <div className="text-[10px] tracking-[0.14em] text-muted uppercase">{label}</div>
      <div className="mt-0.5 font-mono text-[15px] tabular text-white">{value}</div>
    </div>
  );
}
