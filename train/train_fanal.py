#!/usr/bin/env python3
"""Train a leak-free LightGBM 5s BTCUSDT classifier on Binance Vision 1s klines."""

from __future__ import annotations

import json
import math
import sys
import urllib.request
import zipfile
from datetime import date, timedelta
from io import BytesIO
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "klines"
MODELS = ROOT / "models"
FN_MODELS = ROOT / "netlify" / "functions" / "_models"

VISION = "https://data.binance.vision/data/spot/daily/klines/BTCUSDT/1s/BTCUSDT-1s-{d}.zip"

COLS = [
    "open_time",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "close_time",
    "quote_volume",
    "count",
    "taker_buy_base",
    "taker_buy_quote",
    "ignore",
]

FEATURES = [
    "ret_1",
    "ret_3",
    "ret_5",
    "ret_15",
    "ret_30",
    "rv_15",
    "rv_30",
    "rv_60",
    "tbr",
    "tbr_5",
    "tbr_15",
    "body_ratio",
    "upper_wick",
    "lower_wick",
    "log_hl",
    "close_loc",
    "vol_z_30",
    "vol_z_60",
    "log_vol",
    "imb_5",
    "imb_15",
    "imb_30",
    "cvd_5",
    "cvd_15",
    "trade_z_30",
]

HORIZON = 5
WARMUP = 60


def daterange(end: date, days: int) -> list[str]:
    return [(end - timedelta(days=i)).isoformat() for i in range(days)][::-1]


def download_days(days: list[str]) -> list[Path]:
    DATA.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []
    for d in days:
        dest = DATA / f"BTCUSDT-1s-{d}.csv"
        if dest.exists() and dest.stat().st_size > 1_000_000:
            print(f"  cache {d}", flush=True)
            paths.append(dest)
            continue
        url = VISION.format(d=d)
        print(f"  fetch {d} …", flush=True)
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                blob = r.read()
        except Exception as exc:
            print(f"  skip {d}: {exc}", flush=True)
            continue
        if len(blob) < 1000 or blob[:2] != b"PK":
            print(f"  skip {d}: not a zip ({len(blob)} bytes)", flush=True)
            continue
        with zipfile.ZipFile(BytesIO(blob)) as zf:
            name = zf.namelist()[0]
            dest.write_bytes(zf.read(name))
        print(f"  wrote {dest.name} ({dest.stat().st_size:,} bytes)", flush=True)
        paths.append(dest)
    return paths


def load_klines(paths: list[Path]) -> pd.DataFrame:
    frames = []
    for p in paths:
        df = pd.read_csv(p, header=None, names=COLS)
        frames.append(df)
    df = pd.concat(frames, ignore_index=True)
    df = df.sort_values("open_time").drop_duplicates("open_time", keep="last")
    for c in [
        "open",
        "high",
        "low",
        "close",
        "volume",
        "taker_buy_base",
        "count",
    ]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df = df.dropna(subset=["close", "volume"]).reset_index(drop=True)
    return df


def rolling_std(x: np.ndarray, window: int) -> np.ndarray:
    s = pd.Series(x)
    return s.rolling(window, min_periods=window).std(ddof=0).to_numpy()


def rolling_mean(x: np.ndarray, window: int) -> np.ndarray:
    s = pd.Series(x)
    return s.rolling(window, min_periods=window).mean().to_numpy()


def rolling_sum(x: np.ndarray, window: int) -> np.ndarray:
    s = pd.Series(x)
    return s.rolling(window, min_periods=window).sum().to_numpy()


