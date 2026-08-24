#!/usr/bin/env python3
"""Download Coinbase Exchange BTC-USD public trades and rebuild 1s OHLCV bars.

No API key. Paginates GET /products/BTC-USD/trades (limit=1000, `after` trade_id).
Coinbase has no 1s kline archive; this is the live-matching reconstruction.

`side` is the MAKER. Taker buy volume = size when side == "sell".
"""

from __future__ import annotations

import gzip
import json
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "coinbase"
BARS_PATH = DATA / "bars_1s.csv.gz"
CKPT_PATH = DATA / "fetch_ckpt.json"
PRODUCT = "BTC-USD"
BASE = "https://api.exchange.coinbase.com"
UA = "FanalTrain/1.0"
LIMIT = 1000
RPS = 7.5
MAX_WORKERS = 8
MAX_RETRIES = 8


class RateLimiter:
    def __init__(self, rps: float) -> None:
        self.interval = 1.0 / rps
        self._lock = threading.Lock()
        self._next = 0.0

    def wait(self) -> None:
        with self._lock:
            now = time.monotonic()
            slot = max(self._next, now)
            self._next = slot + self.interval
        delay = slot - time.monotonic()
        if delay > 0:
            time.sleep(delay)


LIMITER = RateLimiter(RPS)
PRINT_LOCK = threading.Lock()


def log(msg: str) -> None:
    with PRINT_LOCK:
        print(msg, flush=True)


def parse_iso(iso: str) -> float:
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()


def http_get(path: str) -> tuple[dict[str, str], bytes]:
    url = f"{BASE}{path}"
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "application/json",
            "Cache-Control": "no-cache",
        },
    )
    last_err: Exception | None = None
    for attempt in range(MAX_RETRIES):
        LIMITER.wait()
        try:
            with urllib.request.urlopen(req, timeout=25) as r:
                headers = {k.lower(): v for k, v in r.headers.items()}
                return headers, r.read()
        except urllib.error.HTTPError as exc:
            last_err = exc
            if exc.code == 429:
                time.sleep(0.6 * (attempt + 1) ** 1.4)
                continue
            if exc.code in (500, 502, 503, 504):
                time.sleep(0.4 * (attempt + 1))
                continue
            raise
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            time.sleep(0.35 * (attempt + 1))
    raise RuntimeError(f"GET {path} failed: {last_err}")


def fetch_trades(after: int | None = None, limit: int = LIMIT) -> list[dict]:
    q = f"/products/{PRODUCT}/trades?limit={limit}"
    if after is not None:
        q += f"&after={after}"
    _, blob = http_get(q)
    data = json.loads(blob.decode())
    if not isinstance(data, list):
        raise RuntimeError(f"unexpected trades payload: {str(data)[:200]}")
    return data


