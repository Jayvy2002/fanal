export type Side = "up" | "down" | "flat";

export type Signal = {
  side: Side;
  label: "HAUSSIER" | "BAISSIER" | "NEUTRE";
  p_up: number;
  confidence: number;
  gated: boolean;
  horizon_s: number;
  why: string;
  close: number;
  tau: number;
};

export type BookLevel = { p: number; q: number };

export type Book = {
  mid: number;
  obi_10: number;
  tilt: "achat" | "vente" | "neutre";
  bids: BookLevel[];
  asks: BookLevel[];
  spread_bps: number;
};

export type SparkPoint = { t: number; p: number; side: Side | null };

export type PaperRow = {
  ts: number;
  side: "up" | "down";
  label: "HAUSSIER" | "BAISSIER";
  mid: number;
  mid_end: number | null;
  hit: boolean | null;
  signed_bps: number | null;
  horizon_s: number;
};

export type Paper = {
  n: number;
  hits: number;
  hit_rate: number | null;
  pending: PaperRow | null;
  remaining_s: number;
  recent: PaperRow[];
  horizon_s: number;
};

export type LiveResponse = {
  signal: Signal;
  flux: Signal & { ret_5_bps: number | null; rv_60: number | null };
  book: Book;
  spark: SparkPoint[];
  paper: Paper;
  error: string | null;
  kind: string;
  horizon_s: number;
  bar_s: number;
  tau: number;
  test: {
    gated_acc: number | null;
    n: number;
    coverage: number;
    naive_last_acc: number;
  };
};

export type TickerResponse = {
  symbol: string;
  last: number;
  change: number;
  change_pct: number;
  high: number;
  low: number;
  volume: number;
  ts: number;
};

export const nfPrice = new Intl.NumberFormat("fr-FR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export const nfPct = new Intl.NumberFormat("fr-FR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: "exceptZero",
});

export const nfP = new Intl.NumberFormat("fr-FR", {
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});

export const nfBps = new Intl.NumberFormat("fr-FR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: "exceptZero",
});

export const nfInt = new Intl.NumberFormat("fr-FR");

export function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function fmtCd(s: number): string {
  const x = Math.max(0, Math.round(s));
  return `0:${String(x).padStart(2, "0")}`;
}

export function signalColor(label: Signal["label"]): string {
  if (label === "HAUSSIER") return "#3dd68c";
  if (label === "BAISSIER") return "#f0616d";
  return "#c8a46a";
}
