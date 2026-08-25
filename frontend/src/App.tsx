import { useEffect, useState } from "react";
import { Header } from "./components/Header";
import { Hero } from "./components/Hero";
import { LiveChart } from "./components/LiveChart";
import { WhyStrip } from "./components/WhyStrip";
import { PolyPaper } from "./components/PolyPaper";
import { PolyBook } from "./components/PolyBook";
import { OrderBook } from "./components/OrderBook";
import type { LiveResponse } from "./lib/types";

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
    const id = setInterval(tick, 1000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [symbol]);

  const intra = live?.predict.intra;
  const test = intra?.test;

  return (
    <div className="mx-auto min-h-screen max-w-[1440px]">
      <Header
        ticker={live?.ticker ?? null}
        symbol={symbol}
        onSymbol={setSymbol}
        fire={Boolean(intra?.fire)}
        fallbackPrice={intra?.close ?? 0}
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
              <PolyPaper live={live} />
            </>
          ) : (
            <div className="rounded-xl border border-line bg-card px-6 py-16 text-center text-muted">
              Connexion au prédicteur Coinbase + marchés Polymarket publics…
            </div>
          )}
        </div>
        <div className="flex flex-col gap-4">
          {live ? <PolyBook live={live} /> : <div className="rounded-xl border border-line bg-card min-h-40" />}
          {live ? <OrderBook book={live.book} /> : null}
        </div>
      </main>
      <footer className="border-t border-line px-5 py-4 text-[11px] leading-relaxed text-muted">
        Jouet de recherche, pas un conseil financier. Prédicteur = fair value TWAP Chainlink vs CLOB 5 m
        (Coinbase 1 m seulement pour la vol). Le bot paper n’appelle que <code>/api/predict</code>. Aucun ordre
        Polymarket ni Coinbase. Aucune clé. Aucun retrait. Bande 40–60 ¢ skippée. Lock à 90 ¢ : hurdle ≈ 91 %.
        {test?.e_usdc != null && (
          <>
            {" "}
            TEST paper (BTC, 36 h, après frais taker) : E {test.e_usdc.toFixed(2).replace(".", ",")} USDC / trade
            (n={test.n}, cov {((test.coverage ?? 0) * 100).toFixed(0)} %, wr{" "}
            {test.win_rate != null ? `${(test.win_rate * 100).toFixed(0)} %` : "—"}
            ) vs naive favorite {test.naive_e_usdc != null ? `${test.naive_e_usdc.toFixed(2).replace(".", ",")} USDC` : "—"}.
          </>
        )}
      </footer>
    </div>
  );
}
