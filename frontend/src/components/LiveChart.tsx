import { useMemo, useState } from "react";
import { fmtClock, nfPrice, type LiveResponse } from "../lib/types";

const W = 1120;
const H = 380;
const PAD = { l: 18, r: 88, t: 28, b: 32 };

export function LiveChart({ live }: { live: LiveResponse }) {
  const [hover, setHover] = useState<{ t: number; p: number } | null>(null);
  const spark = live.spark;
  const now = live.now || spark[spark.length - 1]?.t || Date.now();
  const signal = live.predict.intra;

  const geo = useMemo(() => {
    const tMin = spark[0]?.t ?? now - 3 * 3600_000;
    const tMax = now + 6 * 60_000;
    const vis = spark.filter((s) => s.t >= tMin && s.t <= now);
    const prices: number[] = vis.flatMap((s) => [s.p, s.h ?? s.p, s.l ?? s.p]);
    const tgt = signal.close * (1 + signal.expected_move_bps / 1e4);
    if (tgt) prices.push(tgt);
    let lo = Math.min(...prices);
    let hi = Math.max(...prices);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      lo = 0;
      hi = 1;
    }
    const span = hi - lo || Math.max(Math.abs(hi) * 1e-5, 1);
    lo -= span * 0.12;
    hi += span * 0.12;
    const plotW = W - PAD.l - PAD.r;
    const plotH = H - PAD.t - PAD.b;
    const x = (t: number) => PAD.l + ((t - tMin) / (tMax - tMin)) * plotW;
    const y = (p: number) => PAD.t + (1 - (p - lo) / (hi - lo)) * plotH;
    return { tMin, tMax, vis, lo, hi, x, y, tgt };
  }, [spark, now, signal.close, signal.expected_move_bps]);

  if (spark.length < 2) {
    return (
      <section className="rounded-xl border border-line bg-card px-5 py-4">
        <div className="text-[11px] tracking-[0.16em] text-muted">PRIX · {live.symbol} · 1 m Coinbase</div>
        <div className="mt-8 text-sm text-muted">Chargement des bougies 1 minute…</div>
      </section>
    );
  }

  const { vis, lo, hi, x, y, tMin, tMax, tgt } = geo;
  const yTicks = 4;
  const yVals = Array.from({ length: yTicks + 1 }, (_, i) => lo + ((hi - lo) * i) / yTicks);
  const tTicks = 6;
  const tVals = Array.from({ length: tTicks + 1 }, (_, i) => tMin + ((tMax - tMin) * i) / tTicks);
  const line = vis.map((pt, i) => `${i === 0 ? "M" : "L"}${x(pt.t).toFixed(1)},${y(pt.p).toFixed(1)}`).join(" ");
  const gold =
    signal.fire && tgt
      ? `M${x(now).toFixed(1)},${y(signal.close).toFixed(1)} L${x(now + signal.horizon_s * 1000).toFixed(1)},${y(tgt).toFixed(1)}`
      : "";

  return (
    <section className="rounded-xl border border-line bg-card px-5 py-4">
      <div className="flex justify-between text-[11px] tracking-[0.16em] text-muted">
        <span>PRIX LIVE · {live.symbol} · bougies 1 m Coinbase</span>
        <span>trait or = trajet intra prévu (dernière barre complète)</span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="mt-2 w-full"
        onMouseMove={(e) => {
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - rect.left) / rect.width) * W;
          let best = vis[0];
          let bestD = Infinity;
          for (const s of vis) {
            const d = Math.abs(x(s.t) - px);
            if (d < bestD) {
              bestD = d;
              best = s;
            }
          }
          setHover({ t: best.t, p: best.p });
        }}
        onMouseLeave={() => setHover(null)}
      >
        {yVals.map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="#ffffff10" />
            <text x={W - PAD.r + 8} y={y(v) + 4} fill="#8b919c" fontSize="11" fontFamily="IBM Plex Mono">
              {nfPrice.format(v)}
            </text>
          </g>
        ))}
        {tVals.map((t) => (
          <text key={t} x={x(t)} y={H - 8} fill="#8b919c" fontSize="11" textAnchor="middle" fontFamily="IBM Plex Mono">
            {fmtClock(t)}
          </text>
        ))}
        <path d={line} fill="none" stroke="#e8eaee" strokeWidth="1.6" />
        {gold && (
          <path d={gold} fill="none" stroke="#c8a46a" strokeWidth="1.8" strokeDasharray="6 5" />
        )}
        <line x1={x(now)} x2={x(now)} y1={PAD.t} y2={H - PAD.b} stroke="#ffffff55" strokeWidth="1" />
        {hover && (
          <g>
            <circle cx={x(hover.t)} cy={y(hover.p)} r="4" fill="#c8a46a" />
            <text x={x(hover.t) + 8} y={y(hover.p) - 8} fill="#c8a46a" fontSize="12" fontFamily="IBM Plex Mono">
              {nfPrice.format(hover.p)}
            </text>
          </g>
        )}
      </svg>
    </section>
  );
}
