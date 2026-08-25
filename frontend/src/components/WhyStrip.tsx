import type { LiveResponse } from "../lib/types";

export function WhyStrip({ live }: { live: LiveResponse }) {
  const items = (live.predict.intra.reasons ?? []).filter((r) => r.key !== "gate");
  const gate = live.predict.intra.reasons.find((r) => r.key === "gate");
  return (
    <section className="rounded-xl border border-line bg-card px-5 py-3">
      <div className="text-[11px] tracking-[0.16em] text-muted">POURQUOI · TWAP vs CLOB · FEE-AWARE</div>
      <div className="mt-3 flex flex-wrap gap-2">
        {items.length === 0 ? (
          <span className="text-sm text-muted">En attente des features Coinbase…</span>
        ) : (
          items.map((f) => (
            <div key={f.key} className="rounded-lg border border-line bg-white/2 px-3 py-2">
              <div className="text-[10px] tracking-wide text-muted">{f.label}</div>
              <div className="font-mono text-sm text-white tabular">{f.display}</div>
            </div>
          ))
        )}
      </div>
      <div className="mt-2 text-[11px] text-muted">{gate?.display ?? live.predict.intra.label}</div>
    </section>
  );
}
