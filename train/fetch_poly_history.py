#!/usr/bin/env python3
"""Télécharge CLOB prices-history + candles Coinbase pour le backtest paper (pas d'ordres)."""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

UA = {
    "User-Agent": "Mozilla/5.0 (compatible; FanalResearch/1.0)",
    "Accept": "application/json",
}
GAMMA = "https://gamma-api.polymarket.com"
CLOB = "https://clob.polymarket.com"
CB = "https://api.exchange.coinbase.com"
OUT = Path(__file__).resolve().parents[1] / "data" / "poly"
HOURS = int(os.environ.get("POLY_HOURS", "36"))
WORKERS = int(os.environ.get("POLY_WORKERS", "10"))


def get_json(url: str, retries: int = 4) -> object:
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode())
        except Exception as e:
            last = e
            time.sleep(0.25 * (i + 1))
    raise last  # type: ignore


def fetch_candles(product: str, start: int, end: int) -> list:
    """Coinbase 1m, max 300/req. [time, low, high, open, close, volume]."""
    out: list = []
    t = start
    while t < end:
        chunk_end = min(t + 300 * 60, end)
        url = (
            f"{CB}/products/{product}/candles?granularity=60"
            f"&start={time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(t))}"
            f"&end={time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(chunk_end))}"
        )
        rows = get_json(url)
        if isinstance(rows, list):
            out.extend(rows)
        t = chunk_end
        time.sleep(0.08)
    out.sort(key=lambda x: x[0])
    # dédup
    seen = {}
    for row in out:
        seen[int(row[0])] = row
    return [seen[k] for k in sorted(seen)]


def fetch_slot(asset: str, slot: int) -> dict | None:
    slug = f"{asset.lower()}-updown-5m-{slot}"
    try:
        evs = get_json(f"{GAMMA}/events?slug={slug}")
    except urllib.error.HTTPError as e:
        if e.code in (404, 422):
            return None
        raise
    if not isinstance(evs, list) or not evs:
        return None
    ev = evs[0]
    m = (ev.get("markets") or [None])[0]
    if not m:
        return None
    try:
        tokens = json.loads(m.get("clobTokenIds") or "[]")
        outcomes = json.loads(m.get("outcomes") or "[]")
        prices = json.loads(m.get("outcomePrices") or "[]")
    except json.JSONDecodeError:
        return None
    if len(tokens) < 2:
        return None
    up_i = 0
    down_i = 1
    for i, o in enumerate(outcomes):
        if str(o).lower() == "up":
            up_i = i
        if str(o).lower() == "down":
            down_i = i
    up_tok = tokens[up_i]
    hist_url = (
        f"{CLOB}/prices-history?market={up_tok}"
        f"&startTs={slot - 5}&endTs={slot + 320}&fidelity=1"
    )
    hist = get_json(hist_url)
    history = hist.get("history") if isinstance(hist, dict) else hist
    if not isinstance(history, list):
        history = []
    winner = None
    if len(prices) >= 2:
        try:
            pu, pd = float(prices[up_i]), float(prices[down_i])
            if pu >= 0.9:
                winner = "up"
            elif pd >= 0.9:
                winner = "down"
        except (TypeError, ValueError):
            pass
    if winner is None and history:
        last_p = float(history[-1].get("p") or 0)
        if last_p >= 0.9:
            winner = "up"
        elif last_p <= 0.1:
            winner = "down"
    return {
        "asset": asset,
        "slot": slot,
        "slug": ev.get("slug") or slug,
        "up_token": up_tok,
        "resolution_source": m.get("resolutionSource") or ev.get("resolutionSource"),
        "outcome_prices": prices,
        "winner": winner,
        "history": history,
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    now = int(time.time())
    end_slot = now - (now % 300) - 300  # dernier créneau clos
    start_slot = end_slot - HOURS * 3600
    slots = list(range(start_slot, end_slot + 1, 300))
    jobs = [(a, s) for a in ("BTC", "ETH") for s in slots]
    print(f"fetch {len(jobs)} marchés, {HOURS} h, workers={WORKERS}", flush=True)

    markets: list[dict] = []
    ok = 0
    fail = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(fetch_slot, a, s): (a, s) for a, s in jobs}
        for i, fut in enumerate(as_completed(futs), 1):
            a, s = futs[fut]
            try:
                row = fut.result()
                if row and row["history"]:
                    markets.append(row)
                    ok += 1
                else:
                    fail += 1
            except Exception as e:
                fail += 1
                if fail <= 8:
                    print(f"fail {a} {s}: {e}", flush=True)
            if i % 80 == 0:
                print(f"  {i}/{len(jobs)} ok={ok} fail={fail}", flush=True)

    t0 = start_slot - 3600
    t1 = end_slot + 600
    print("candles Coinbase…", flush=True)
    candles = {
        "BTC-USD": fetch_candles("BTC-USD", t0, t1),
        "ETH-USD": fetch_candles("ETH-USD", t0, t1),
    }
    payload = {
        "hours": HOURS,
        "start_slot": start_slot,
        "end_slot": end_slot,
        "n_markets": len(markets),
        "markets": markets,
        "candles": candles,
        "fetched_ts": now,
        "note": "CLOB last/mid (pas bid/ask). Strike/TWAP = proxy Coinbase 1m, pas le flux officiel Chainlink.",
    }
    dest = OUT / "history.json"
    dest.write_text(json.dumps(payload))
    print(f"wrote {dest} markets={len(markets)} btc_bars={len(candles['BTC-USD'])} eth_bars={len(candles['ETH-USD'])}")


if __name__ == "__main__":
    main()
