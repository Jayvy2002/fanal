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
    const id = setInterval(tick, 5000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);

  const cov = live?.test?.coverage;
  const lowCov = cov != null && cov < 0.01;

  return (
    <div className="mx-auto min-h-screen max-w-[1440px]">
      <Header
        ticker={ticker}
        tau={live?.tau ?? 0.58}
        minMoveBps={live?.min_move_bps ?? live?.signal.min_move_bps ?? 120}
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
              <PaperTable
                live={live}
                onPaper={(paper) => setLive((cur) => (cur ? { ...cur, paper } : cur))}
              />
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
        Jouet de recherche, pas un conseil financier. Live = bougies 1 minute Coinbase Exchange BTC-USD
        (REST public, sans clé). Features = dernière barre 1m <strong>complète</strong> (pas la minute en
        cours). Feu HAUSSIER / BAISSIER si P(↑ 15m) sort de [0,42 ; 0,58] <em>et</em> |move| prévu ≥ 120 bp
        (RT faiseur, Advanced Trade intro non vérifié). Paper faiseur 15 min, clip 75 $ US, 1 000 $ US.
        Aucun ordre Coinbase réel.
        {live?.test?.gated_acc != null && (
          <>
            {" "}
            TEST 15m (gate 120 bp) : {(live.test.gated_acc * 100).toFixed(1).replace(".", ",")} % gated, n=
            {live.test.n}, cov {((live.test.coverage ?? 0) * 100).toFixed(2).replace(".", ",")} %
            {live.test.mean_abs_move_bps != null || live.test.all_test_mean_abs_bps != null
              ? `, |move| 15m ${(live.test.mean_abs_move_bps ?? live.test.all_test_mean_abs_bps)!.toFixed(1).replace(".", ",")} bp`
              : ""}
            {live.test.expectancy_maker_rt != null
              ? `, E après RT faiseur ${live.test.expectancy_maker_rt.toFixed(1).replace(".", ",")} bp`
              : ""}
            {live.test.expectancy_taker_rt != null
              ? `, E après RT preneur ${live.test.expectancy_taker_rt.toFixed(1).replace(".", ",")} bp`
              : ""}
            .
          </>
        )}
        {lowCov && (
          <>
            {" "}
            Couverture au gate frais ≈ 0 : le |move| 15 m BTC est trop souvent sous 120 bp. C’est un
            résultat honnête, pas un jour vert.
          </>
        )}
        {live?.train_n_days != null && (
          <>
            {" "}
            Entraînement Coinbase 1m : {live.train_n_days.toFixed(1).replace(".", ",")} j
            {live.train_n_bars != null ? ` (${live.train_n_bars.toLocaleString("fr-FR")} barres)` : ""}.
          </>
        )}
      </footer>
    </div>
  );
}
