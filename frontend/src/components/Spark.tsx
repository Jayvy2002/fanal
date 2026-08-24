import type { LiveResponse, PaperRow, SparkPoint } from "../lib/types";

function xAt(i: number, n: number, w: number, pad: number) {
  if (n <= 1) return pad;
  return pad + (i / (n - 1)) * (w - 2 * pad);
}

function nearestIndex(points: SparkPoint[], ts: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = Math.abs(points[i].t - ts);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

export function Spark({ live }: { live: LiveResponse }) {
  const points = live.spark;
  const w = 900;
  const h = 168;
  const pad = 10;
  if (points.length < 2) {
    return (
      <section className="rounded-xl border border-line bg-card px-5 py-4">
        <div className="text-[11px] tracking-[0.16em] text-muted">PRIX 1S ~3 MIN</div>
        <div className="mt-6 text-sm text-muted">En attente des bougies 1s…</div>
      </section>
    );
  }
  const prices = points.map((p) => p.p);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const span = hi - lo || 1;
  const y = (p: number) => pad + (1 - (p - lo) / span) * (h - 2 * pad);
  const d = points
    .map((pt, i) => `${i === 0 ? "M" : "L"}${xAt(i, points.length, w, pad).toFixed(1)},${y(pt.p).toFixed(1)}`)
    .join(" ");
  const area = `${d} L${xAt(points.length - 1, points.length, w, pad)},${h - pad} L${pad},${h - pad} Z`;

  const marks: { row: PaperRow; pending: boolean }[] = [
    ...live.paper.recent.map((row) => ({ row, pending: false })),
    ...(live.paper.pending ? [{ row: live.paper.pending, pending: true }] : []),
  ];

  return (
    <section className="rounded-xl border border-line bg-card px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] tracking-[0.16em] text-muted">PRIX 1S ~3 MIN</div>
        <div className="text-[10px] tracking-[0.14em] text-muted">
          ▲ SIGNAL · VERT = HIT · ROUGE = MISS · OR = EN COURS
        </div>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="mt-2 h-40 w-full" role="img" aria-label="Prix BTC 1 seconde">
        <defs>
          <linearGradient id="sparkFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#8ea0b5" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#8ea0b5" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#sparkFill)" />
        <path d={d} fill="none" stroke="#8ea0b5" strokeWidth="1.6" />
        {marks.map(({ row, pending }) => {
          const i = nearestIndex(points, row.ts);
          if (Math.abs(points[i].t - row.ts) > 2000) return null;
          const cx = xAt(i, points.length, w, pad);
          const cy = y(points[i].p);
          const fill = pending ? "#c8a46a" : row.hit ? "#3dd68c" : "#f0616d";
          return (
            <g key={`${row.ts}-${row.side}-${pending ? "p" : "d"}`}>
              <line
                x1={cx}
                x2={cx}
                y1={pad}
                y2={h - pad}
                stroke={fill}
                strokeOpacity="0.25"
                strokeWidth="1"
              />
              {pending ? (
                <circle cx={cx} cy={cy} r="4.2" fill={fill} />
              ) : (
                <polygon points={`${cx},${cy - 6} ${cx + 5},${cy + 4} ${cx - 5},${cy + 4}`} fill={fill} />
              )}
            </g>
          );
        })}
      </svg>
    </section>
  );
}
