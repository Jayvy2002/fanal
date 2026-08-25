import { useState } from "react";
import {
  bpsFr,
  headsOf,
  nfP,
  nfPrice,
  signalColor,
  type LiveResponse,
  type PredictHit,
  type PredictResponse,
} from "../lib/types";

export function Hero({ live }: { live: LiveResponse }) {
  const { h1, h4 } = headsOf(live);
  const [head, setHead] = useState<"1h" | "4h">("1h");
  const signal = head === "1h" ? h1 : h4;
  const other = head === "1h" ? h4 : h1;
  const color = signalColor(signal.label);
  const coinFlip = isCoinFlip(h1) || isCoinFlip(h4);
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
            PRÉDICTEUR 1 H / 4 H · JOUET · ne trade pas · {live.symbol}
          </div>
          <div className="mt-2 flex gap-1">
            {(
              [
                ["1h", "1 heure"],
                ["4h", "4 heures"],
              ] as const
            ).map(([k, lab]) => (
              <button
                key={k}
                type="button"
                onClick={() => setHead(k)}
                className={`rounded-full border px-3 py-1 text-[12px] ${
                  head === k ? "border-gold bg-gold/15 text-gold" : "border-line text-muted"
                }`}
              >
                {lab}
              </button>
            ))}
          </div>
          <div className="mt-2 font-sans text-4xl font-semibold tracking-wide sm:text-5xl" style={{ color }}>
            {signal.label}
          </div>
          <div className="mt-1 text-[12px] text-muted">
            {signal.fire
              ? `appel UI |P−0,5| ≥ τ — le paper MM n’écoute pas ça`
              : "NEUTRE — le paper MM two-sided n’utilise pas ce signal"}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          <Metric label="P(↑) calibrée" value={nfP.format(signal.p_up)} />
          <Metric label="confiance" value={nfP.format(signal.confidence)} />
          <Metric
            label="|move| calibré"
            value={bpsFr(signal.expected_abs_move_bps ?? Math.abs(signal.expected_move_bps))}
          />
          <Metric label={`autre tête ${head === "1h" ? "4 h" : "1 h"}`} value={other.label} />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[12px] text-white/80 tabular">
        <span>
          spot {nfPrice.format(signal.close)}{" "}
          <span className="text-gold">{bpsFr(signal.expected_move_bps)} signé</span>
        </span>
        <span className="text-muted">
          1 h : {h1.label} · P(↑) {nfP.format(h1.p_up)} · {bpsFr(h1.expected_abs_move_bps ?? Math.abs(h1.expected_move_bps))}
        </span>
        <span className="text-muted">
          4 h : {h4.label} · P(↑) {nfP.format(h4.p_up)} · {bpsFr(h4.expected_abs_move_bps ?? Math.abs(h4.expected_move_bps))}
        </span>
        <HitLine hit={signal.last_hit ?? null} />
      </div>
      {coinFlip && (
        <div className="mt-3 rounded-lg border border-gold/30 bg-gold/8 px-3 py-2 text-[12px] leading-relaxed text-gold/90">
          TEST held-out : ce n’est pas un modèle « fort ». La 1 h bat à peine le naive (momentum) ; la 4 h à plat ne
          le bat pas. Brier ≈ 0,25 (pile-ou-face). Les E@10 bp / E@120 bp sont des scénarios de coût Coinbase, pas une
          promesse de trade. Ce prédicteur est un jouet UI — il ne déclenche aucun paper.
        </div>
      )}
    </section>
  );
}

function isCoinFlip(p: PredictResponse): boolean {
  const t = p.test;
  if (!t) return true;
  if (t.beats_naive_flat === false) return true;
  const acc = t.flat_acc ?? t.gated_acc;
  if (acc == null) return true;
  return acc < 0.55;
}

function HitLine({ hit }: { hit: PredictHit | null }) {
  if (!hit) return <span className="text-muted">hit/miss : en attente d’un horizon écoulé</span>;
  if (!hit.resolved) {
    return <span className="text-muted">hit/miss : horizon {hit.horizon_s / 3600} h pas encore échu</span>;
  }
  if (hit.hit == null) return <span className="text-muted">dernier appel : NEUTRE (pas de hit/miss)</span>;
  return (
    <span className={hit.hit ? "text-up" : "text-down"}>
      dernier appel {hit.horizon_s / 3600} h : {hit.hit ? "hit" : "miss"} · {hit.side} @ {nfPrice.format(hit.origin_close)}
      {hit.future_close != null ? ` → ${nfPrice.format(hit.future_close)}` : ""}
    </span>
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