def make_features(df: pd.DataFrame) -> tuple[pd.DataFrame, np.ndarray]:
    o = df["open"].to_numpy(dtype=np.float64)
    h = df["high"].to_numpy(dtype=np.float64)
    low = df["low"].to_numpy(dtype=np.float64)
    c = df["close"].to_numpy(dtype=np.float64)
    v = df["volume"].to_numpy(dtype=np.float64)
    tb = df["taker_buy_base"].to_numpy(dtype=np.float64)
    ntr = df["count"].to_numpy(dtype=np.float64)

    logc = np.log(np.clip(c, 1e-12, None))
    ret_1 = np.empty_like(logc)
    ret_1[0] = np.nan
    ret_1[1:] = logc[1:] - logc[:-1]

    feat = pd.DataFrame(index=df.index)
    for k in (1, 3, 5, 15, 30):
        col = np.full_like(logc, np.nan)
        col[k:] = logc[k:] - logc[:-k]
        feat[f"ret_{k}"] = col

    feat["rv_15"] = rolling_std(ret_1, 15)
    feat["rv_30"] = rolling_std(ret_1, 30)
    feat["rv_60"] = rolling_std(ret_1, 60)

    tbr = np.divide(tb, v, out=np.full_like(v, 0.5), where=v > 0)
    feat["tbr"] = tbr
    feat["tbr_5"] = rolling_mean(tbr, 5)
    feat["tbr_15"] = rolling_mean(tbr, 15)

    rng = np.maximum(h - low, 1e-12)
    body = np.abs(c - o)
    upper = h - np.maximum(o, c)
    lower = np.minimum(o, c) - low
    feat["body_ratio"] = body / rng
    feat["upper_wick"] = upper / rng
    feat["lower_wick"] = lower / rng
    feat["log_hl"] = np.log(np.maximum(h, 1e-12) / np.maximum(low, 1e-12))
    feat["close_loc"] = (c - low) / rng

    vmean30 = rolling_mean(v, 30)
    vstd30 = np.maximum(rolling_std(v, 30), 1e-12)
    vmean60 = rolling_mean(v, 60)
    vstd60 = np.maximum(rolling_std(v, 60), 1e-12)
    feat["vol_z_30"] = (v - vmean30) / vstd30
    feat["vol_z_60"] = (v - vmean60) / vstd60
    feat["log_vol"] = np.log(v + 1e-12)

    signed = 2.0 * tb - v
    vol5 = np.maximum(rolling_sum(v, 5), 1e-12)
    vol15 = np.maximum(rolling_sum(v, 15), 1e-12)
    vol30 = np.maximum(rolling_sum(v, 30), 1e-12)
    feat["imb_5"] = rolling_sum(signed, 5) / vol5
    feat["imb_15"] = rolling_sum(signed, 15) / vol15
    feat["imb_30"] = rolling_sum(signed, 30) / vol30
    feat["cvd_5"] = rolling_sum(signed, 5)
    feat["cvd_15"] = rolling_sum(signed, 15)

    nmean = rolling_mean(ntr, 30)
    nstd = np.maximum(rolling_std(ntr, 30), 1e-12)
    feat["trade_z_30"] = (ntr - nmean) / nstd

    future = np.empty_like(c)
    future[:-HORIZON] = c[HORIZON:]
    future[-HORIZON:] = np.nan
    # Strict up vs down; drop 5s ties so the model is not rewarded for "flat".
    y = np.full_like(c, np.nan)
    moved = (~np.isnan(future)) & (future != c)
    y[moved] = (future[moved] > c[moved]).astype(np.float64)

    return feat[FEATURES], y


def flatten_tree(node: dict) -> list[dict]:
    nodes: list[dict | None] = []

    def rec(n: dict) -> int:
        idx = len(nodes)
        nodes.append(None)
        if "leaf_value" in n:
            nodes[idx] = {"v": float(n["leaf_value"])}
            return idx
        left = rec(n["left_child"])
        right = rec(n["right_child"])
        default_left = bool(n.get("default_left", True))
        nodes[idx] = {
            "f": int(n["split_feature"]),
            "t": float(n["threshold"]),
            "left": left,
            "right": right,
            "missing": left if default_left else right,
        }
        return idx

    rec(node)
    return [n for n in nodes if n is not None]


def score_dump(model: dict, x: np.ndarray) -> float:
    s = 0.0
    for tree in model["trees"]:
        nodes = tree["nodes"]
        i = 0
        while "v" not in nodes[i]:
            n = nodes[i]
            val = x[n["f"]]
            if val is None or (isinstance(val, float) and math.isnan(val)):
                i = n["missing"]
            else:
                i = n["left"] if val <= n["t"] else n["right"]
        s += nodes[i]["v"]
    return s


