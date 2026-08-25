import { useEffect, useState } from "react";
import { Header } from "./components/Header";
import { Hero } from "./components/Hero";
import { LiveChart } from "./components/LiveChart";
import { WhyStrip } from "./components/WhyStrip";
import { Scoreboard } from "./components/Scoreboard";
import { PolyPaper } from "./components/PolyPaper";
import { PolyBook } from "./components/PolyBook";
import { OrderBook } from "./components/OrderBook";
import { bpsFr, headsOf, pctFr, type LiveResponse } from "./lib/types";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json() as Promise<T>;
}

export default function App() {
  const [symbol, setSymbol] = useState<"BTC-USD" | "ETH-USD">("BTC-USD");
  const [live, setLive] = useState<LiveResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const l = await getJson<LiveResponse>(`/api/live?symbol=${symbol}`);
        if (stop) return;
        setLive(l);
        setErr(l.error);
      } catch (e) {
        if (!stop) setErr(e instanceof Error ? e.message : "réseau");
      }
    };
    tick();
    const id = setInterval(tick, 4000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [symbol]);

  const { h1, h4 } = live ? headsOf(live) : { h1: null, h4: null };
  const t1 = h1?.test;
  const t4 = h4?.test;

  return (
    <div className="mx-auto min-h-screen max-w-[1440px]">
      <Header
        ticker={live?.ticker ?? null}
        symbol={symbol}
        onSymbol={setSymbol}
        fire={Boolean(h1?.fire)}
        fallbackPrice={h1?.close ?? 0}
      />
      <main className="grid gap-4 p-4 lg:grid-cols-[1fr_300px]">
        <div className="flex min-w-0 flex-col gap-4">
          {err && (
            <div className="rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">{err}</div>
          )}
          {live ? (
            <>
              <Hero live={live} />
              <LiveChart live={live} />
              <WhyStrip live={live} />
              <Scoreboard live={live} />
              <PolyPaper live={live} />
            </>
          ) : (
            <div className="rounded-xl border border-line bg-card px-6 py-16 text-center text-muted">
              Connexion au prédicteur Coinbase 1 h / 4 h…
            </div>
          )}
        </div>
        <div className="flex flex-col gap-4">
          {live ? <PolyBook live={live} /> : <div className="rounded-xl border border-line bg-card min-h-40" />}
          {live ? <OrderBook book={live.book} /> : null}
        </div>
      </main>
      <footer className="border-t border-line px-5 py-4 text-[11px] leading-relaxed text-muted">
        Jouet de recherche, pas un conseil financier. Produit = prédicteur directionnel 1 h / 4 h sur bougies Coinbase
        5 m. Paper Polymarket 5 min <strong>éteint</strong> (aucun ticket). Aucun ordre live, aucune clé. TEST 1 h :
        acc plat {pctFr(t1?.flat_acc)} vs naive {pctFr(t1?.naive_last_acc)}, E@10 bp {bpsFr(t1?.expectancy_10bp)}. TEST
        4 h : acc plat {pctFr(t4?.flat_acc)} vs naive {pctFr(t4?.naive_last_acc)} — la 4 h à plat ne bat pas le naive.
      </footer>
    </div>
  );
}
