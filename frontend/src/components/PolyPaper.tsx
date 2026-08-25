import { fmtClock, fmtCd, nfP, nfUsd, type LiveResponse, type PolyTrade } from "../lib/types";

function HitIcon({ hit, scratch }: { hit: boolean | null; scratch?: boolean }) {
  if (scratch) return <span className="text-gold">~</span>;
  if (hit === null) return <span className="text-gold">●</span>;
  if (hit) return <span className="text-up">✓</span>;
  return <span className="text-down">✕</span>;
}

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
  const p = live.poly;
  const start = p.starting_cash_usdc ?? 1000;
  const equity = p.equity_usdc ?? start;
  const realized = p.realized_pnl_usdc ?? 0;
  const open = p.open ?? [];
  const rows: PolyTrade[] = p.recent ?? [];
  const mkt = (p.markets ?? []).find((x) => live.symbol.startsWith(x.market.asset)) ?? p.markets?.[0];

  return (
    <section className="rounded-xl border border-line bg-card px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[11px] tracking-[0.16em] text-muted">PAPER POLYMARKET · 5 m UP/DOWN</div>
          <div className="mt-1 text-[13px] text-white/85">
            {p.clip_usdc ?? 25}&nbsp;USDC / ticket · fair value vs CLOB · départ {nfUsd.format(start)} · ledger v4
          </div>
        </div>
        <div className="rounded-full border border-down/40 px-3 py-1 text-[11px] text-down">
          aucun ordre live · aucune clé
        </div>
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
        <Stat
          label="Hits"
          value={p.hit_rate == null ? "—" : `${nfP.format(p.hit_rate * 100)} % (${p.n})`}
        />
        <Stat label="Intra / lock" value={`${p.n_intra ?? 0} / ${p.n_lock ?? 0}`} />
        <Stat
          label="Ticket ouvert"
          value={
            open[0]
              ? `${open[0].asset} ${open[0].strat} ${open[0].side.toUpperCase()} @ ${nfP.format(open[0].entry_ask)}`
              : "Plat"
          }
        />
        <Stat label="Skip silence / TWAP" value={`${p.n_skip_nofire ?? 0} / ${p.n_skip_stale ?? 0}`} />
      </div>

      {mkt && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <div className="rounded-lg border border-line/80 px-3 py-2 text-[12px]">
            <div className="text-[10px] tracking-wide text-muted">CLOB {mkt.market.asset} · {mkt.market.slug}</div>
            <div className="mt-1 font-mono text-white tabular">
              Up {nfP.format(mkt.book.up.bid)} / {nfP.format(mkt.book.up.ask)} · Down{" "}
              {nfP.format(mkt.book.down.bid)} / {nfP.format(mkt.book.down.ask)}
            </div>
            <div className="mt-1 text-muted">reste {fmtCd(mkt.market.remaining_s)}</div>
          </div>
          <div className="rounded-lg border border-line/80 px-3 py-2 text-[12px]">
            <div className="text-[10px] tracking-wide text-muted">TWAP 60s officiel · strike open</div>
            <div className="mt-1 font-mono text-white tabular">
              {mkt.twap
                ? `${nfUsd.format(mkt.twap.value).replace("$US", "").trim()} ${mkt.twap.stale ? "· STALE" : ""}`
                : "pas de flux"}
              {mkt.strike ? ` · strike ${mkt.strike.late ? "tardif (lock skip)" : mkt.strike.twap.toFixed(2)}` : " · pas de strike"}
            </div>
            <div className="mt-1 text-muted">
              P(lock ↑) {mkt.p_lock_up == null ? "—" : nfP.format(mkt.p_lock_up)}
              {mkt.lock_skip ? ` · skip ${mkt.lock_skip}` : ""}
            </div>
          </div>
        </div>
      )}

      <div className="mt-3 rounded-lg border border-gold/25 bg-gold/5 px-3 py-2 text-[12px] leading-relaxed text-gold/90">
        Frais crypto taker : <code>{p.fee_formula}</code> USDC (makers 0). {p.lock_90c_math} Scoreboard = PnL
        USDC après frais (deux jambes si scalp, une si redeem $1/$0). Feu seulement si |P(TWAP) − p_CLOB| &gt;
        fee(p) + pad, hors bande 40–60 ¢. ETH paper skip si TEST le tire vers le bas. TWAP stale → skip (pas de
        mid Coinbase). Poll UI 1 s ; cron 1 min. Carnet persisté ({p.store === "blobs" ? "Netlify Blobs" : "fichier local"}),
        schéma v4. Aucun ordre live.
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-left text-[13px]">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-muted">
              <th className="pb-2 font-medium">Heure</th>
              <th className="pb-2 font-medium">Strat</th>
              <th className="pb-2 font-medium">Côté</th>
              <th className="pb-2 font-medium">Entrée → sortie</th>
              <th className="pb-2 text-center font-medium">Hit</th>
              <th className="pb-2 text-right font-medium">PnL</th>
              <th className="pb-2 font-medium">Raison</th>
            </tr>
          </thead>
          <tbody>
            {open.map((pos) => (
              <tr key={pos.id} className="border-t border-line/80">
                <td className="py-2 pr-3 font-mono text-[12px] text-muted tabular">{fmtClock(pos.entry_ts)}</td>
                <td className="py-2 pr-3">{pos.strat}</td>
                <td className={pos.side === "up" ? "text-up" : "text-down"}>
                  {pos.asset} {pos.side.toUpperCase()}
                </td>
                <td className="py-2 pr-3 font-mono text-[12px]">{nfP.format(pos.entry_ask)} → …</td>
                <td className="py-2 pr-3 text-center">
                  <HitIcon hit={null} />
                </td>
                <td className="py-2 pr-3 text-right text-muted">ouvert</td>
                <td className="py-2 text-muted">ticket</td>
              </tr>
            ))}
            {rows.length === 0 && open.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-6 text-sm text-muted">
                  En attente d’un feu du prédicteur avec un CLOB encore cheap, ou d’un lock TWAP en fin de
                  créneau. Un jour vert n’est pas le critère de succès.
                </td>
              </tr>
            ) : (
              rows.slice(0, 12).map((row) => {
                const pnlCls = row.pnl >= 0 ? "text-up" : "text-down";
                return (
                  <tr key={row.id} className="border-t border-line/80">
                    <td className="py-2 pr-3 font-mono text-[12px] text-muted tabular">{fmtClock(row.ts)}</td>
                    <td className="py-2 pr-3">{row.strat}</td>
                    <td className={row.side === "up" ? "text-up" : "text-down"}>
                      {row.asset} {row.side.toUpperCase()}
                    </td>
                    <td className="py-2 pr-3 font-mono text-[12px]">
                      {nfP.format(row.entry_ask)} → {nfP.format(row.exit_bid)}
                    </td>
                    <td className="py-2 pr-3 text-center">
                      <HitIcon hit={row.hit} scratch={row.scratch} />
                    </td>
                    <td className={`py-2 pr-3 text-right font-mono text-[12px] tabular ${pnlCls}`}>
                      {nfUsd.format(row.pnl)}
                    </td>
                    <td className="py-2 text-[12px] text-muted">{row.reason}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