def sigmoid(z: float) -> float:
    if z >= 0:
        ez = math.exp(-z)
        return 1.0 / (1.0 + ez)
    ez = math.exp(z)
    return ez / (1.0 + ez)


def gated_stats(y: np.ndarray, p: np.ndarray, tau: float) -> dict:
    gated = (p >= tau) | (p <= (1.0 - tau))
    n = int(gated.sum())
    if n == 0:
        return {"gated_acc": None, "n": 0, "coverage": 0.0}
    pred = (p >= 0.5).astype(np.int32)
    acc = float((pred[gated] == y[gated]).mean())
    return {
        "gated_acc": acc,
        "n": n,
        "coverage": float(n / len(y)),
    }


def pick_tau(y: np.ndarray, p: np.ndarray) -> tuple[float, dict]:
    """Prefer τ ≈ 0.58 when VAL gated acc is already in/above the 0.56–0.60 band."""
    preferred = [0.58, 0.56, 0.60, 0.57, 0.59, 0.55, 0.61]
    for tau in preferred:
        st = gated_stats(y, p, float(tau))
        st["tau"] = float(tau)
        if st["n"] >= 200 and st["coverage"] >= 0.08 and st["gated_acc"] is not None:
            if st["gated_acc"] >= 0.56:
                return float(tau), st
    best = None
    for tau in np.round(np.linspace(0.52, 0.70, 37), 4):
        st = gated_stats(y, p, float(tau))
        st["tau"] = float(tau)
        if st["n"] < 200 or st["coverage"] < 0.04:
            continue
        acc = st["gated_acc"]
        score = -abs(acc - 0.58) * 4.0 + min(st["coverage"], 0.20)
        cand = (score, st["coverage"], float(tau), st)
        if best is None or cand > best:
            best = cand
    if best is None:
        return 0.58, gated_stats(y, p, 0.58)
    return best[2], best[3]


