import {
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

async function postMode(mode: PaperMode): Promise<Paper> {
  const res = await fetch("/api/paper", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
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
  const mode: PaperMode = p.mode ?? "taker";
  const hitRate = p.hit_rate;
  const realized = p.realized_pnl_usd ?? 0;
  const equity = p.equity_usd ?? p.starting_cash_usd ?? 1000;
  const start = p.starting_cash_usd ?? 1000;
  const eqTone = equity >= start ? "up" : "down";
  const pnlTone = realized > 0 ? "up" : realized < 0 ? "down" : "muted";
  const open = p.open_position;
  const rows: PaperRow[] = [...(p.pending ? [p.pending] : []), ...p.recent].slice(0, 14);
  const rt = p.round_trip_fee_bps ?? (mode === "taker" ? 120 : 80);
  const taker = p.taker_fee_bps ?? 60;
  const maker = p.maker_fee_bps ?? 40;

  return (
    <section className="rounded-xl border border-line bg-card px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[11px] tracking-[0.16em] text-muted">PAPER 24 H · BTC-USD</div>
          <div className="mt-1 text-[13px] text-white/85">
            {p.clip_usd ?? 75}&nbsp;$ US / signal · 1 position · flatten {p.horizon_s}s · départ{" "}
            {nfUsd.format(start)}
          </div>
        </div>
        <div className="flex rounded-full border border-line p-0.5 text-[12px]">
          <button
            type="button"
            className={`rounded-full px-3 py-1 ${mode === "taker" ? "bg-gold/20 text-gold" : "text-muted"}`}
            onClick={() => {
              void postMode("taker").then((next) => onPaper?.(next));
            }}
          >
            Preneur
          </button>
          <button
            type="button"
            className={`rounded-full px-3 py-1 ${mode === "maker" ? "bg-gold/20 text-gold" : "text-muted"}`}
            onClick={() => {
              void postMode("maker").then((next) => onPaper?.(next));
            }}
          >
            Faiseur
          </button>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-4">
        <Stat label="Cash" value={nfUsd.format(p.cash_usd ?? start)} />
        <Stat label="Equity" value={nfUsd.format(equity)} tone={eqTone} />
        <Stat label="PnL réalisé" value={nfUsd.format(realized)} tone={pnlTone} />
        <Stat label="Frais payés" value={nfUsd.format(p.fees_usd ?? 0)} tone="down" />
        <Stat
          label="Taux de hits"
          value={hitRate === null ? "—" : `${nfPrice.format(hitRate * 100)} %`}
        />
        <Stat label="Trades clos" value={`${p.n}${p.n_cancelled ? ` · ${p.n_cancelled} ann.` : ""}`} />
        <Stat
          label="Position"
          value={
            open
              ? `${open.label} ${nfQty.format(open.qty)} @ ${nfPrice.format(open.entry_px)}`
              : p.pending?.status === "pending_entry"
                ? "Ordre en carnet"
                : "Plat"
          }
        />
        <Stat label="Mode" value={mode === "maker" ? "Faiseur / post-only" : "Preneur (deux côtés)"} />
      </div>

      <div className="mt-3 rounded-lg border border-gold/25 bg-gold/5 px-3 py-2 text-[12px] leading-relaxed text-gold/90">
        Palier {p.fee_tier ?? "Coinbase Advanced Trade · 0–10 000 $ US / 30 j"} : preneur {nfPrice.format(taker)}{" "}
        bp, faiseur {nfPrice.format(maker)} bp. Aller-retour {mode === "taker" ? "preneur" : "faiseur"} ={" "}
        {nfPrice.format(rt)} bp vs |move| 5s ~1 bp — le paper preneur devrait perdre. Aucun ordre réel, aucune
        clé, aucun retrait. Carnet persisté ({p.store === "blobs" ? "Netlify Blobs" : "fichier local"}) : un cold
        start ne remet plus le livre à zéro. Short = notionnel virtuel. Hit* = direction du fill, sans frais ;
        le PnL $ compte les deux jambes. Cron 1 min (paper-tick) avance le flatten si l’onglet n’est pas au
        premier plan. Un jour vert ici voudrait dire qu’on peut parler live — pas avant.
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
                  En attente d’un signal gated (P hors bande ET |move| prévu ≥ {nfPrice.format(p.min_move_bps ?? 1)}{" "}
                  bp). L’espérance après frais n’est pas maquillée.
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
