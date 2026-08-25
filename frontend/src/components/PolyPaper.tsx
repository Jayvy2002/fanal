import { fmtClock, fmtCd, nfP, nfUsd, type LiveResponse, type MmTrade } from "../lib/types";

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "up" | "down" | "muted";
}) {
  const cls =
    tone === "up" ? "text-up" : tone === "down" ? "text-down" : tone === "muted" ? "text-muted" : "text-white";
  return (
    <div className="rounded-lg border border-line/80 bg-bg/40 px-3 py-2">
      <div className="text-[10px] tracking-[0.14em] text-muted uppercase">{label}</div>
      <div className={`mt-0.5 font-mono text-[15px] tabular ${cls}`}>{value}</div>
    </div>
  );
}

export function PolyPaper({ live }: { live: LiveResponse }) {
  const p = live.mm;
  if (!p) {
    return (
      <section className="rounded-xl border border-line bg-card px-5 py-4">
        <div className="text-[11px] tracking-[0.16em] text-muted">PAPER MM · POLYMARKET 5 M</div>
        <div className="mt-2 text-sm text-muted">Chargement du paper two-sided…</div>
      </section>
    );
  }
  const t = p.test;
  const slot = (p.slots ?? []).find((s) => live.symbol.startsWith(s.asset)) ?? p.slots?.[0];
  const mkt = (p.markets ?? []).find((x) => live.symbol.startsWith(x.market.asset)) ?? p.markets?.[0];
  const pairAvg = slot && slot.matched > 0 ? slot.paired_cost / slot.matched : null;
  const nakedU = slot ? slot.shares_up - slot.matched : 0;
  const nakedD = slot ? slot.shares_down - slot.matched : 0;
  const start = p.starting_cash_usdc ?? 1000;
  const equity = p.equity_usdc ?? start;
  const realized = p.realized_pnl_usdc ?? 0;
  const rows: MmTrade[] = p.recent ?? [];

  return (
    <section className="rounded-xl border border-line bg-card px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[11px] tracking-[0.16em] text-muted">PAPER MM · TWO-SIDED · BTC 5 M UP/DOWN</div>
          <div className="mt-1 text-[15px] font-semibold tracking-wide text-up">ON · maker · pas de live</div>
        </div>
        <div className="rounded-full border border-up/40 px-3 py-1 text-[11px] text-up">
          clip {p.clip_usdc}&nbsp;$ · ledger v5 · aucun ordre CLOB
        </div>
      </div>

      <div className="mt-3 rounded-lg border border-gold/25 bg-gold/5 px-3 py-2 text-[12px] leading-relaxed text-gold/90">
        {p.honest}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Cash" value={nfUsd.format(p.cash_usdc ?? start)} />
        <Stat label="Equity" value={nfUsd.format(equity)} tone={equity >= start ? "up" : "down"} />
        <Stat
          label="PnL réalisé"
          value={nfUsd.format(realized)}
          tone={realized > 0 ? "up" : realized < 0 ? "down" : "muted"}
        />
        <Stat label="Frais taker" value={nfUsd.format(p.fees_usdc ?? 0)} tone="down" />
        <Stat label="Paires (locks)" value={String(p.n_pairs ?? 0)} />
        <Stat label="Fills maker / taker" value={`${p.n_maker_fills ?? 0} / ${p.n_taker_fills ?? 0}`} />
        <Stat
          label="Inventaire"
          value={
            slot
              ? `↑${slot.shares_up.toFixed(1)} ↓${slot.shares_down.toFixed(1)} · lock ${slot.matched.toFixed(1)}`
              : "—"
          }
        />
        <Stat
          label="Coût pairé"
          value={pairAvg == null ? "—" : `${nfP.format(pairAvg)} $ / share`}
        />
        <Stat label="Nu ↑ / ↓" value={`${nakedU.toFixed(1)} / ${nakedD.toFixed(1)}`} />
        <Stat label="Scratch" value={String(p.n_scratch ?? 0)} />
        <Stat
          label="TEST E USDC"
          value={t?.e_usdc == null ? "—" : `${t.e_usdc >= 0 ? "+" : ""}${t.e_usdc.toFixed(2).replace(".", ",")} $`}
          tone={t?.e_usdc != null && t.e_usdc < 0 ? "down" : t?.e_usdc != null && t.e_usdc > 0 ? "up" : "muted"}
        />
        <Stat label="TEST vs naive" value={t?.naive_e_usdc == null ? "—" : `${t.naive_e_usdc.toFixed(2).replace(".", ",")} $`} />
      </div>

      {mkt && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <div className="rounded-lg border border-line/80 px-3 py-2 text-[12px]">
            <div className="text-[10px] tracking-wide text-muted">CLOB {mkt.market.asset} · reste {fmtCd(mkt.market.remaining_s)}</div>
            <div className="mt-1 font-mono text-white tabular">
              Up {nfP.format(mkt.book.up.bid)} / {nfP.format(mkt.book.up.ask)} · Down{" "}
              {nfP.format(mkt.book.down.bid)} / {nfP.format(mkt.book.down.ask)}
            </div>
            <div className="mt-1 text-muted">
              pair ask {mkt.pair_ask == null ? "—" : nfP.format(mkt.pair_ask)} · pair bid{" "}
              {mkt.pair_bid == null ? "—" : nfP.format(mkt.pair_bid)}
            </div>
          </div>
          <div className="rounded-lg border border-line/80 px-3 py-2 text-[12px]">
            <div className="text-[10px] tracking-wide text-muted">Fair vs CLOB · bids virtuels</div>
            <div className="mt-1 font-mono text-white tabular">
              P(↑) fair {mkt.p_fair == null ? "—" : nfP.format(mkt.p_fair)} · p CLOB{" "}
              {mkt.p_clob == null ? "—" : nfP.format(mkt.p_clob)}
            </div>
            <div className="mt-1 text-muted">
              quotes {(mkt.quotes ?? []).map((q) => `${q.side} @ ${nfP.format(q.bid)}`).join(" · ") || "aucune"}
            </div>
          </div>
        </div>
      )}

      {t && (
        <div className="mt-3 text-[12px] leading-relaxed text-muted">
          TEST BTC 5 m ({t.n} slots) : E {t.e_usdc == null ? "—" : `${t.e_usdc.toFixed(2).replace(".", ",")} $`} / slot
          après frais vs naive one-sided {t.naive_e_usdc == null ? "—" : `${t.naive_e_usdc.toFixed(2).replace(".", ",")} $`}.
          Appariés n={t.n_matched ?? "—"} E {t.e_matched_usdc == null ? "—" : `${t.e_matched_usdc.toFixed(2).replace(".", ",")} $`}
          · pair moyen {t.mean_pair == null ? "—" : nfP.format(t.mean_pair)}. {t.lean_skipped}. Le chiffre négatif est
          conservé. Bonereaper net-of-fees plus tard n’est pas une promesse.
        </div>
      )}

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-left text-[13px]">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-muted">
              <th className="pb-2 font-medium">Heure</th>
              <th className="pb-2 font-medium">Kind</th>
              <th className="pb-2 text-right font-medium">Lock</th>
              <th className="pb-2 text-right font-medium">Pair $</th>
              <th className="pb-2 text-right font-medium">PnL</th>
              <th className="pb-2 font-medium">Raison</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-6 text-sm text-muted">
                  En attente d’un fill maker (trade-through du tick suivant) ou d’un taker lock rare. Poll 1 s — plus
                  lent que Bonereaper.
                </td>
              </tr>
            ) : (
              rows.slice(0, 12).map((row) => (
                <tr key={row.id} className="border-t border-line/80">
                  <td className="py-2 pr-3 font-mono text-[12px] text-muted tabular">{fmtClock(row.ts)}</td>
                  <td className="py-2 pr-3">{row.kind}</td>
                  <td className="py-2 pr-3 text-right font-mono text-[12px]">{row.matched.toFixed(1)}</td>
                  <td className="py-2 pr-3 text-right font-mono text-[12px]">
                    {row.pair_avg == null ? "—" : nfP.format(row.pair_avg)}
                  </td>
                  <td className={`py-2 pr-3 text-right font-mono text-[12px] ${row.pnl >= 0 ? "text-up" : "text-down"}`}>
                    {nfUsd.format(row.pnl)}
                  </td>
                  <td className="py-2 text-[12px] text-muted">{row.reason}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