def main() -> int:
    n_days = int(sys.argv[1]) if len(sys.argv) > 1 else 21
    end = date(2026, 8, 23)
    days = daterange(end, n_days)
    print(f"Downloading {len(days)} daily 1s zips ({days[0]} → {days[-1]})", flush=True)
    paths = download_days(days)
    if len(paths) < 10:
        print(f"Not enough days downloaded: {len(paths)}", file=sys.stderr)
        return 1

    print("Loading klines…", flush=True)
    df = load_klines(paths)
    print(f"  rows={len(df):,}", flush=True)

    print("Features…", flush=True)
    X_df, y_all = make_features(df)
    valid = X_df.notna().all(axis=1) & pd.notna(y_all)
    # drop warmup explicitly
    valid.iloc[:WARMUP] = False
    X = X_df.loc[valid, FEATURES].to_numpy(dtype=np.float64)
    y = y_all[valid.to_numpy()].astype(np.int32)
    close = df.loc[valid, "close"].to_numpy(dtype=np.float64)
    print(f"  usable={len(y):,}  up_rate={y.mean():.4f}", flush=True)

    n = len(y)
    i_train = int(n * 0.70)
    i_val = int(n * 0.85)
    X_tr, y_tr = X[:i_train], y[:i_train]
    X_va, y_va = X[i_train:i_val], y[i_train:i_val]
    X_te, y_te = X[i_val:], y[i_val:]
    close_te = close[i_val:]

    dtrain = lgb.Dataset(X_tr, y_tr, feature_name=FEATURES, free_raw_data=False)
    dval = lgb.Dataset(X_va, y_va, feature_name=FEATURES, reference=dtrain, free_raw_data=False)

    params = {
        "objective": "binary",
        "metric": ["auc", "binary_logloss"],
        "learning_rate": 0.05,
        "num_leaves": 24,
        "max_depth": 5,
        "min_child_samples": 400,
        "subsample": 0.8,
        "subsample_freq": 1,
        "colsample_bytree": 0.8,
        "reg_lambda": 2.0,
        "reg_alpha": 0.1,
        "min_gain_to_split": 0.01,
        "verbose": -1,
        "seed": 42,
        "bagging_seed": 42,
        "feature_fraction_seed": 42,
    }

    print("Training LightGBM…", flush=True)
    booster = lgb.train(
        params,
        dtrain,
        num_boost_round=220,
        valid_sets=[dtrain, dval],
        valid_names=["train", "val"],
        callbacks=[
            lgb.early_stopping(40, verbose=True),
            lgb.log_evaluation(20),
        ],
    )

    p_va = booster.predict(X_va, num_iteration=booster.best_iteration)
    p_te = booster.predict(X_te, num_iteration=booster.best_iteration)

    tau, val_st = pick_tau(y_va, p_va)
    test_st = gated_stats(y_te, p_te, tau)

    # naive: last 1s return continues over the next 5s
    ret1 = X_te[:, FEATURES.index("ret_1")]
    naive_pred = (ret1 > 0).astype(np.int32)
    naive_last_acc = float((naive_pred == y_te).mean())

    print(
        f"VAL  tau={tau:.3f} gated_acc={val_st['gated_acc']:.4f} "
        f"n={val_st['n']} cov={val_st['coverage']:.3f}",
        flush=True,
    )
    print(
        f"TEST tau={tau:.3f} gated_acc={test_st['gated_acc']:.4f} "
        f"n={test_st['n']} cov={test_st['coverage']:.3f} "
        f"naive={naive_last_acc:.4f}",
        flush=True,
    )

    dumped = booster.dump_model(num_iteration=booster.best_iteration)
    compact = {
        "objective": "binary",
        "features": FEATURES,
        "best_iteration": int(booster.best_iteration),
        "trees": [{"nodes": flatten_tree(t["tree_structure"])} for t in dumped["tree_info"]],
    }

    # verify dump vs LightGBM
    sample_idx = [0, len(X_te) // 2, len(X_te) - 1]
    sanity = []
    for i in sample_idx:
        raw = score_dump(compact, X_te[i])
        p_js = sigmoid(raw)
        p_py = float(p_te[i])
        if abs(p_js - p_py) > 1e-5:
            raise SystemExit(f"scorer mismatch i={i} js={p_js} py={p_py}")
        sanity.append({"x": [float(v) for v in X_te[i]], "p": p_py, "raw": raw})
    print("Dump scorer matches LightGBM predict().", flush=True)

    MODELS.mkdir(parents=True, exist_ok=True)
    FN_MODELS.mkdir(parents=True, exist_ok=True)
    txt_path = MODELS / "fanal_sec_lgbm.txt"
    booster.save_model(str(txt_path), num_iteration=booster.best_iteration)

    meta = {
        "kind": "lgbm",
        "horizon_s": HORIZON,
        "bar_s": 1,
        "symbol": "BTCUSDT",
        "tau": tau,
        "features": FEATURES,
        "n_days": len(paths),
        "days": [p.stem.replace("BTCUSDT-1s-", "") for p in paths],
        "n_train": int(len(y_tr)),
        "n_val": int(len(y_va)),
        "n_test": int(len(y_te)),
        "best_iteration": int(booster.best_iteration),
        "val": val_st,
        "test": {
            "gated_acc": test_st["gated_acc"],
            "n": test_st["n"],
            "coverage": test_st["coverage"],
            "naive_last_acc": naive_last_acc,
        },
        "up_rate_test": float(y_te.mean()),
        "sanity": sanity,
        "close_te_tail": float(close_te[-1]),
    }

    json_path = MODELS / "fanal_sec_lgbm.json"
    meta_path = MODELS / "fanal_sec_meta.json"
    json_path.write_text(json.dumps(compact))
    meta_path.write_text(json.dumps(meta, indent=2))
    (FN_MODELS / "fanal_sec_lgbm.json").write_text(json.dumps(compact))
    (FN_MODELS / "fanal_sec_meta.json").write_text(json.dumps(meta, indent=2))

    print(f"Wrote {txt_path}")
    print(f"Wrote {json_path} ({json_path.stat().st_size:,} bytes)")
    print(f"Wrote {meta_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
