import { bpsFr, headsOf, pctFr, type LiveResponse, type PredictTest } from "../lib/types";

function acc(x: number | null | undefined): string {
  return pctFr(x, 1);
}

export function Scoreboard({ live }: { live: LiveResponse }) {
  const { h1, h4 } = headsOf(live);
  const rows: { name: string; t: PredictTest }[] = [
    { name: "1 h", t: h1.test },
    { name: "4 h", t: h4.test },
  ];
  return (
    <section className="rounded-xl border border-line bg-card px-5 py-4">
      <div className="text-[11px] tracking-[0.16em] text-muted">TEST HELD-OUT · walk-forward + split temporel · pas de shuffle</div>
      <div className="mt-1 text-[12px] text-muted">
        Naive = signe du rendement de la période précédente. E@10 bp / E@120 bp = scénarios de coût maker intro Coinbase,
        pas un carnet d’ordres.
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-left text-[13px]">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-muted">
              <th className="pb-2 font-medium">Tête</th>
              <th className="pb-2 text-right font-medium">n</th>
              <th className="pb-2 text-right font-medium">Acc gated</th>
              <th className="pb-2 text-right font-medium">Acc plat</th>
              <th className="pb-2 text-right font-medium">Naive</th>
              <th className="pb-2 text-right font-medium">Couverture</th>
              <th className="pb-2 text-right font-medium">|move|</th>
              <th className="pb-2 text-right font-medium">Brier</th>
              <th className="pb-2 text-right font-medium">E@10 bp</th>
              <th className="pb-2 text-right font-medium">E@120 bp</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ name, t }) => (
              <tr key={name} className="border-t border-line/80 font-mono tabular">
                <td className="py-2 pr-3 text-white">{name}</td>
                <td className="py-2 pr-3 text-right">{t?.n ?? "—"}</td>
                <td className="py-2 pr-3 text-right">{acc(t?.gated_acc)}</td>
                <td className="py-2 pr-3 text-right">{acc(t?.flat_acc)}</td>
                <td className="py-2 pr-3 text-right">{acc(t?.naive_last_acc)}</td>
                <td className="py-2 pr-3 text-right">{acc(t?.coverage)}</td>
                <td className="py-2 pr-3 text-right">{bpsFr(t?.mean_abs_move_bps)}</td>
                <td className="py-2 pr-3 text-right">
                  {t?.brier == null ? "—" : t.brier.toFixed(3).replace(".", ",")}
                </td>
                <td className="py-2 pr-3 text-right">{bpsFr(t?.expectancy_10bp)}</td>
                <td className="py-2 pr-3 text-right">{bpsFr(t?.expectancy_120bp)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 text-[11px] leading-relaxed text-muted">
        TEST : la 4 h à plat ne bat pas le naive ; la 1 h le bat de peu. Brier ≈ 0,25.{" "}
        <strong className="text-gold/80">Ce scoreboard ne déclenche aucun trade</strong> — le paper est le MM two-sided.
      </div>
    </section>
  );
}
