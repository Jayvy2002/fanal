import {
  fmtCd,
  fmtClock,
  nfBps,
  nfPrice,
  nfQty,
  nfUsd,
  type LiveResponse,
  type Paper,
  type PaperMode,
  type PaperRow,
} from "../lib/types";

function HitIcon({ hit }: { hit: boolean | null }) {
  if (hit === null) return <span className="text-gold">●</span>;
  if (hit) return <span className="text-up">✓</span>;
  return <span className="text-down">✕</span>;
}

function roleFr(role?: string): string {
  if (role === "maker") return "faiseur";
  if (role === "taker") return "preneur";
  if (role === "cancel") return "annulé";
  return "—";
}

function Row({ row }: { row: PaperRow }) {
  const sideCls = row.side === "up" ? "text-up" : "text-down";
  const bps = row.signed_bps;
  const bpsCls = bps === null ? "text-muted" : bps >= 0 ? "text-up" : "text-down";
  const pnl = row.pnl_usd;
  const pnlCls = pnl == null ? "text-muted" : pnl >= 0 ? "text-up" : "text-down";
  const midEnd = row.mid_end;
  const status =
    row.status === "open"
      ? "ouvert"
      : row.status === "pending_entry"
        ? "en carnet"
        : row.status === "cancelled"
          ? "annulé"
          : "clos";
  return (
    <tr className="border-t border-line/80">
      <td className="py-2 pr-3 font-mono text-[12px] text-muted tabular">{fmtClock(row.ts)}</td>
      <td className={`py-2 pr-3 font-medium ${sideCls}`}>{row.label}</td>
      <td className="py-2 pr-3 font-mono text-[12px] text-white/90 tabular">
        {nfPrice.format(row.mid)}
        {midEnd !== null ? ` → ${nfPrice.format(midEnd)}` : " → …"}
      </td>
      <td className="py-2 pr-3 text-[12px] text-muted">{status}</td>
      <td className="py-2 pr-3 text-[12px] text-muted">{roleFr(row.entry_role)}</td>
      <td className="py-2 pr-3 text-center">
        <HitIcon hit={row.hit} />
      </td>
      <td className={`py-2 pr-3 text-right font-mono text-[12px] tabular ${pnlCls}`}>
        {pnl == null ? "—" : nfUsd.format(pnl)}
      </td>
      <td className={`py-2 text-right font-mono text-[12px] tabular ${bpsCls}`}>
        {bps === null ? "—" : nfBps.format(bps)}
      </td>
    </tr>
  );
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

async function postPaper(body: { mode?: PaperMode; horizonSec?: number }): Promise<Paper> {
  const res = await fetch("/api/paper", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`paper ${res.status}`);
  return res.json() as Promise<Paper>;
}

export function PaperTable({
  live,
  onPaper,
}: {
  live: LiveResponse;
  onPaper?: (paper: Paper) => void;
}) {
  const p = live.paper;
  const mode: PaperMode = p.mode ?? "maker";
  const hitRate = p.hit_rate;
  const hitFees = p.hit_rate_after_fees;
  const realized = p.realized_pnl_usd ?? 0;
  const equity = p.equity_usd ?? p.starting_cash_usd ?? 1000;
  const start = p.starting_cash_usd ?? 1000;
  const eqTone = equity >= start ? "up" : "down";
  const pnlTone = realized > 0 ? "up" : realized < 0 ? "down" : "muted";
  const open = p.open_position;
  const rows: PaperRow[] = [...(p.pending ? [p.pending] : []), ...p.recent].slice(0, 14);
  const rt = p.round_trip_fee_bps ?? (mode === "taker" ? 240 : 120);
  const taker = p.taker_fee_bps ?? 120;
  const maker = p.maker_fee_bps ?? 60;
  const makerRt = p.round_trip_maker_bps ?? 120;
  const takerRt = p.round_trip_taker_bps ?? 240;
  const hz = p.horizon_s ?? 60;
  const gate = p.min_move_bps ?? makerRt;
  const paperSig = live.paper_signal;
  const posted = open?.posted_px ?? p.pending?.posted_px ?? p.pending?.mid;
  const age = open?.age_s ?? p.pending?.age_s;
  const fills = `${p.n_maker_fills ?? 0} fai. · ${p.n_taker_fills ?? 0} pre.`;
  const t60 = live.test_60;

  return (
    <section className="rounded-xl border border-line bg-card px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[11px] tracking-[0.16em] text-muted">
            PAPER 24 H · FAISEUR {hz}s · PAS D’ORDRES LIVE
          </div>
          <div className="mt-1 text-[13px] text-white/85">
            {p.clip_usd ?? 75}&nbsp;$ US / signal · 1 position · flatten {hz}s · départ{" "}
            {nfUsd.format(start)} · gate {nfPrice.format(gate)} bp
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex rounded-full border border-line p-0.5 text-[12px]">
            <button
              type="button"
              className={`rounded-full px-3 py-1 ${mode === "taker" ? "bg-gold/20 text-gold" : "text-muted"}`}
              onClick={() => {
                void postPaper({ mode: "taker", horizonSec: hz }).then((next) => onPaper?.(next));
              }}
            >
              Preneur
            </button>
            <button
              type="button"
              className={`rounded-full px-3 py-1 ${mode === "maker" ? "bg-gold/20 text-gold" : "text-muted"}`}
              onClick={() => {
                void postPaper({ mode: "maker", horizonSec: hz }).then((next) => onPaper?.(next));
              }}
            >
              Faiseur
            </button>
          </div>
          <div className="flex rounded-full border border-line p-0.5 text-[11px]">
            <button
              type="button"
              className={`rounded-full px-2 py-0.5 ${hz === 60 ? "bg-gold/20 text-gold" : "text-muted"}`}
              onClick={() => {
                void postPaper({ mode, horizonSec: 60 }).then((next) => onPaper?.(next));
              }}
            >
              60s
            </button>
            <button
              type="button"
              className={`rounded-full px-2 py-0.5 ${hz === 5 ? "bg-gold/20 text-gold" : "text-muted"}`}
              onClick={() => {
                void postPaper({ mode: "taker", horizonSec: 5 }).then((next) => onPaper?.(next));
              }}
            >
              5s (comparaison)
            </button>
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-4">
        <Stat label="Cash" value={nfUsd.format(p.cash_usd ?? start)} />
        <Stat label="Equity" value={nfUsd.format(equity)} tone={eqTone} />
        <Stat label="PnL réalisé" value={nfUsd.format(realized)} tone={pnlTone} />
        <Stat label="Frais payés" value={nfUsd.format(p.fees_usd ?? 0)} tone="down" />
        <Stat
          label="Hits direction"
          value={hitRate === null ? "—" : `${nfPrice.format(hitRate * 100)} %`}
        />
        <Stat
          label="Hits après frais"
          value={
            hitFees == null
              ? "—"
              : `${nfPrice.format(hitFees * 100)} % (${p.hits_after_fees ?? 0}/${p.n})`
          }
        />
        <Stat
          label="Fills / annulations"
          value={`${fills} · ${p.n_cancelled ?? 0} ann.`}
        />
        <Stat label="Horizon / gate" value={`${hz}s · ${nfPrice.format(gate)} bp`} />
      </div>

      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Stat
          label="Ordre ouvert"
          value={
            open
              ? `${open.label} ${nfQty.format(open.qty)} @ ${nfPrice.format(posted ?? open.entry_px)}${
                  age != null ? ` · ${fmtCd(age)}` : ""
                }`
              : p.pending?.status === "pending_entry"
                ? `En carnet ${p.pending.label} @ ${nfPrice.format(p.pending.posted_px ?? p.pending.mid)}${
                    p.pending.age_s != null ? ` · ${fmtCd(p.pending.age_s)}` : ""
                  }`
                : "Plat"
          }
        />
        <Stat
          label="Mode"
          value={mode === "maker" ? `Faiseur / post-only ${hz}s` : `Preneur ${hz}s`}
        />
      </div>

      {paperSig && (
        <div className="mt-2 text-[12px] text-white/70">
          Signal paper {paperSig.horizon_s}s : <span className="text-white">{paperSig.label}</span>
          {" · "}|move| {nfBps.format(Math.abs(paperSig.expected_move_bps))} bp · P(↑){" "}
          {paperSig.p_up.toFixed(3).replace(".", ",")}
          {paperSig.gate_block === "move" ? " · sous le gate frais" : ""}
          {paperSig.gate_block === "prob" ? " · P dans la bande τ" : ""}
        </div>
      )}

      <div className="mt-3 rounded-lg border border-gold/25 bg-gold/5 px-3 py-2 text-[12px] leading-relaxed text-gold/90">
        <div>
          <strong>{p.fee_product ?? "Coinbase Advanced Trade"}</strong>
          {" · "}
          {p.fee_tier ?? "palier d’entrée < 1 000 $ US / 30 j (hypothèse)"} : preneur{" "}
          {nfPrice.format(taker)} bp, faiseur {nfPrice.format(maker)} bp. Aller-retour faiseur{" "}
          {nfPrice.format(makerRt)} bp · preneur {nfPrice.format(takerRt)} bp (mode actuel {nfPrice.format(rt)}{" "}
          bp). Gate d’entrée = {nfPrice.format(gate)} bp.
        </div>
        <div className="mt-1 text-gold/75">
          {p.fee_caveat ??
            "Le barème officiel Advanced Trade est derrière connexion compte ; ces 120/60 bp ne sont pas une publication Coinbase."}{" "}
          Exchange public 0–10 k$ = {p.exchange_alternate?.taker_bps ?? 60}/{p.exchange_alternate?.maker_bps ?? 40}{" "}
          bp — non utilisé.
        </div>
        <div className="mt-1 text-white/70">
          Affichage 5s du graphique ≠ paper {hz}s. |move| 60s BTC souvent ~10 bp vs {nfPrice.format(makerRt)} bp
          de friction : couverture minuscule, E après frais probablement négative. Aucun ordre réel, aucune
          clé, aucun retrait. Carnet persisté ({p.store === "blobs" ? "Netlify Blobs" : "fichier local"}).
          Cron 1 min (paper-tick) avance le flatten si l’onglet est fermé. Hit* = direction sans frais.
        </div>
        {t60 && (
          <div className="mt-1 text-white/60">
            TEST 60s
            {t60.fallback ? " (fallback, pas de LightGBM 60s entraîné)" : " (Binance Vision 7 j)"}
            {t60.n === 0
              ? ` : gate 120 bp → n=0, couverture 0 %. |move| τ-only ~${(t60.mean_abs_move_bps ?? 0).toFixed(1).replace(".", ",")} bp.`
              : t60.gated_acc != null
                ? ` : acc ${(t60.gated_acc * 100).toFixed(1).replace(".", ",")} % · cov ${((t60.coverage ?? 0) * 100).toFixed(2).replace(".", ",")} % · |move| ${(t60.mean_abs_move_bps ?? 0).toFixed(1).replace(".", ",")} bp`
                : " : pas de gated acc."}
            {t60.expectancy_maker_rt != null
              ? ` E après RT faiseur ${t60.expectancy_maker_rt.toFixed(1).replace(".", ",")} bp`
              : ""}
            {t60.expectancy_taker_rt != null
              ? ` · E après RT preneur ${t60.expectancy_taker_rt.toFixed(1).replace(".", ",")} bp`
              : ""}
            . Négatif = honnête.
          </div>
        )}
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-left text-[13px]">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-muted">
              <th className="pb-2 font-medium">Heure</th>
              <th className="pb-2 font-medium">Côté</th>
              <th className="pb-2 font-medium">Entrée → sortie</th>
              <th className="pb-2 font-medium">Statut</th>
              <th className="pb-2 font-medium">Rôle</th>
              <th className="pb-2 text-center font-medium">Hit*</th>
              <th className="pb-2 text-right font-medium">PnL $</th>
              <th className="pb-2 text-right font-medium">bps nets</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-6 text-sm text-muted">
                  En attente d’un signal paper {hz}s (direction ET |move| prévu ≥ {nfPrice.format(gate)} bp =
                  RT faiseur). Ce n’est pas le feu 5s. L’espérance après frais n’est pas maquillée.
                </td>
              </tr>
            ) : (
              rows.map((row, i) => <Row key={row.id ?? `${row.ts}-${row.side}-${row.status}-${i}`} row={row} />)
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
