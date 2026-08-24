import { useEffect, useState } from "react";
import { Header } from "./components/Header";
import { Hero } from "./components/Hero";
import { LiveChart } from "./components/LiveChart";
import { WhyStrip } from "./components/WhyStrip";
import { PaperTable } from "./components/PaperTable";
import { OrderBook } from "./components/OrderBook";
import type { LiveResponse, TickerResponse } from "./lib/types";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json() as Promise<T>;
}

export default function App() {
  const [live, setLive] = useState<LiveResponse | null>(null);
  const [ticker, setTicker] = useState<TickerResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const [l, t] = await Promise.all([
          getJson<LiveResponse>("/api/live"),
          getJson<TickerResponse>("/api/ticker").catch(() => null),
        ]);
        if (stop) return;
        setLive(l);
        if (t) setTicker(t);
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
  }, []);

  return (
    <div className="mx-auto min-h-screen max-w-[1440px]">
      <Header
        ticker={ticker}
        tau={live?.tau ?? 0.58}
        fallbackPrice={live?.signal.close ?? 0}
      />
      <main className="grid gap-4 p-4 lg:grid-cols-[1fr_300px]">
        <div className="flex min-w-0 flex-col gap-4">
          {err && (
            <div className="rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
              {err}
            </div>
          )}
          {live ? (
            <>
              <Hero live={live} />
              <LiveChart live={live} />
              <WhyStrip live={live} />
              <PaperTable live={live} />
            </>
          ) : (
            <div className="rounded-xl border border-line bg-card px-6 py-16 text-center text-muted">
              Connexion au flux Coinbase BTC-USD…
            </div>
          )}
        </div>
        {live ? <OrderBook book={live.book} /> : <div className="rounded-xl border border-line bg-card" />}
      </main>
      <footer className="border-t border-line px-5 py-4 text-[11px] leading-relaxed text-muted">
        Jouet de recherche, pas un conseil financier. Prix live publics Coinbase Exchange (BTC-USD :
        ticker, carnet, trades). Le modèle 5s a été entraîné hors-ligne sur des archives 1s Binance
        Vision (features relatives, sans fuite). Le paper trading est en mémoire par instance Netlify —
        un redémarrage à froid remet le compteur à zéro.
        {live?.test?.gated_acc != null && (
          <>
            {" "}
            Test OOS : {(live.test.gated_acc * 100).toFixed(1).replace(".", ",")} % gated vs naive{" "}
            {(live.test.naive_last_acc * 100).toFixed(1).replace(".", ",")} % (couverture{" "}
            {(live.test.coverage * 100).toFixed(0).replace(".", ",")} %).
          </>
        )}
      </footer>
    </div>
  );
}
