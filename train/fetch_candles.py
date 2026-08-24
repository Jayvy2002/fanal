#!/usr/bin/env python3
"""Download Coinbase Exchange public 1-minute OHLCV candles. No API key.

GET /products/BTC-USD/candles?granularity=60  (max ~300 candles / request).
Paginates start/end windows, respects 429, writes data/coinbase/bars_1m.csv.gz.
"""

from __future__ import annotations

import argparse
import gzip
import json
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "coinbase"
CANDLES_PATH = DATA / "bars_1m.csv.gz"
CKPT_PATH = DATA / "candles_ckpt.json"
PRODUCT = "BTC-USD"
BASE = "https://api.exchange.coinbase.com"
UA = "FanalTrain/1.0"
GRANULARITY = 60
MAX_PER_REQ = 300
WINDOW_S = MAX_PER_REQ * GRANULARITY
RPS = 3.5
MAX_RETRIES = 8


def log(msg: str) -> None:
    print(msg, flush=True)


def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def http_get(path: str) -> bytes:
    url = f"{BASE}{path}"
    req = urllib.request.Request(
        url,
        headers={"User-Agent": UA, "Accept": "application/json", "Cache-Control": "no-cache"},
    )
    last_err: Exception | None = None
    for attempt in range(MAX_RETRIES):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read()
        except urllib.error.HTTPError as exc:
            last_err = exc
            if exc.code == 429:
                time.sleep(0.8 * (attempt + 1) ** 1.5)
                continue
            if exc.code in (500, 502, 503, 504):
                time.sleep(0.5 * (attempt + 1))
                continue
            raise
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            time.sleep(0.4 * (attempt + 1))
    raise RuntimeError(f"GET {path} failed: {last_err}")


def fetch_window(start_s: int, end_s: int) -> list[list]:
    q = (
        f"/products/{PRODUCT}/candles?granularity={GRANULARITY}"
        f"&start={iso(start_s)}&end={iso(end_s)}"
    )
    data = json.loads(http_get(q).decode())
    if not isinstance(data, list):
        raise RuntimeError(f"unexpected candles payload: {str(data)[:200]}")
    return data


def load_existing(path: Path) -> dict[int, list[float]]:
    rows: dict[int, list[float]] = {}
    if not path.exists():
        return rows
    with gzip.open(path, "rt", encoding="utf-8") as f:
        header = f.readline()
        if "open_time" not in header:
            return rows
        for line in f:
            p = line.strip().split(",")
            if len(p) < 6:
                continue
            t = int(int(float(p[0])) // 1000)
            o, h, low, c, v = (float(p[i]) for i in range(1, 6))
            rows[t] = [o, h, low, c, v]
    return rows


def dump_csv(path: Path, rows: dict[int, list[float]]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    items = sorted(rows.items())
    tmp = path.with_suffix(path.suffix + ".tmp")
    with gzip.open(tmp, "wt", encoding="utf-8") as f:
        f.write("open_time,open,high,low,close,volume,count,taker_buy_base\n")
        for t, row in items:
            o, h, low, c, v = row
            f.write(f"{t * 1000},{o},{h},{low},{c},{v},0,0\n")
    tmp.replace(path)
    return len(items)


def fetch_days(n_days: float, granularity: int = GRANULARITY) -> Path:
    if granularity != 60:
        raise SystemExit(f"fetch_candles only supports granularity=60, got {granularity}")
    DATA.mkdir(parents=True, exist_ok=True)
    now = int(time.time())
    now = now - (now % GRANULARITY)
    cutoff = int(now - n_days * 86400)
    cutoff = cutoff - (cutoff % GRANULARITY)

    rows = load_existing(CANDLES_PATH)
    if rows:
        have_min = min(rows)
        have_max = max(rows)
        log(
            f"existing 1m bars={len(rows):,} "
            f"{iso(have_min)} → {iso(have_max)} ({(have_max - have_min) / 86400:.2f} d)"
        )
    else:
        have_min = now
        have_max = cutoff

    # Walk backwards from now in 300-candle windows until cutoff.
    end = now
    pages = 0
    t0 = time.monotonic()
    empty_streak = 0
    while end > cutoff:
        start = max(cutoff, end - WINDOW_S)
        # Skip windows already fully covered (except refresh the newest 2 windows).
        if rows and start >= have_min and end <= have_max and end < now - 2 * WINDOW_S:
            end = start
            continue
        try:
            batch = fetch_window(start, end)
        except Exception as exc:  # noqa: BLE001
            log(f"  warn {iso(start)}–{iso(end)}: {exc}")
            time.sleep(1.2)
            try:
                batch = fetch_window(start, end)
            except Exception as exc2:  # noqa: BLE001
                log(f"  skip {iso(start)}–{iso(end)}: {exc2}")
                end = start
                empty_streak += 1
                if empty_streak > 8:
                    break
                continue
        if not batch:
            empty_streak += 1
            if empty_streak > 6:
                log(f"  empty streak at {iso(start)} — stopping pagination")
                break
            end = start
            time.sleep(1.0 / RPS)
            continue
        empty_streak = 0
        for c in batch:
            # [time_s, low, high, open, close, volume]
            t = int(c[0])
            low, high, o, cl, v = (float(c[i]) for i in range(1, 6))
            if cl <= 0:
                continue
            rows[t] = [o, high, low, cl, v]
        pages += 1
        if pages % 20 == 0 or start <= cutoff:
            elapsed = max(time.monotonic() - t0, 1e-6)
            tmin, tmax = min(rows), max(rows)
            log(
                f"  pages={pages} bars={len(rows):,} "
                f"span={(tmax - tmin) / 86400:.2f}d "
                f"oldest={iso(tmin)} rps={pages / elapsed:.2f}"
            )
            dump_csv(CANDLES_PATH, rows)
            CKPT_PATH.write_text(
                json.dumps(
                    {
                        "product": PRODUCT,
                        "granularity": GRANULARITY,
                        "pages": pages,
                        "n": len(rows),
                        "oldest": tmin,
                        "newest": tmax,
                        "cutoff": cutoff,
                    },
                    indent=2,
                )
            )
        end = start
        time.sleep(1.0 / RPS)

    n = dump_csv(CANDLES_PATH, rows)
    tmin, tmax = (min(rows), max(rows)) if rows else (0, 0)
    span_d = (tmax - tmin) / 86400.0 if rows else 0.0
    log(f"Wrote {CANDLES_PATH} bars={n:,} span={span_d:.2f}d {iso(tmin)} → {iso(tmax)}")
    return CANDLES_PATH


def main() -> int:
    p = argparse.ArgumentParser(description="Fetch Coinbase Exchange 1m candles")
    p.add_argument("--days", type=float, default=90)
    p.add_argument("--granularity", type=int, default=60)
    args = p.parse_args()
    fetch_days(args.days, args.granularity)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
