import { useMemo, useState, type MouseEvent } from "react";
import {
  fmtClock,
  nfBps,
  nfPrice,
  type Forecast,
  type LiveResponse,
  type SparkPoint,
} from "../lib/types";

const W = 1120;
const H = 420;
const PAD = { l: 18, r: 88, t: 28, b: 32 };

function colorOf(f: Forecast): string {
  if (f.hit === null) return "#c8a46a";
  return f.hit ? "#3dd68c" : "#f0616d";
}

function poly(path: { t: number; p: number }[], x: (t: number) => number, y: (p: number) => number): string {
  return path
    .map((pt, i) => `${i === 0 ? "M" : "L"}${x(pt.t).toFixed(1)},${y(pt.p).toFixed(1)}`)
    .join(" ");
}

export function LiveChart({ live }: { live: LiveResponse }) {
  const [hover, setHover] = useState<{ t: number; p: number } | null>(null);
  const spark = live.spark;
  const now = live.now || spark[spark.length - 1]?.t || Date.now();

  const geo = useMemo(() => {
    const tMin = now - 270_000;
    const tMax = now + 18_000;
    const vis = spark.filter((s) => s.t >= tMin && s.t <= now);
    const prices: number[] = [];
    for (const s of vis) {
      prices.push(s.p);
      if (s.h != null) prices.push(s.h);
      if (s.l != null) prices.push(s.l);
    }
    for (const f of live.forecasts) {
      for (const pt of f.path) {
        if (pt.t >= tMin && pt.t <= tMax) prices.push(pt.p);
      }
      if (f.target_px) prices.push(f.target_px);
    }
    if (live.signal.target_px) prices.push(live.signal.target_px);
    let lo = Math.min(...prices);
    let hi = Math.max(...prices);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      lo = 0;
      hi = 1;
    }
    const span = hi - lo || Math.max(Math.abs(hi) * 1e-5, 1);
    const pad = span * 0.12;
    lo -= pad;
    hi += pad;
    const plotW = W - PAD.l - PAD.r;
    const plotH = H - PAD.t - PAD.b;
    const x = (t: number) => PAD.l + ((t - tMin) / (tMax - tMin)) * plotW;
    const y = (p: number) => PAD.t + (1 - (p - lo) / (hi - lo)) * plotH;
    return { tMin, tMax, vis, lo, hi, span: hi - lo, x, y, plotW, plotH };
  }, [spark, live.forecasts, live.signal.target_px, now]);

  if (spark.length < 2) {
    return (
      <section className="rounded-xl border border-line bg-card px-5 py-4">
        <div className="text-[11px] tracking-[0.16em] text-muted">PRIX LIVE · BTC-USD · 1s</div>
        <div className="mt-8 text-sm text-muted">Reconstruction des barres 1s Coinbase…</div>
      </section>
    );
  }

  const { vis, lo, hi, x, y, tMin, tMax, plotW, plotH } = geo;
  const yTicks = 4;
  const yVals = Array.from({ length: yTicks + 1 }, (_, i) => lo + ((hi - lo) * i) / yTicks);
  const tTicks = 6;
  const tVals = Array.from({ length: tTicks + 1 }, (_, i) => tMin + ((tMax - tMin) * i) / tTicks);

  const pending5 = live.forecasts.find((f) => f.hit === null && f.horizon_s === 5);
  const pending15 = live.forecasts.find((f) => f.hit === null && f.horizon_s === 15);
  const resolved = [
    ...live.forecasts.filter((f) => f.hit !== null && f.horizon_s === 5).slice(0, 20),
    ...live.forecasts.filter((f) => f.hit !== null && f.horizon_s === 15).slice(0, 12),
  ];

  const candleW = vis.length > 1 ? Math.max(1.1, Math.min(4.2, (x(vis[1].t) - x(vis[0].t)) * 0.72)) : 2;

  const onMove = (ev: MouseEvent<SVGSVGElement>) => {
    const svg = ev.currentTarget;
    const box = svg.getBoundingClientRect();
    const px = ((ev.clientX - box.left) / box.width) * W;
    const t = tMin + ((px - PAD.l) / plotW) * (tMax - tMin);
    let best = vis[0];
    let bestD = Infinity;
    for (const s of vis) {
      const d = Math.abs(s.t - t);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    if (best) setHover({ t: best.t, p: best.p });
  };

  return (
    <section className="rounded-xl border border-line bg-card px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="text-[11px] tracking-[0.16em] text-muted">PRIX LIVE · BTC-USD · BOUGIES 1s</div>
          <div className="mt-1 text-[12px] text-white/70">
            Coinbase · ~{Math.round((now - (vis[0]?.t ?? now)) / 1000)} s d’historique · curseur = maintenant
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[10px] tracking-[0.12em] text-muted">
          <span className="inline-flex items-center gap-1">
            <span className="h-px w-4 border-t-2 border-dashed border-gold" /> OR = prévu
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-[3px] w-3 rounded-sm bg-up" /> VERT = match
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-[3px] w-3 rounded-sm bg-down" /> ROUGE = raté
          </span>
        </div>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="mt-2 h-[340px] w-full sm:h-[400px]"
        role="img"
        aria-label="Prix Bitcoin Coinbase BTC-USD avec trajectoire prévue"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="plotFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#8ea0b5" stopOpacity="0.10" />
            <stop offset="100%" stopColor="#8ea0b5" stopOpacity="0" />
          </linearGradient>
          <filter id="goldGlow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="2.2" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {yVals.map((v) => (
          <g key={`y-${v}`}>
            <line
              x1={PAD.l}
              x2={W - PAD.r}
              y1={y(v)}
              y2={y(v)}
              stroke="#ffffff"
              strokeOpacity="0.05"
            />
            <text
              x={W - PAD.r + 8}
              y={y(v) + 4}
              fill="#8b919c"
              fontSize="11"
              fontFamily="IBM Plex Mono, ui-monospace, monospace"
            >
              {nfPrice.format(v)}
            </text>
          </g>
        ))}

        {tVals.map((t) => (
          <text
            key={`t-${t}`}
            x={x(t)}
            y={H - 10}
            fill="#8b919c"
            fontSize="10"
            textAnchor="middle"
            fontFamily="IBM Plex Mono, ui-monospace, monospace"
          >
            {fmtClock(t)}
          </text>
        ))}

        {/* future band */}
        <rect
          x={x(now)}
          y={PAD.t}
          width={Math.max(0, PAD.l + plotW - x(now))}
          height={plotH}
          fill="#c8a46a"
          fillOpacity="0.05"
        />

        {vis.length > 1 && (
          <path
            d={`${poly(vis, x, y)} L${x(vis[vis.length - 1].t)},${PAD.t + plotH} L${x(vis[0].t)},${PAD.t + plotH} Z`}
            fill="url(#plotFill)"
          />
        )}

        {vis.map((c: SparkPoint) => {
          const cx = x(c.t);
          const o = c.o ?? c.p;
          const hgt = c.h ?? c.p;
          const low = c.l ?? c.p;
          const cl = c.p;
          const up = cl >= o;
          const stroke = up ? "#3dd68c99" : "#f0616d99";
          const yO = y(o);
          const yC = y(cl);
          const top = Math.min(yO, yC);
          const bodyH = Math.max(1.1, Math.abs(yC - yO));
          return (
            <g key={c.t}>
              <line x1={cx} x2={cx} y1={y(hgt)} y2={y(low)} stroke={stroke} strokeWidth="1" />
              <rect
                x={cx - candleW / 2}
                y={top}
                width={candleW}
                height={bodyH}
                fill={up ? "#3dd68c55" : "#f0616d55"}
                stroke={stroke}
                strokeWidth="0.6"
              />
            </g>
          );
        })}

        {resolved.map((f) => {
          if (f.path.length < 2) return null;
          const col = colorOf(f);
          const faint = f.horizon_s === 15;
          return (
            <path
              key={`r-${f.ts}-${f.horizon_s}`}
              d={poly(f.path, x, y)}
              fill="none"
              stroke={col}
              strokeWidth={faint ? 1.3 : 2.1}
              strokeOpacity={faint ? 0.35 : 0.88}
              strokeLinecap="round"
            />
          );
        })}

        {pending15 && pending15.path.length > 1 && (
          <path
            d={poly(pending15.path, x, y)}
            fill="none"
            stroke="#c8a46a"
            strokeWidth="1.4"
            strokeDasharray="3 5"
            strokeOpacity="0.45"
            strokeLinecap="round"
          />
        )}

        {pending5 && pending5.path.length > 1 && (
          <g filter="url(#goldGlow)">
            <path
              d={poly(pending5.path, x, y)}
              fill="none"
              stroke="#c8a46a"
              strokeWidth="2.4"
              strokeDasharray="6 5"
              strokeLinecap="round"
            />
            <circle
              cx={x(pending5.path[pending5.path.length - 1].t)}
              cy={y(pending5.target_px)}
              r="4.5"
              fill="#c8a46a"
            />
            <text
              x={x(pending5.path[pending5.path.length - 1].t) + 8}
              y={y(pending5.target_px) - 8}
              fill="#c8a46a"
              fontSize="11"
              fontFamily="IBM Plex Mono, ui-monospace, monospace"
            >
              {nfPrice.format(pending5.target_px)} · {nfBps.format(pending5.expected_move_bps)} bps
            </text>
          </g>
        )}

        <line
          x1={x(now)}
          x2={x(now)}
          y1={PAD.t}
          y2={PAD.t + plotH}
          stroke="#e8eaee"
          strokeWidth="1.2"
          strokeOpacity="0.85"
        />
        <text
          x={x(now) - 6}
          y={PAD.t - 8}
          fill="#e8eaee"
          fontSize="10"
          textAnchor="end"
          letterSpacing="0.12em"
        >
          MAINTENANT
        </text>

        {hover && (
          <g>
            <line
              x1={x(hover.t)}
              x2={x(hover.t)}
              y1={PAD.t}
              y2={PAD.t + plotH}
              stroke="#ffffff"
              strokeOpacity="0.15"
            />
            <circle cx={x(hover.t)} cy={y(hover.p)} r="3.5" fill="#e8eaee" />
            <text
              x={x(hover.t) + 8}
              y={y(hover.p) - 10}
              fill="#e8eaee"
              fontSize="11"
              fontFamily="IBM Plex Mono, ui-monospace, monospace"
            >
              {fmtClock(hover.t)} · {nfPrice.format(hover.p)}
            </text>
          </g>
        )}
      </svg>
    </section>
  );
}