class BarBook:
    """Merge-safe 1s bars. first/last trade_id keep OHLC order correct."""

    __slots__ = ("lock", "bars")

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.bars: dict[int, list[float]] = {}
        # value: [open, high, low, close, volume, n, taker_buy, first_id, last_id]

    def ingest(self, trades: list[dict]) -> tuple[int, int, float, float]:
        local: dict[int, list[float]] = {}
        min_id = 10**18
        max_id = 0
        min_ts = 1e18
        max_ts = 0.0
        for tr in trades:
            tid = int(tr["trade_id"])
            px = float(tr["price"])
            sz = float(tr["size"])
            ts = parse_iso(tr["time"])
            bucket = int(ts)
            taker_buy = sz if tr.get("side") == "sell" else 0.0
            if not (px > 0 and sz >= 0):
                continue
            min_id = min(min_id, tid)
            max_id = max(max_id, tid)
            min_ts = min(min_ts, ts)
            max_ts = max(max_ts, ts)
            row = local.get(bucket)
            if row is None:
                local[bucket] = [px, px, px, px, sz, 1.0, taker_buy, float(tid), float(tid)]
                continue
            if tid < row[7]:
                row[0] = px
                row[7] = float(tid)
            if tid > row[8]:
                row[3] = px
                row[8] = float(tid)
            if px > row[1]:
                row[1] = px
            if px < row[2]:
                row[2] = px
            row[4] += sz
            row[5] += 1.0
            row[6] += taker_buy
        if not local:
            return 0, 0, 0.0, 0.0
        with self.lock:
            for t, row in local.items():
                prev = self.bars.get(t)
                if prev is None:
                    self.bars[t] = row
                    continue
                if row[7] < prev[7]:
                    prev[0] = row[0]
                    prev[7] = row[7]
                if row[8] > prev[8]:
                    prev[3] = row[3]
                    prev[8] = row[8]
                if row[1] > prev[1]:
                    prev[1] = row[1]
                if row[2] < prev[2]:
                    prev[2] = row[2]
                prev[4] += row[4]
                prev[5] += row[5]
                prev[6] += row[6]
        return int(min_id), int(max_id), float(min_ts), float(max_ts)

    def load_csv(self, path: Path) -> int:
        if not path.exists():
            return 0
        n = 0
        with gzip.open(path, "rt", encoding="utf-8") as f:
            header = f.readline()
            if "open_time" not in header:
                return 0
            for line in f:
                p = line.strip().split(",")
                if len(p) < 8:
                    continue
                t = int(int(float(p[0])) // 1000)
                o, h, low, c, v = (float(p[i]) for i in range(1, 6))
                ntr = float(p[6])
                tb = float(p[7])
                self.bars[t] = [o, h, low, c, v, ntr, tb, 0.0, 1.0]
                n += 1
        return n

    def dump_csv(self, path: Path) -> int:
        path.parent.mkdir(parents=True, exist_ok=True)
        with self.lock:
            items = sorted(self.bars.items())
        tmp = path.with_suffix(path.suffix + ".tmp")
        with gzip.open(tmp, "wt", encoding="utf-8") as f:
            f.write("open_time,open,high,low,close,volume,count,taker_buy_base\n")
            for t, row in items:
                o, h, low, c, v, n, tb, _a, _b = row
                f.write(f"{t * 1000},{o},{h},{low},{c},{v},{int(n)},{tb}\n")
        tmp.replace(path)
        return len(items)


def save_ckpt(obj: dict) -> None:
    CKPT_PATH.parent.mkdir(parents=True, exist_ok=True)
    CKPT_PATH.write_text(json.dumps(obj, indent=2))


def load_ckpt() -> dict | None:
    if not CKPT_PATH.exists():
        return None
    try:
        return json.loads(CKPT_PATH.read_text())
    except Exception:
        return None


def fetch_days(n_days: int) -> Path:
    DATA.mkdir(parents=True, exist_ok=True)
    newest = fetch_trades(limit=1)
    if not newest:
        raise RuntimeError("no Coinbase trades")
    latest_id = int(newest[0]["trade_id"])
    latest_ts = parse_iso(newest[0]["time"])
    cutoff = latest_ts - n_days * 86400
    log(
        f"Coinbase BTC-USD trades latest_id={latest_id} "
        f"t={newest[0]['time']} cutoff={datetime.fromtimestamp(cutoff, tz=timezone.utc).isoformat()}"
    )

    book = BarBook()
    ckpt = load_ckpt()
    start_after = latest_id + 1
    pages_done = 0
    if ckpt and ckpt.get("product") == PRODUCT and BARS_PATH.exists():
        loaded = book.load_csv(BARS_PATH)
        start_after = int(ckpt.get("oldest_id") or start_after)
        pages_done = int(ckpt.get("pages") or 0)
        log(f"resume {loaded:,} bars from {BARS_PATH} oldest_id={start_after}")

    stop = threading.Event()
    stats_lock = threading.Lock()
    stats = {
        "pages": pages_done,
        "trades": 0,
        "oldest_id": start_after,
        "newest_id": latest_id,
        "oldest_ts": latest_ts,
        "newest_ts": latest_ts,
        "err": 0,
    }
    after_lock = threading.Lock()
    next_after = start_after

    def take_after() -> int | None:
        nonlocal next_after
        if stop.is_set():
            return None
        with after_lock:
            a = next_after
            next_after -= LIMIT
            return a

    t0 = time.monotonic()

    def worker() -> None:
        while not stop.is_set():
            after = take_after()
            if after is None:
                return
            trades: list[dict] | None = None
            try:
                trades = fetch_trades(after=after)
            except Exception as exc:  # noqa: BLE001
                with stats_lock:
                    stats["err"] += 1
                    nerr = stats["err"]
                log(f"  warn after={after}: {exc}")
                if nerr > 60:
                    stop.set()
                    return
                time.sleep(1.0)
                try:
                    trades = fetch_trades(after=after)
                except Exception as exc2:  # noqa: BLE001
                    log(f"  skip after={after}: {exc2}")
                    continue
            if not trades:
                stop.set()
                return
            min_id, max_id, min_ts, max_ts = book.ingest(trades)
            with stats_lock:
                stats["pages"] += 1
                stats["trades"] += len(trades)
                if min_id:
                    stats["oldest_id"] = min(stats["oldest_id"], min_id)
                    stats["newest_id"] = max(stats["newest_id"], max_id)
                    stats["oldest_ts"] = min(stats["oldest_ts"], min_ts)
                    stats["newest_ts"] = max(stats["newest_ts"], max_ts)
                pages = stats["pages"]
                ntr = stats["trades"]
                ots = stats["oldest_ts"]
            if min_ts and min_ts < cutoff:
                stop.set()
            if pages % 50 == 0:
                elapsed = max(time.monotonic() - t0, 1e-6)
                span_h = (latest_ts - ots) / 3600.0
                log(
                    f"  pages={pages:,} trades={ntr:,} bars={len(book.bars):,} "
                    f"span={span_h:.1f}h rps={pages / elapsed:.1f} "
                    f"oldest={datetime.fromtimestamp(ots, tz=timezone.utc).isoformat()}"
                )
                save_ckpt(
                    {
                        "product": PRODUCT,
                        "pages": pages,
                        "trades": ntr,
                        "oldest_id": stats["oldest_id"],
                        "newest_id": stats["newest_id"],
                        "oldest_ts": ots,
                        "cutoff": cutoff,
                    }
                )
            if pages % 200 == 0:
                n_bars = book.dump_csv(BARS_PATH)
                log(f"  checkpoint bars={n_bars:,} → {BARS_PATH}")

    threads = [threading.Thread(target=worker, daemon=True) for _ in range(MAX_WORKERS)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()

    n_bars = book.dump_csv(BARS_PATH)
    save_ckpt(
        {
            "product": PRODUCT,
            "pages": stats["pages"],
            "trades": stats["trades"],
            "oldest_id": stats["oldest_id"],
            "newest_id": stats["newest_id"],
            "oldest_ts": stats["oldest_ts"],
            "newest_ts": stats["newest_ts"],
            "cutoff": cutoff,
            "n_bars": n_bars,
            "path": str(BARS_PATH),
        }
    )
    span_h = (stats["newest_ts"] - stats["oldest_ts"]) / 3600.0
    log(
        f"Wrote {BARS_PATH} bars={n_bars:,} trades={stats['trades']:,} "
        f"pages={stats['pages']:,} span={span_h:.1f}h ({span_h / 24:.2f} d)"
    )
    return BARS_PATH


def main() -> int:
    n_days = int(sys.argv[1]) if len(sys.argv) > 1 else 14
    fetch_days(n_days)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
