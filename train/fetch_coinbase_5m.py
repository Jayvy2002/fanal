#!/usr/bin/env python3
"""Fetch public Coinbase Exchange 5-minute candles (no API key)."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
BASE = "https://api.exchange.coinbase.com"
HEADERS = {
    "Accept": "application/json",
    "User-Agent": "FanalResearch/1.0",
}
# 300 candles * 300s = 25 h / request
GRANULARITY = 300
CHUNK_S = 300 * GRANULARITY
SLEEP_S = 0.16


def iso(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def get_json(url: str, retries: int = 6) -> list:
    last: Exception | None = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            last = e
            if e.code == 429:
                time.sleep(0.5 * (i + 1))
                continue
            if e.code >= 500:
                time.sleep(0.3 * (i + 1))
                continue
            raise
        except Exception as e:
            last = e
            time.sleep(0.3 * (i + 1))
    raise last if last else RuntimeError("coinbase_5m_fetch")


def fetch_product(product: str, days: int) -> list[dict]:
    end = int(time.time())
    start = end - days * 86400
    rows: dict[int, dict] = {}
    t1 = end
    n_req = 0
    while t1 > start:
        t0 = max(start, t1 - CHUNK_S)
        url = (
            f"{BASE}/products/{product}/candles"
            f"?granularity={GRANULARITY}&start={iso(t0)}&end={iso(t1)}"
        )
        raw = get_json(url)
        n_req += 1
        for item in raw:
            ts = int(item[0])
            rows[ts] = {
                "open_time": ts * 1000,
                "low": float(item[1]),
                "high": float(item[2]),
                "open": float(item[3]),
                "close": float(item[4]),
                "volume": float(item[5]),
            }
        if n_req % 30 == 0:
            print(f"  {product} req={n_req} bars={len(rows)} t={iso(t0)}", flush=True)
        t1 = t0
        time.sleep(SLEEP_S)
        if not raw and t0 <= start:
            break
    out = [rows[k] for k in sorted(rows)]
    print(f"{product}: {len(out):,} 5m bars from {n_req} requests", flush=True)
    return out


def write_csv(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    import gzip

    with gzip.open(path, "wt", encoding="utf-8") as f:
        f.write("open_time,open,high,low,close,volume\n")
        for r in rows:
            f.write(
                f"{r['open_time']},{r['open']},{r['high']},{r['low']},{r['close']},{r['volume']}\n"
            )


def main(days: int = 150) -> dict[str, Path]:
    DATA.mkdir(parents=True, exist_ok=True)
    paths: dict[str, Path] = {}
    for product in ("BTC-USD", "ETH-USD"):
        path = DATA / f"coinbase_{product.replace('-', '').lower()}_5m.csv.gz"
        if path.exists() and path.stat().st_size > 10_000:
            print(f"reuse {path}", flush=True)
            paths[product] = path
            continue
        print(f"fetch {product} {days}d 5m…", flush=True)
        rows = fetch_product(product, days)
        write_csv(path, rows)
        paths[product] = path
    return paths


if __name__ == "__main__":
    import sys

    d = int(sys.argv[1]) if len(sys.argv) > 1 else 150
    main(d)
