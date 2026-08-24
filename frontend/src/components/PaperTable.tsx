import { fmtClock, nfBps, nfPrice, type LiveResponse, type PaperRow } from "../lib/types";

function HitIcon({ hit }: { hit: boolean | null }) {
  if (hit === null) return <span className="text-gold">●</span>;
  if (hit) return <span className="text-up">✓</span>;
  return <span className="text-down">✕</span>;
}

function Row({ row }: { row: PaperRow }) {
  const sideCls = row.side === "up" ? "text-up" : "text-down";
  const bps = row.signed_bps;
  const bpsCls = bps === null ? "text-muted" : bps >= 0 ? "text-up" : "text-down";
  const midEnd = row.mid_end;
  return (
    <tr className="border-t border-line/80">
      <td className="py-2 pr-3 font-mono text-[12px] text-muted tabular">{fmtClock(row.ts)}</td>
      <td className={`py-2 pr-3 font-medium ${sideCls}`}>{row.label}</td>
      <td className="py-2 pr-3 font-mono text-[12px] text-white/90 tabular">
        {nfPrice.format(row.mid)}
        {midEnd !== null ? ` → ${nfPrice.format(midEnd)}` : " → …"}
      </td>
      <td className="py-2 pr-3 text-center">
        <HitIcon hit={row.hit} />
      </td>
      <td className={`py-2 text-right font-mono text-[12px] tabular ${bpsCls}`}>
        {bps === null ? "—" : nfBps.format(bps)}
      </td>
    </tr>
  );
}

export function PaperTable({ live }: { live: LiveResponse }) {
  const rows: PaperRow[] = [
    ...(live.paper.pending ? [live.paper.pending] : []),
    ...live.paper.recent,
  ].slice(0, 14);
  return (
    <section className="rounded-xl border border-line bg-card px-5 py-4">
      <div className="text-[11px] tracking-[0.16em] text-muted">PAPER LIVE 5S</div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[520px] border-collapse text-left text-[13px]">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-muted">
              <th className="pb-2 font-medium">Heure</th>
              <th className="pb-2 font-medium">Côté</th>
              <th className="pb-2 font-medium">Mid → fin</th>
              <th className="pb-2 text-center font-medium">Hit</th>
              <th className="pb-2 text-right font-medium">bps</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-6 text-sm text-muted">
                  En attente d’un signal gated (hors bande NEUTRE).
                </td>
              </tr>
            ) : (
              rows.map((row) => <Row key={`${row.ts}-${row.side}`} row={row} />)
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
