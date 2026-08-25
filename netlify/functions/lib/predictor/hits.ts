/**
 * Hit/miss après l’horizon — mémoire locale, pas un carnet d’ordres.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PredictHit, PredictSide, PredictSymbol } from "./contract";

const FILE = path.join(os.tmpdir(), "fanal-forecast-hits.json");

type Rec = {
  symbol: PredictSymbol;
  horizon_s: number;
  origin_bar_ts: number;
  origin_close: number;
  side: PredictSide;
  fire: boolean;
  p_up: number;
  resolved_ts?: number;
  future_close?: number;
  hit?: boolean | null;
};

type Store = { recs: Rec[] };

let memo: Store | null = null;

async function load(): Promise<Store> {
  if (memo) return memo;
  try {
    const raw = await readFile(FILE, "utf8");
    memo = JSON.parse(raw) as Store;
    if (!Array.isArray(memo.recs)) memo = { recs: [] };
  } catch {
    memo = { recs: [] };
  }
  return memo;
}

async function save(s: Store): Promise<void> {
  memo = s;
  await mkdir(path.dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(s));
}

export function noteForecast(rec: Omit<Rec, "resolved_ts" | "future_close" | "hit">): void {
  void (async () => {
    const s = await load();
    const key = `${rec.symbol}:${rec.horizon_s}`;
    s.recs = s.recs.filter((r) => !(r.symbol === rec.symbol && r.horizon_s === rec.horizon_s && !r.resolved_ts && r.origin_bar_ts === rec.origin_bar_ts));
    const open = s.recs.find((r) => r.symbol === rec.symbol && r.horizon_s === rec.horizon_s && !r.resolved_ts);
    if (open && open.origin_bar_ts === rec.origin_bar_ts) {
      Object.assign(open, rec);
    } else if (!open || open.origin_bar_ts !== rec.origin_bar_ts) {
      if (open) {
        /* laisser l’ancien ouvert jusqu’à résolution */
      }
      const exists = s.recs.some((r) => r.symbol === rec.symbol && r.horizon_s === rec.horizon_s && r.origin_bar_ts === rec.origin_bar_ts);
      if (!exists) s.recs.push({ ...rec });
    }
    if (s.recs.length > 80) s.recs = s.recs.slice(-80);
    await save(s);
    void key;
  })();
}

export function resolveHit(symbol: PredictSymbol, horizon_s: number, lastClose: number, now: number): PredictHit | null {
  const s = memo;
  if (!s) {
    void load();
    return null;
  }
  const open = [...s.recs].reverse().find((r) => r.symbol === symbol && r.horizon_s === horizon_s);
  if (!open) return null;
  const due = open.origin_bar_ts + horizon_s * 1000;
  if (now < due) {
    return {
      horizon_s,
      origin_bar_ts: open.origin_bar_ts,
      origin_close: open.origin_close,
      side: open.side,
      fire: open.fire,
      resolved: false,
      hit: null,
      future_close: null,
    };
  }
  if (open.resolved_ts == null) {
    const up = lastClose > open.origin_close;
    const hit = open.side === "flat" || !open.fire ? null : open.side === "up" ? up : !up;
    open.resolved_ts = now;
    open.future_close = lastClose;
    open.hit = hit;
    void save(s);
  }
  return {
    horizon_s,
    origin_bar_ts: open.origin_bar_ts,
    origin_close: open.origin_close,
    side: open.side,
    fire: open.fire,
    resolved: open.resolved_ts != null,
    hit: open.hit ?? null,
    future_close: open.future_close ?? lastClose,
  };
}
