#!/usr/bin/env python3
"""Train leak-free LightGBM 5s (+ optional 15s) BTC classifiers on Binance Vision 1s klines.

Archive data only. Live Fanal scores Coinbase BTC-USD reconstructed 1s bars with the same
relative microstructure features (returns / flow / wicks) — no Binance live feed.
"""

from __future__ import annotations

import json
import math
import shutil
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, timedelta
from io import BytesIO
from pathlib import Path
from zipfile import ZipFile

import lightgbm as lgb
import numpy as np
import pandas as pd
import urllib.request

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
    "ret_60",
    "rv_5",
    "rv_15",
    "rv_30",
    "rv_60",
    "tbr",
    "tbr_5",
    "tbr_15",
    "tbr_30",
    "body_ratio",
    "upper_wick",
    "lower_wick",
    "log_hl",
    "close_loc",
    "vol_z_30",
    "vol_z_60",
    "log_vol",
    "vol_shock_5",
    "imb_5",
    "imb_15",
    "imb_30",
    "cvd_5",
    "cvd_15",
    "cvd_30",
    "trade_z_30",
]

BASELINE_GATED = 0.6730947939156379
BASELINE_COVERAGE = 0.7833833253054254
HORIZON_5 = 5
HORIZON_15 = 15
WARMUP = 60
COST_BPS = 1.0
MIN_COVERAGE = 0.05


def daterange(end: date, days: int) -> list[str]:
    return [(end - timedelta(days=i)).isoformat() for i in range(days)][::-1]


