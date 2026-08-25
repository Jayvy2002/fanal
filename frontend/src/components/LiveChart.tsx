import { useMemo, useState } from "react";
import { fmtClock, headsOf, nfPrice, type LiveResponse, type PredictResponse } from "../lib/types";

const W = 1120;
const H = 380;
const PAD = { l: 18, r: 88, t: 28, b: 32 };

function targetPx(p: PredictResponse): number {
  return p.close * (1 + p.expected_move_bps / 1e4);
}

export function LiveChart({ live }: { live: LiveResponse }) {
  const [hover, setHover] = useState<{ t: number; p: number } | null>(null);
  const spark = live.spark;
  const now = live.now || spark[spark.length - 1]?.t || Date.now();
  const { h1, h4 } = headsOf(live);

  const geo = useMemo(() => {
    const tMin = spark[0]?.t ?? now - 15 * 3600_000;
    const tMax = now + 4 * 3600_000;
    const vis = spark.filter((s) => s.t >= tMin && s.t <= now);
    const prices: number[] = vis.flatMap((s) => [s.p, s.h ?? s.p, s.l ?? s.p]);
    const t1 = targetPx(h1);
    const t4 = targetPx(h4);
    if (t1) prices.push(t1);
    if (t4) prices.push(t4);
    prices.push(h1.close || 0, h4.close || 0);
    let lo = Math.min(...prices.filter((x) => Number.isFinite(x) && x > 0));
    let hi = Math.max(...prices.filter((x) => Number.isFinite(x) && x > 0));
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
    return { tMin, tMax, vis, lo, hi, x, y, t1, t4 };
  }, [spark, now, h1.close, h1.expected_move_bps, h4.close, h4.expected_move_bps]);

  if (spark.length < 2) {
    return (
      <section className="rounded-xl border border-line bg-card px-5 py-4">
        <div className="text-[11px] tracking-[0.16em] text-muted">PRIX · {live.symbol} · 5 m Coinbase</div>
        <div className="mt-8 text-sm text-muted">Chargement des bougies 5 minutes…</div>
      </section>
    );
  }

  const { vis, lo, hi, x, y, tMin, tMax, t1, t4 } = geo;
  const yTicks = 4;
  const yVals = Array.from({ length: yTicks + 1 }, (_, i) => lo + ((hi - lo) * i) / yTicks);
  const tTicks = 6;
  const tVals = Array.from({ length: tTicks + 1 }, (_, i) => tMin + ((tMax - tMin) * i) / tTicks);
  const line = vis.map((pt, i) => `${i === 0 ? "M" : "L"}${x(pt.t).toFixed(1)},${y(pt.p).toFixed(1)}`).join(" ");
  const origin = h1.close || vis[vis.length - 1]?.p || 0;
  const gold1h =
    origin && t1
      ? `M${x(now).toFixed(1)},${y(origin).toFixed(1)} L${x(now + 3600_000).toFixed(1)},${y(t1).toFixed(1)}`
      : "";
  const gold4h =
    origin && t4
      ? `M${x(now).toFixed(1)},${y(origin).toFixed(1)} L${x(now + 4 * 3600_000).toFixed(1)},${y(t4).toFixed(1)}`
      : "";

  return (
    <section className="rounded-xl border border-line bg-card px-5 py-4">
      <div className="flex flex-wrap justify-between gap-2 text-[11px] tracking-[0.16em] text-muted">
        <span>PRIX · {live.symbol} · bougies 5 m Coinbase</span>
        <span>or = move 1 h calibré · or pâle = 4 h · pas un croquis 1 bp</span>
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
        {gold4h && (
          <path d={gold4h} fill="none" stroke="#c8a46a" strokeWidth="1.6" strokeOpacity="0.35" strokeDasharray="5 6" />
        )}
        {gold1h && (
          <path
            d={gold1h}
            fill="none"
            stroke="#c8a46a"
            strokeWidth={h1.fire ? 2.2 : 1.6}
            strokeDasharray={h1.fire ? "0" : "6 5"}
          />
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
