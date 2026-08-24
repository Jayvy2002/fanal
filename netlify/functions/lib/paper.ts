import type { Paper, PaperRow, Side, Signal } from "./types";

const HORIZON_MS = 5000;
const MAX_RECENT = 40;

type State = {
  n: number;
  hits: number;
  pending: PaperRow | null;
  recent: PaperRow[];
};

const memory: State = {
  n: 0,
  hits: 0,
  pending: null,
  recent: [],
};

function cloneRow(r: PaperRow): PaperRow {
  return { ...r };
}

function signedBps(side: Exclude<Side, "flat">, mid: number, midEnd: number): number {
  if (mid <= 0) return 0;
  const raw = ((midEnd - mid) / mid) * 1e4;
  return side === "up" ? raw : -raw;
}

function hitOf(side: Exclude<Side, "flat">, mid: number, midEnd: number): boolean {
  return side === "up" ? midEnd > mid : midEnd < mid;
}

function resolve(pending: PaperRow, midEnd: number): PaperRow {
  return {
    ...pending,
    mid_end: midEnd,
    hit: hitOf(pending.side, pending.mid, midEnd),
    signed_bps: signedBps(pending.side, pending.mid, midEnd),
  };
}

/**
 * Sequential 5s paper tape, in-memory per function instance.
 * Netlify Blobs are not required; cold starts reset the tape.
 */
export function updatePaper(now: number, mid: number, signal: Signal): Paper {
  if (memory.pending) {
    const elapsed = now - memory.pending.ts;
    if (elapsed >= HORIZON_MS) {
      const done = resolve(memory.pending, mid);
      memory.pending = null;
      memory.n += 1;
      if (done.hit) memory.hits += 1;
      memory.recent.unshift(done);
      if (memory.recent.length > MAX_RECENT) memory.recent.pop();
    }
  }

  if (!memory.pending && signal.gated && signal.side !== "flat") {
    memory.pending = {
      ts: now,
      side: signal.side,
      label: signal.label as "HAUSSIER" | "BAISSIER",
      mid,
      mid_end: null,
      hit: null,
      signed_bps: null,
      horizon_s: 5,
    };
  }

  const remaining_s = memory.pending
    ? Math.max(0, (HORIZON_MS - (now - memory.pending.ts)) / 1000)
    : 0;

  return {
    n: memory.n,
    hits: memory.hits,
    hit_rate: memory.n > 0 ? memory.hits / memory.n : null,
    pending: memory.pending ? cloneRow(memory.pending) : null,
    remaining_s,
    recent: memory.recent.map(cloneRow),
    horizon_s: 5,
  };
}

export function paperSnapshot(): Pick<State, "n" | "hits"> {
  return { n: memory.n, hits: memory.hits };
}