def _fetch_day(d: str) -> Path | None:
    dest = DATA / f"BTCUSDT-1s-{d}.csv"
    if dest.exists() and dest.stat().st_size > 1_000_000:
        print(f"  cache {d}", flush=True)
        return dest
    url = VISION.format(d=d)
    print(f"  fetch {d} …", flush=True)
    req = urllib.request.Request(url, headers={"User-Agent": "FanalTrain/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            blob = r.read()
    except Exception as exc:
        print(f"  skip {d}: {exc}", flush=True)
        return None
    if len(blob) < 1000 or blob[:2] != b"PK":
        print(f"  skip {d}: not a zip ({len(blob)} bytes)", flush=True)
        return None
    with ZipFile(BytesIO(blob)) as zf:
        name = zf.namelist()[0]
        dest.write_bytes(zf.read(name))
    print(f"  wrote {dest.name} ({dest.stat().st_size:,} bytes)", flush=True)
    return dest


def download_days(days: list[str]) -> list[Path]:
    DATA.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []
    with ThreadPoolExecutor(max_workers=6) as pool:
        futs = {pool.submit(_fetch_day, d): d for d in days}
        by_day: dict[str, Path] = {}
        for fut in as_completed(futs):
            p = fut.result()
            if p is not None:
                by_day[futs[fut]] = p
    for d in days:
        if d in by_day:
            paths.append(by_day[d])
    return paths


def load_klines(paths: list[Path]) -> pd.DataFrame:
    frames = []
    for p in paths:
        df = pd.read_csv(p, header=None, names=COLS)
        frames.append(df)
    df = pd.concat(frames, ignore_index=True)
    df = df.sort_values("open_time").drop_duplicates("open_time", keep="last")
    for c in ["open", "high", "low", "close", "volume", "taker_buy_base", "count"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df = df.dropna(subset=["close", "volume"]).reset_index(drop=True)
    return df


def rolling_std(x: np.ndarray, window: int) -> np.ndarray:
    return pd.Series(x).rolling(window, min_periods=window).std(ddof=0).to_numpy()


def rolling_mean(x: np.ndarray, window: int) -> np.ndarray:
    return pd.Series(x).rolling(window, min_periods=window).mean().to_numpy()


def rolling_sum(x: np.ndarray, window: int) -> np.ndarray:
    return pd.Series(x).rolling(window, min_periods=window).sum().to_numpy()


def make_features(df: pd.DataFrame) -> pd.DataFrame:
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
    for k in (1, 3, 5, 15, 30, 60):
        col = np.full_like(logc, np.nan)
        col[k:] = logc[k:] - logc[:-k]
        feat[f"ret_{k}"] = col

    feat["rv_5"] = rolling_std(ret_1, 5)
    feat["rv_15"] = rolling_std(ret_1, 15)
    feat["rv_30"] = rolling_std(ret_1, 30)
    feat["rv_60"] = rolling_std(ret_1, 60)

    tbr = np.divide(tb, v, out=np.full_like(v, 0.5), where=v > 0)
    feat["tbr"] = tbr
    feat["tbr_5"] = rolling_mean(tbr, 5)
    feat["tbr_15"] = rolling_mean(tbr, 15)
    feat["tbr_30"] = rolling_mean(tbr, 30)

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
    vmean5 = rolling_mean(v, 5)
    feat["vol_shock_5"] = v / np.maximum(vmean5, 1e-12)

    signed = 2.0 * tb - v
    vol5 = np.maximum(rolling_sum(v, 5), 1e-12)
    vol15 = np.maximum(rolling_sum(v, 15), 1e-12)
    vol30 = np.maximum(rolling_sum(v, 30), 1e-12)
    feat["imb_5"] = rolling_sum(signed, 5) / vol5
    feat["imb_15"] = rolling_sum(signed, 15) / vol15
    feat["imb_30"] = rolling_sum(signed, 30) / vol30
    feat["cvd_5"] = rolling_sum(signed, 5)
    feat["cvd_15"] = rolling_sum(signed, 15)
    feat["cvd_30"] = rolling_sum(signed, 30)

    nmean = rolling_mean(ntr, 30)
    nstd = np.maximum(rolling_std(ntr, 30), 1e-12)
    feat["trade_z_30"] = (ntr - nmean) / nstd
    return feat[FEATURES]


def make_label(close: np.ndarray, horizon: int) -> np.ndarray:
    future = np.empty_like(close)
    future[:] = np.nan
    future[:-horizon] = close[horizon:]
    y = np.full_like(close, np.nan)
    moved = (~np.isnan(future)) & (future != close)
    y[moved] = (future[moved] > close[moved]).astype(np.float64)
    return y


def fwd_bps(close: np.ndarray, horizon: int) -> np.ndarray:
    out = np.full_like(close, np.nan)
    out[:-horizon] = (close[horizon:] / close[:-horizon] - 1.0) * 1e4
    return out


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
    return {"gated_acc": acc, "n": n, "coverage": float(n / len(y))}


def trade_stats(y: np.ndarray, p: np.ndarray, bps: np.ndarray, tau: float) -> dict:
    gated = (p >= tau) | (p <= (1.0 - tau))
    n = int(gated.sum())
    if n == 0:
        return {
            "mean_abs_move_bps": None,
            "mean_signed_bps": None,
            "expectancy_1bp": None,
        }
    pred_sign = np.where(p >= 0.5, 1.0, -1.0)
    signed = pred_sign[gated] * bps[gated]
    abs_move = np.abs(bps[gated])
    mean_signed = float(np.nanmean(signed))
    return {
        "mean_abs_move_bps": float(np.nanmean(abs_move)),
        "mean_signed_bps": mean_signed,
        "expectancy_1bp": mean_signed - COST_BPS,
    }


def pick_tau(y: np.ndarray, p: np.ndarray) -> tuple[float, dict]:
    preferred = [0.58, 0.56, 0.60, 0.57, 0.59, 0.55, 0.61]
    for tau in preferred:
        st = gated_stats(y, p, float(tau))
        st["tau"] = float(tau)
        if (
            st["n"] >= 200
            and st["coverage"] >= MIN_COVERAGE
            and st["gated_acc"] is not None
            and st["gated_acc"] >= 0.56
        ):
            return float(tau), st
    best = None
    for tau in np.round(np.linspace(0.52, 0.70, 37), 4):
        st = gated_stats(y, p, float(tau))
        st["tau"] = float(tau)
        if st["n"] < 200 or st["coverage"] < MIN_COVERAGE:
            continue
        acc = st["gated_acc"]
        score = acc + 0.015 * min(st["coverage"], 0.25)
        cand = (score, st["coverage"], -float(tau), st)
        if best is None or cand > best:
            best = cand
    if best is None:
        st = gated_stats(y, p, 0.58)
        st["tau"] = 0.58
        return 0.58, st
    return best[3]["tau"], best[3]


def fit_move_calib(p: np.ndarray, bps: np.ndarray, tau: float) -> dict:
    """Map p_up → expected signed 5s/15s move in bps (linear, leak-free on VAL)."""
    ok = np.isfinite(p) & np.isfinite(bps)
    x = p[ok] - 0.5
    y = bps[ok]
    if len(x) < 100 or float(np.var(x)) < 1e-12:
        return {
            "beta_bps": 0.0,
            "intercept_bps": 0.0,
            "gated_up_mean_bps": 0.0,
            "gated_down_mean_bps": 0.0,
            "mean_abs_bps": float(np.nanmean(np.abs(y))) if len(y) else 0.0,
        }
    varx = float(np.var(x))
    beta = float(np.cov(x, y, ddof=0)[0, 1] / varx)
    intercept = float(np.mean(y) - beta * np.mean(x))
    up = (p >= tau) & ok
    down = (p <= 1.0 - tau) & ok
    return {
        "beta_bps": beta,
        "intercept_bps": intercept,
        "gated_up_mean_bps": float(np.nanmean(bps[up])) if up.any() else 0.0,
        "gated_down_mean_bps": float(np.nanmean(bps[down])) if down.any() else 0.0,
        "mean_abs_bps": float(np.nanmean(np.abs(y))),
    }


def compact_dump(booster: lgb.Booster) -> dict:
    dumped = booster.dump_model(num_iteration=booster.best_iteration)
    return {
        "objective": "binary",
        "features": FEATURES,
        "best_iteration": int(booster.best_iteration),
        "trees": [{"nodes": flatten_tree(t["tree_structure"])} for t in dumped["tree_info"]],
    }


def verify_dump(compact: dict, X: np.ndarray, p: np.ndarray) -> list[dict]:
    sample_idx = [0, len(X) // 2, len(X) - 1]
    sanity = []
    for i in sample_idx:
        raw = score_dump(compact, X[i])
        p_js = sigmoid(raw)
        p_py = float(p[i])
        if abs(p_js - p_py) > 1e-5:
            raise SystemExit(f"scorer mismatch i={i} js={p_js} py={p_py}")
        sanity.append({"x": [float(v) for v in X[i]], "p": p_py, "raw": raw})
    return sanity


def train_head(
    X_tr: np.ndarray,
    y_tr: np.ndarray,
    X_va: np.ndarray,
    y_va: np.ndarray,
    X_te: np.ndarray,
    y_te: np.ndarray,
    bps_va: np.ndarray,
    bps_te: np.ndarray,
    close_te: np.ndarray,
    horizon: int,
) -> dict:
    dtrain = lgb.Dataset(X_tr, y_tr, feature_name=FEATURES, free_raw_data=False)
    dval = lgb.Dataset(X_va, y_va, feature_name=FEATURES, reference=dtrain, free_raw_data=False)
    params = {
        "objective": "binary",
        "metric": ["auc", "binary_logloss"],
        "learning_rate": 0.04,
        "num_leaves": 31,
        "max_depth": 6,
        "min_child_samples": 600,
        "subsample": 0.8,
        "subsample_freq": 1,
        "colsample_bytree": 0.8,
        "reg_lambda": 2.4,
        "reg_alpha": 0.15,
        "min_gain_to_split": 0.01,
        "verbose": -1,
        "seed": 42,
        "bagging_seed": 42,
        "feature_fraction_seed": 42,
    }
    print(f"Training LightGBM horizon={horizon}s …", flush=True)
    booster = lgb.train(
        params,
        dtrain,
        num_boost_round=400,
        valid_sets=[dtrain, dval],
        valid_names=["train", "val"],
        callbacks=[lgb.early_stopping(50, verbose=True), lgb.log_evaluation(40)],
    )
    p_va = booster.predict(X_va, num_iteration=booster.best_iteration)
    p_te = booster.predict(X_te, num_iteration=booster.best_iteration)
    tau, val_st = pick_tau(y_va, p_va)
    test_st = gated_stats(y_te, p_te, tau)
    test_st.update(trade_stats(y_te, p_te, bps_te, tau))
    val_st.update(trade_stats(y_va, p_va, bps_va, tau))

    ret1 = X_te[:, FEATURES.index("ret_1")]
    naive_pred = (ret1 > 0).astype(np.int32)
    naive_last_acc = float((naive_pred == y_te).mean())
    test_st["naive_last_acc"] = naive_last_acc

    print(
        f"VAL  h={horizon} tau={tau:.3f} gated_acc={val_st['gated_acc']:.4f} "
        f"n={val_st['n']} cov={val_st['coverage']:.3f} "
        f"|move|={val_st['mean_abs_move_bps']:.3f}bps E1={val_st['expectancy_1bp']:.3f}",
        flush=True,
    )
    print(
        f"TEST h={horizon} tau={tau:.3f} gated_acc={test_st['gated_acc']:.4f} "
        f"n={test_st['n']} cov={test_st['coverage']:.3f} "
        f"naive={naive_last_acc:.4f} |move|={test_st['mean_abs_move_bps']:.3f}bps "
        f"E1={test_st['expectancy_1bp']:.3f}",
        flush=True,
    )

    compact = compact_dump(booster)
    sanity = verify_dump(compact, X_te, p_te)
    gain = booster.feature_importance(importance_type="gain")
    importance = [
        {"name": FEATURES[i], "gain": float(gain[i])}
        for i in np.argsort(-gain)
    ]
    calib = fit_move_calib(p_va, bps_va, tau)
    print(f"Dump scorer matches LightGBM predict() (h={horizon}).", flush=True)
    print(
        f"calib h={horizon} beta={calib['beta_bps']:.4f} "
        f"up={calib['gated_up_mean_bps']:.4f} down={calib['gated_down_mean_bps']:.4f}",
        flush=True,
    )
    return {
        "booster": booster,
        "compact": compact,
        "tau": float(tau),
        "val": val_st,
        "test": test_st,
        "sanity": sanity,
        "importance": importance,
        "calib": calib,
        "best_iteration": int(booster.best_iteration),
        "up_rate_test": float(y_te.mean()),
        "close_te_tail": float(close_te[-1]),
        "horizon_s": horizon,
        "p_te": p_te,
        "y_te": y_te,
    }


def should_swap_live(test_st: dict) -> tuple[bool, str]:
    acc = test_st.get("gated_acc")
    cov = test_st.get("coverage") or 0.0
    e1 = test_st.get("expectancy_1bp")
    if acc is None:
        return False, "pas de gated_acc TEST"
    if acc + 1e-12 >= BASELINE_GATED and cov >= MIN_COVERAGE:
        return True, f"TEST gated {acc:.4f} ≥ baseline {BASELINE_GATED:.4f}"
    better_e = e1 is not None and e1 > -0.85
    similar_cov = abs(cov - BASELINE_COVERAGE) <= 0.15
    if acc >= BASELINE_GATED - 0.01 and better_e and similar_cov:
        return True, (
            f"TEST gated {acc:.4f} proche du baseline, E après 1bp={e1:.3f} "
            f"avec couverture similaire ({cov:.3f})"
        )
    return False, (
        f"on garde les poids live actuels "
        f"(TEST gated {acc:.4f} vs baseline {BASELINE_GATED:.4f}, E1={e1})"
    )


def write_json(path: Path, obj: dict) -> None:
    path.write_text(json.dumps(obj))


def main() -> int:
    n_days = int(sys.argv[1]) if len(sys.argv) > 1 else 45
    end = date(2026, 8, 23)
    days = daterange(end, n_days)
    print(f"Downloading {len(days)} daily 1s zips ({days[0]} → {days[-1]})", flush=True)
    paths = download_days(days)
    if len(paths) < 20:
        print(f"Not enough days downloaded: {len(paths)}", file=sys.stderr)
        return 1

    print("Loading klines…", flush=True)
    df = load_klines(paths)
    print(f"  rows={len(df):,}", flush=True)

    print("Features…", flush=True)
    X_df = make_features(df)
    close_all = df["close"].to_numpy(dtype=np.float64)
    y5_all = make_label(close_all, HORIZON_5)
    y15_all = make_label(close_all, HORIZON_15)
    bps5_all = fwd_bps(close_all, HORIZON_5)
    bps15_all = fwd_bps(close_all, HORIZON_15)

    valid5 = X_df.notna().all(axis=1) & pd.notna(y5_all) & pd.notna(bps5_all)
    valid5.iloc[:WARMUP] = False
    X = X_df.loc[valid5, FEATURES].to_numpy(dtype=np.float64)
    y5 = y5_all[valid5.to_numpy()].astype(np.int32)
    bps5 = bps5_all[valid5.to_numpy()]
    close = close_all[valid5.to_numpy()]
    print(f"  usable 5s={len(y5):,}  up_rate={y5.mean():.4f}", flush=True)

    n = len(y5)
    i_train = int(n * 0.70)
    i_val = int(n * 0.85)
    X_tr, y5_tr = X[:i_train], y5[:i_train]
    X_va, y5_va = X[i_train:i_val], y5[i_train:i_val]
    X_te, y5_te = X[i_val:], y5[i_val:]
    bps5_va, bps5_te = bps5[i_train:i_val], bps5[i_val:]
    close_te = close[i_val:]

    head5 = train_head(
        X_tr, y5_tr, X_va, y5_va, X_te, y5_te, bps5_va, bps5_te, close_te, HORIZON_5
    )

    # 15s head: same leak-free rows that also have a 15s forward label.
    y15_ok = pd.Series(np.isfinite(y15_all) & np.isfinite(bps15_all), index=df.index)
    both = valid5 & y15_ok
    X15 = X_df.loc[both, FEATURES].to_numpy(dtype=np.float64)
    y15 = y15_all[both.to_numpy()].astype(np.int32)
    bps15 = bps15_all[both.to_numpy()]
    close15 = close_all[both.to_numpy()]
    n15 = len(y15)
    i_tr15 = int(n15 * 0.70)
    i_va15 = int(n15 * 0.85)
    head15 = train_head(
        X15[:i_tr15],
        y15[:i_tr15],
        X15[i_tr15:i_va15],
        y15[i_tr15:i_va15],
        X15[i_va15:],
        y15[i_va15:],
        bps15[i_tr15:i_va15],
        bps15[i_va15:],
        close15[i_va15:],
        HORIZON_15,
    )

    swap, reason = should_swap_live(head5["test"])
    print(f"LIVE WEIGHTS: {'SWAP' if swap else 'KEEP'} — {reason}", flush=True)

    MODELS.mkdir(parents=True, exist_ok=True)
    FN_MODELS.mkdir(parents=True, exist_ok=True)

    def pack_meta(head: dict, n_tr: int, n_va: int, n_te: int, extra: dict | None = None) -> dict:
        meta = {
            "kind": "lgbm",
            "horizon_s": head["horizon_s"],
            "bar_s": 1,
            "symbol": "BTC-USD",
            "train_archive": "binance_vision_btcusdt_1s",
            "live_venue": "coinbase",
            "live_product": "BTC-USD",
            "tau": head["tau"],
            "features": FEATURES,
            "n_days": len(paths),
            "days": [p.stem.replace("BTCUSDT-1s-", "") for p in paths],
            "n_train": int(n_tr),
            "n_val": int(n_va),
            "n_test": int(n_te),
            "best_iteration": head["best_iteration"],
            "val": head["val"],
            "test": head["test"],
            "up_rate_test": head["up_rate_test"],
            "sanity": head["sanity"],
            "close_te_tail": head["close_te_tail"],
            "importance": head["importance"],
            "calib": head["calib"],
            "cost_bps": COST_BPS,
            "swapped_live": swap if head["horizon_s"] == HORIZON_5 else None,
            "swap_reason": reason if head["horizon_s"] == HORIZON_5 else None,
        }
        if extra:
            meta.update(extra)
        return meta

    # Always write 15s (faint path). 5s live weights only if swap.
    txt15 = MODELS / "fanal_sec_lgbm_15.txt"
    head15["booster"].save_model(str(txt15), num_iteration=head15["best_iteration"])
    meta15 = pack_meta(head15, i_tr15, i_va15 - i_tr15, n15 - i_va15)
    enabled15 = (
        head15["test"]["gated_acc"] is not None
        and head15["test"]["gated_acc"] >= 0.54
        and head15["test"]["coverage"] >= MIN_COVERAGE
    )
    meta15["enabled"] = bool(enabled15)
    write_json(MODELS / "fanal_sec_lgbm_15.json", head15["compact"])
    (MODELS / "fanal_sec_meta_15.json").write_text(json.dumps(meta15, indent=2))
    write_json(FN_MODELS / "fanal_sec_lgbm_15.json", head15["compact"])
    (FN_MODELS / "fanal_sec_meta_15.json").write_text(json.dumps(meta15, indent=2))
    print(f"Wrote 15s model enabled={enabled15}", flush=True)

    if swap:
        txt5 = MODELS / "fanal_sec_lgbm.txt"
        head5["booster"].save_model(str(txt5), num_iteration=head5["best_iteration"])
        meta5 = pack_meta(head5, i_train, i_val - i_train, n - i_val, {"horizon_15_enabled": enabled15})
        write_json(MODELS / "fanal_sec_lgbm.json", head5["compact"])
        (MODELS / "fanal_sec_meta.json").write_text(json.dumps(meta5, indent=2))
        write_json(FN_MODELS / "fanal_sec_lgbm.json", head5["compact"])
        (FN_MODELS / "fanal_sec_meta.json").write_text(json.dumps(meta5, indent=2))
        print(f"Wrote live 5s weights {txt5}", flush=True)
    else:
        # Keep current live JSON/txt. Still record the experiment next to models.
        report = pack_meta(head5, i_train, i_val - i_train, n - i_val, {"kept_previous_live": True})
        (MODELS / "fanal_sec_train_report.json").write_text(json.dumps(report, indent=2))
        print("Kept previous live 5s weights; wrote fanal_sec_train_report.json", flush=True)
        # Refresh meta calibration onto existing live model if feature names match — skip otherwise.
        live_meta_path = MODELS / "fanal_sec_meta.json"
        if live_meta_path.exists():
            old = json.loads(live_meta_path.read_text())
            old_feats = old.get("features") or []
            if old_feats == FEATURES:
                old.update(
                    {
                        "calib": head5["calib"],
                        "importance": head5["importance"],
                        "train_archive": "binance_vision_btcusdt_1s",
                        "live_venue": "coinbase",
                        "live_product": "BTC-USD",
                        "symbol": "BTC-USD",
                        "swap_reason": reason,
                        "swapped_live": False,
                        "horizon_15_enabled": enabled15,
                    }
                )
                live_meta_path.write_text(json.dumps(old, indent=2))
                shutil.copy2(live_meta_path, FN_MODELS / "fanal_sec_meta.json")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
