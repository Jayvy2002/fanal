#!/usr/bin/env python3
"""Train leak-free LightGBM on Coinbase Exchange BTC-USD 1-minute candles.

Flags:
  --days N            target history (default 90)
  --granularity 60    bar size in seconds (live = 60)
  --horizon 15        primary decision horizon in minutes (live = 15)

Heads trained: 1, 3, 5, 10, 15, 30 minutes.
Primary call = P(close_{t+15} > close_t). Gate = τ=0.58 AND |move| ≥ maker RT (120 bp).
Temporal split, no shuffle. Score only completed 1m bars (same as live).
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_candles import CANDLES_PATH, fetch_days

MODELS = ROOT / "models"
FN_MODELS = ROOT / "netlify" / "functions" / "_models"

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
    "range_bps",
    "body_ratio",
    "upper_wick",
    "lower_wick",
    "log_hl",
    "close_loc",
    "vol_z_30",
    "vol_z_60",
    "log_vol",
    "vol_shock_5",
    "tbr",
    "tbr_5",
    "tbr_15",
    "imb_5",
    "imb_15",
    "gap_up",
    "gap_dn",
    "gap_up_5",
    "gap_dn_5",
    "tod_sin",
    "tod_cos",
    "dow_sin",
    "dow_cos",
    "obi_10",
]

HEADS_M = [1, 3, 5, 10, 15, 30]
WARMUP = 61
TAU = 0.58
MAKER_RT_BPS = 120.0
TAKER_RT_BPS = 240.0
MAX_FILL_M = 5


def rolling_std(x: np.ndarray, window: int) -> np.ndarray:
    return pd.Series(x).rolling(window, min_periods=window).std(ddof=0).to_numpy()


def rolling_mean(x: np.ndarray, window: int) -> np.ndarray:
    return pd.Series(x).rolling(window, min_periods=window).mean().to_numpy()


def rolling_sum(x: np.ndarray, window: int) -> np.ndarray:
    return pd.Series(x).rolling(window, min_periods=window).sum().to_numpy()


def rolling_max(x: np.ndarray, window: int) -> np.ndarray:
    return pd.Series(x).rolling(window, min_periods=window).max().to_numpy()


def rolling_min(x: np.ndarray, window: int) -> np.ndarray:
    return pd.Series(x).rolling(window, min_periods=window).min().to_numpy()


def make_features(df: pd.DataFrame) -> pd.DataFrame:
    """Features at bar t use only that completed 1m bar and its past."""
    o = df["open"].to_numpy(dtype=np.float64)
    h = df["high"].to_numpy(dtype=np.float64)
    low = df["low"].to_numpy(dtype=np.float64)
    c = df["close"].to_numpy(dtype=np.float64)
    v = df["volume"].to_numpy(dtype=np.float64)
    tb = df["taker_buy_base"].to_numpy(dtype=np.float64)
    ntr = df["count"].to_numpy(dtype=np.float64)
    t_ms = df["open_time"].to_numpy(dtype=np.int64)

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

    tbr = np.divide(tb, v, out=np.full_like(v, 0.5), where=(v > 0) & (tb > 0))
    tbr = np.where((ntr <= 0) & (tb <= 0), 0.5, tbr)
    feat["tbr"] = tbr
    feat["tbr_5"] = rolling_mean(tbr, 5)
    feat["tbr_15"] = rolling_mean(tbr, 15)

    rng = np.maximum(h - low, 1e-12)
    body = np.abs(c - o)
    upper = h - np.maximum(o, c)
    lower = np.minimum(o, c) - low
    feat["range_bps"] = (rng / np.clip(c, 1e-12, None)) * 1e4
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

    signed = np.where((ntr <= 0) & (tb <= 0), 0.0, 2.0 * tb - v)
    vol5 = np.maximum(rolling_sum(v, 5), 1e-12)
    vol15 = np.maximum(rolling_sum(v, 15), 1e-12)
    feat["imb_5"] = rolling_sum(signed, 5) / vol5
    feat["imb_15"] = rolling_sum(signed, 15) / vol15

    prev_h = np.empty_like(h)
    prev_h[0] = h[0]
    prev_h[1:] = h[:-1]
    prev_l = np.empty_like(low)
    prev_l[0] = low[0]
    prev_l[1:] = low[:-1]
    feat["gap_up"] = np.maximum(0.0, prev_h - h) / np.clip(c, 1e-12, None)
    feat["gap_dn"] = np.maximum(0.0, low - prev_l) / np.clip(c, 1e-12, None)
    hi5 = rolling_max(h, 6)
    lo5 = rolling_min(low, 6)
    # exclude current bar from the 5-bar prior extreme
    prior_hi5 = np.empty_like(h)
    prior_hi5[0] = h[0]
    prior_hi5[1:] = rolling_max(h, 5)[:-1]
    prior_lo5 = np.empty_like(low)
    prior_lo5[0] = low[0]
    prior_lo5[1:] = rolling_min(low, 5)[:-1]
    feat["gap_up_5"] = np.maximum(0.0, prior_hi5 - h) / np.clip(c, 1e-12, None)
    feat["gap_dn_5"] = np.maximum(0.0, low - prior_lo5) / np.clip(c, 1e-12, None)

    minutes = ((t_ms // 1000) % 86400) // 60
    dow = ((t_ms // 1000) // 86400 + 4) % 7  # unix epoch Thursday
    feat["tod_sin"] = np.sin(2 * np.pi * minutes / (24 * 60))
    feat["tod_cos"] = np.cos(2 * np.pi * minutes / (24 * 60))
    feat["dow_sin"] = np.sin(2 * np.pi * dow / 7)
    feat["dow_cos"] = np.cos(2 * np.pi * dow / 7)
    feat["obi_10"] = 0.0
    _ = hi5, lo5
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


def densify_1m(df: pd.DataFrame, max_gap_m: int = MAX_FILL_M) -> pd.DataFrame:
    df = df.sort_values("open_time").drop_duplicates("open_time", keep="last").reset_index(drop=True)
    t = (df["open_time"].to_numpy(dtype=np.int64) // 60_000).astype(np.int64)
    if len(t) == 0:
        return df
    cuts = [0]
    for i in range(1, len(t)):
        if int(t[i] - t[i - 1]) > max_gap_m:
            cuts.append(i)
    cuts.append(len(t))
    chunks = []
    for a, b in zip(cuts, cuts[1:]):
        if b - a < WARMUP + 10:
            continue
        part = df.iloc[a:b].copy()
        part["min"] = (part["open_time"].to_numpy(dtype=np.int64) // 60_000).astype(np.int64)
        part = part.drop_duplicates("min", keep="last").set_index("min").sort_index()
        full = pd.RangeIndex(int(part.index.min()), int(part.index.max()) + 1, name="min")
        out = part.reindex(full)
        out["close"] = out["close"].ffill()
        miss = out["volume"].isna()
        out.loc[miss, "open"] = out.loc[miss, "close"]
        out.loc[miss, "high"] = out.loc[miss, "close"]
        out.loc[miss, "low"] = out.loc[miss, "close"]
        out.loc[miss, "volume"] = 0.0
        out.loc[miss, "count"] = 0.0
        out.loc[miss, "taker_buy_base"] = 0.0
        out["open_time"] = out.index.to_numpy(dtype=np.int64) * 60_000
        chunks.append(out.reset_index(drop=True))
    if not chunks:
        return df
    return pd.concat(chunks, ignore_index=True)


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


def vol_proxy_bps(X: np.ndarray, horizon_m: int) -> np.ndarray:
    rv5 = X[:, FEATURES.index("rv_5")]
    rv60 = X[:, FEATURES.index("rv_60")]
    return np.maximum(rv5, rv60) * math.sqrt(horizon_m) * 1e4


def lookup_bins(conf: np.ndarray, bins: list[dict], fallback: float) -> np.ndarray:
    out = np.full_like(conf, fallback, dtype=np.float64)
    if not bins:
        return out
    for b in bins:
        m = (conf >= b["lo"]) & (conf < b["hi"])
        out[m] = b["mean_abs"]
    m_hi = conf >= bins[-1]["hi"]
    out[m_hi] = bins[-1]["mean_abs"]
    return out


def predict_abs_move(p: np.ndarray, X: np.ndarray, calib: dict, horizon_m: int) -> np.ndarray:
    conf = np.abs(p - 0.5)
    vol = vol_proxy_bps(X, horizon_m)
    lin = (
        float(calib.get("abs_intercept") or 0.0)
        + float(calib.get("abs_beta_conf") or 0.0) * conf
        + float(calib.get("abs_beta_vol") or 0.0) * vol
    )
    lin = np.maximum(lin, 0.5)
    bin_e = lookup_bins(conf, calib.get("abs_bins") or [], float(calib.get("mean_abs_bps") or 8.0))
    typical = np.maximum(float(calib.get("mean_abs_bps") or 8.0), 1.0) * (
        0.45 + 0.55 * np.clip(conf / 0.5, 0, 1)
    )
    blended = 0.40 * lin + 0.35 * bin_e + 0.25 * typical
    cap = float(calib.get("clip_max_bps") or max(80.0, 25.0 * math.sqrt(horizon_m)))
    return np.clip(blended, 0.5, cap)


def gate_mask(p: np.ndarray, e_abs: np.ndarray, tau: float, min_move: float) -> np.ndarray:
    return ((p >= tau) | (p <= (1.0 - tau))) & (e_abs >= min_move)


def eval_gate(
    y: np.ndarray,
    p: np.ndarray,
    bps: np.ndarray,
    e_abs: np.ndarray,
    tau: float,
    min_move: float,
    maker_rt: float = MAKER_RT_BPS,
    taker_rt: float = TAKER_RT_BPS,
) -> dict:
    gated = gate_mask(p, e_abs, tau, min_move)
    n = int(gated.sum())
    cov = float(n / len(y)) if len(y) else 0.0
    empty = {
        "tau": float(tau),
        "min_move_bps": float(min_move),
        "gated_acc": None,
        "n": 0,
        "coverage": 0.0,
        "mean_abs_move_bps": None,
        "mean_signed_bps": None,
        "expectancy_maker_rt": None,
        "expectancy_taker_rt": None,
        "expectancy_1bp": None,
        "expectancy_2bp": None,
        "mean_e_abs_bps": None,
        "note": "aucune barre gated — couverture nulle au seuil de frais",
    }
    if n == 0:
        return empty
    pred = (p >= 0.5).astype(np.int32)
    acc = float((pred[gated] == y[gated]).mean())
    pred_sign = np.where(p >= 0.5, 1.0, -1.0)
    signed = pred_sign[gated] * bps[gated]
    mean_signed = float(np.nanmean(signed))
    return {
        "tau": float(tau),
        "min_move_bps": float(min_move),
        "gated_acc": acc,
        "n": n,
        "coverage": cov,
        "mean_abs_move_bps": float(np.nanmean(np.abs(bps[gated]))),
        "mean_signed_bps": mean_signed,
        "expectancy_maker_rt": mean_signed - maker_rt,
        "expectancy_taker_rt": mean_signed - taker_rt,
        "expectancy_1bp": mean_signed - 1.0,
        "expectancy_2bp": mean_signed - 2.0,
        "mean_e_abs_bps": float(np.nanmean(e_abs[gated])),
        "note": None,
    }


def fit_move_calib(p: np.ndarray, bps: np.ndarray, X: np.ndarray, tau: float, horizon_m: int) -> dict:
    ok = np.isfinite(p) & np.isfinite(bps)
    x = p[ok] - 0.5
    y = bps[ok]
    abs_y = np.abs(bps)
    conf = np.abs(p - 0.5)
    vol = vol_proxy_bps(X, horizon_m)
    clip = max(80.0, 25.0 * math.sqrt(horizon_m))
    if len(x) < 80 or float(np.var(x)) < 1e-12:
        mean_abs = float(np.nanmean(abs_y[ok])) if ok.any() else 8.0
        return {
            "beta_bps": 0.0,
            "intercept_bps": 0.0,
            "gated_up_mean_bps": 0.0,
            "gated_down_mean_bps": 0.0,
            "mean_abs_bps": mean_abs,
            "abs_intercept": mean_abs,
            "abs_beta_conf": 0.0,
            "abs_beta_vol": 1.0,
            "abs_bins": [],
            "horizon_m": horizon_m,
            "clip_max_bps": clip,
        }
    varx = float(np.var(x))
    beta = float(np.cov(x, y, ddof=0)[0, 1] / varx)
    intercept = float(np.mean(y) - beta * np.mean(x))
    up = (p >= tau) & ok
    down = (p <= 1.0 - tau) & ok
    A = np.column_stack([np.ones(ok.sum()), conf[ok], vol[ok]])
    coef, _, _, _ = np.linalg.lstsq(A, abs_y[ok], rcond=None)
    bins: list[dict] = []
    edges = np.linspace(0.0, 0.5, 11)
    for i in range(len(edges) - 1):
        m = ok & (conf >= edges[i]) & (conf < edges[i + 1] if i < len(edges) - 2 else conf <= edges[i + 1])
        if int(m.sum()) < 40:
            continue
        bins.append(
            {
                "lo": float(edges[i]),
                "hi": float(edges[i + 1]),
                "mean_abs": float(np.mean(abs_y[m])),
                "p50": float(np.median(abs_y[m])),
                "n": int(m.sum()),
            }
        )
    return {
        "beta_bps": beta,
        "intercept_bps": intercept,
        "gated_up_mean_bps": float(np.nanmean(bps[up])) if up.any() else 0.0,
        "gated_down_mean_bps": float(np.nanmean(bps[down])) if down.any() else 0.0,
        "mean_abs_bps": float(np.nanmean(abs_y[ok])),
        "abs_intercept": float(coef[0]),
        "abs_beta_conf": float(coef[1]),
        "abs_beta_vol": float(coef[2]),
        "abs_bins": bins,
        "horizon_m": horizon_m,
        "clip_max_bps": clip,
    }


def compact_dump(booster: lgb.Booster) -> dict:
    dumped = booster.dump_model(num_iteration=booster.best_iteration)
    return {
        "objective": "binary",
        "features": FEATURES,
        "best_iteration": int(booster.best_iteration),
        "trees": [{"nodes": flatten_tree(t["tree_structure"])} for t in dumped["tree_info"]],
    }


def verify_dump(compact: dict, X: np.ndarray, p: np.ndarray, horizon_m: int) -> list[dict]:
    sample_idx = [0, len(X) // 2, len(X) - 1]
    sanity = []
    for i in sample_idx:
        raw = score_dump(compact, X[i])
        p_js = sigmoid(raw)
        p_py = float(p[i])
        if abs(p_js - p_py) > 1e-5:
            raise SystemExit(f"scorer mismatch h={horizon_m} i={i} js={p_js} py={p_py}")
        sanity.append({"x": [float(v) for v in X[i]], "p": p_py, "raw": raw, "horizon_m": horizon_m})
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
    horizon_m: int,
) -> dict:
    dtrain = lgb.Dataset(X_tr, y_tr, feature_name=FEATURES, free_raw_data=False)
    dval = lgb.Dataset(X_va, y_va, feature_name=FEATURES, reference=dtrain, free_raw_data=False)
    params = {
        "objective": "binary",
        "metric": ["auc", "binary_logloss"],
        "learning_rate": 0.05,
        "num_leaves": 8,
        "max_depth": 3,
        "min_child_samples": 400,
        "subsample": 0.8,
        "subsample_freq": 1,
        "colsample_bytree": 0.7,
        "reg_lambda": 3.0,
        "reg_alpha": 0.2,
        "min_gain_to_split": 0.02,
        "verbose": -1,
        "seed": 42,
        "bagging_seed": 42,
        "feature_fraction_seed": 42,
    }
    print(f"Training LightGBM horizon={horizon_m}m (few trees) …", flush=True)
    booster = lgb.train(
        params,
        dtrain,
        num_boost_round=80,
        valid_sets=[dtrain, dval],
        valid_names=["train", "val"],
        callbacks=[lgb.early_stopping(20, verbose=True), lgb.log_evaluation(20)],
    )
    p_va = booster.predict(X_va, num_iteration=booster.best_iteration)
    p_te = booster.predict(X_te, num_iteration=booster.best_iteration)
    calib = fit_move_calib(p_va, bps_va, X_va, TAU, horizon_m)
    e_va = predict_abs_move(p_va, X_va, calib, horizon_m)
    e_te = predict_abs_move(p_te, X_te, calib, horizon_m)
    val_st = eval_gate(y_va, p_va, bps_va, e_va, TAU, MAKER_RT_BPS)
    test_st = eval_gate(y_te, p_te, bps_te, e_te, TAU, MAKER_RT_BPS)
    ungated = eval_gate(y_te, p_te, bps_te, e_te, TAU, 0.0)
    ret1 = X_te[:, FEATURES.index("ret_1")]
    naive_last_acc = float(((ret1 > 0).astype(np.int32) == y_te).mean())
    test_st["naive_last_acc"] = naive_last_acc
    ungated["naive_last_acc"] = naive_last_acc
    test_st["ungated_tau_only"] = {
        "gated_acc": ungated["gated_acc"],
        "n": ungated["n"],
        "coverage": ungated["coverage"],
        "mean_abs_move_bps": ungated["mean_abs_move_bps"],
        "expectancy_maker_rt": ungated["expectancy_maker_rt"],
        "expectancy_taker_rt": ungated["expectancy_taker_rt"],
    }
    all_abs = float(np.nanmean(np.abs(bps_te)))
    test_st["all_test_mean_abs_bps"] = all_abs

    print(
        f"VAL  h={horizon_m}m τ={TAU:.2f} gate={MAKER_RT_BPS:.0f}bp "
        f"acc={val_st['gated_acc']} n={val_st['n']} cov={val_st['coverage']:.4f} "
        f"|m|={val_st['mean_abs_move_bps']} E_maker={val_st['expectancy_maker_rt']}",
        flush=True,
    )
    print(
        f"TEST h={horizon_m}m τ={TAU:.2f} gate={MAKER_RT_BPS:.0f}bp "
        f"acc={test_st['gated_acc']} n={test_st['n']} cov={test_st['coverage']:.4f} "
        f"naive={naive_last_acc:.4f} |m|={test_st['mean_abs_move_bps']} "
        f"E_maker={test_st['expectancy_maker_rt']} E_taker={test_st['expectancy_taker_rt']} "
        f"all_|15m|={all_abs:.2f}bp",
        flush=True,
    )
    u = test_st["ungated_tau_only"]
    print(
        f"TEST τ-only (no fee gate) acc={u['gated_acc']} cov={u['coverage']:.4f} "
        f"|m|={u['mean_abs_move_bps']} E_maker={u['expectancy_maker_rt']}",
        flush=True,
    )

    compact = compact_dump(booster)
    sanity = verify_dump(compact, X_te, p_te, horizon_m)
    gain = booster.feature_importance(importance_type="gain")
    importance = [{"name": FEATURES[i], "gain": float(gain[i])} for i in np.argsort(-gain)]
    print(f"Dump scorer matches LightGBM predict() (h={horizon_m}m, trees={booster.best_iteration}).", flush=True)
    return {
        "booster": booster,
        "compact": compact,
        "tau": TAU,
        "min_move_bps": MAKER_RT_BPS,
        "val": val_st,
        "test": test_st,
        "sanity": sanity,
        "importance": importance,
        "calib": calib,
        "best_iteration": int(booster.best_iteration),
        "up_rate_test": float(y_te.mean()),
        "horizon_m": horizon_m,
        "p_te": p_te,
        "y_te": y_te,
    }


def load_bars(path: Path) -> pd.DataFrame:
    df = pd.read_csv(path, compression="gzip")
    for c in ["open_time", "open", "high", "low", "close", "volume", "count", "taker_buy_base"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df = df.dropna(subset=["close"]).sort_values("open_time").reset_index(drop=True)
    print(f"  raw 1m candles={len(df):,}", flush=True)
    dense = densify_1m(df)
    print(f"  densified 1m bars={len(dense):,}", flush=True)
    t0 = int(dense["open_time"].iloc[0])
    t1 = int(dense["open_time"].iloc[-1])
    print(
        f"  range {datetime.fromtimestamp(t0 / 1000, tz=timezone.utc).isoformat()} → "
        f"{datetime.fromtimestamp(t1 / 1000, tz=timezone.utc).isoformat()} "
        f"({(t1 - t0) / 1000 / 86400:.2f} d)",
        flush=True,
    )
    return dense


def write_json(path: Path, obj: dict) -> None:
    path.write_text(json.dumps(obj))


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Train Fanal 1m LightGBM")
    p.add_argument("--days", type=float, default=90)
    p.add_argument("--granularity", type=int, default=60, help="bar seconds (live=60)")
    p.add_argument("--horizon", type=int, default=15, help="primary horizon minutes (live=15)")
    p.add_argument("--skip-fetch", action="store_true")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    if args.granularity != 60:
        print(
            f"NOTE: live Fanal scores 1m (granularity=60). Got {args.granularity} — "
            "continuing with 60s candles (1s/5s dumps stay artifacts in models/).",
            flush=True,
        )
    horizon = int(args.horizon)
    if horizon not in HEADS_M:
        print(f"horizon {horizon} not in {HEADS_M} — using 15", flush=True)
        horizon = 15

    print(f"Coinbase BTC-USD 1m train target={args.days}d primary={horizon}m", flush=True)
    if not args.skip_fetch:
        fetch_days(args.days, 60)
    if not CANDLES_PATH.exists():
        print(f"missing {CANDLES_PATH}", file=sys.stderr)
        return 1

    df = load_bars(CANDLES_PATH)
    span_d = float((df["open_time"].iloc[-1] - df["open_time"].iloc[0]) / 1000.0 / 86400.0)
    n_bars = len(df)
    if span_d < 3:
        print(f"Not enough 1m history ({span_d:.2f} d).", file=sys.stderr)
        return 1
    if span_d < 90:
        print(f"NOTE: Coinbase 1m span={span_d:.2f} d (< 90 j visés) — on entraîne sur n={n_bars:,}.", flush=True)

    print("Features…", flush=True)
    X_df = make_features(df)
    close_all = df["close"].to_numpy(dtype=np.float64)

    heads: dict[int, dict] = {}
    for hm in HEADS_M:
        y_all = make_label(close_all, hm)
        bps_all = fwd_bps(close_all, hm)
        valid = X_df.notna().all(axis=1) & pd.notna(y_all) & pd.notna(bps_all)
        valid.iloc[:WARMUP] = False
        X = X_df.loc[valid, FEATURES].to_numpy(dtype=np.float64)
        y = y_all[valid.to_numpy()].astype(np.int32)
        bps = bps_all[valid.to_numpy()]
        print(f"  usable h={hm}m n={len(y):,} up_rate={y.mean():.4f} mean|m|={np.nanmean(np.abs(bps)):.2f}bp", flush=True)
        n = len(y)
        i_train = int(n * 0.70)
        i_val = int(n * 0.85)
        heads[hm] = train_head(
            X[:i_train],
            y[:i_train],
            X[i_train:i_val],
            y[i_train:i_val],
            X[i_val:],
            y[i_val:],
            bps[i_train:i_val],
            bps[i_val:],
            hm,
        )
        heads[hm]["n_train"] = i_train
        heads[hm]["n_val"] = i_val - i_train
        heads[hm]["n_test"] = n - i_val

    primary = heads[horizon]
    t0 = int(df["open_time"].iloc[0])
    t1 = int(df["open_time"].iloc[-1])
    bundle = {
        "objective": "binary",
        "features": FEATURES,
        "bar_s": 60,
        "heads": {str(hm): heads[hm]["compact"] for hm in HEADS_M},
    }
    head_meta = {}
    for hm in HEADS_M:
        h = heads[hm]
        head_meta[str(hm)] = {
            "calib": h["calib"],
            "test": {
                k: h["test"][k]
                for k in (
                    "gated_acc",
                    "n",
                    "coverage",
                    "naive_last_acc",
                    "mean_abs_move_bps",
                    "expectancy_maker_rt",
                    "expectancy_taker_rt",
                    "expectancy_1bp",
                    "expectancy_2bp",
                    "note",
                    "ungated_tau_only",
                    "all_test_mean_abs_bps",
                )
                if k in h["test"]
            },
            "enabled": True,
            "best_iteration": h["best_iteration"],
            "n_train": h["n_train"],
            "n_val": h["n_val"],
            "n_test": h["n_test"],
        }

    note = None
    if (primary["test"].get("coverage") or 0) < 0.01:
        note = (
            "Couverture TEST au gate 120 bp (RT faiseur) ≈ 0 : le |move| 15 m BTC "
            "est trop souvent sous les frais. C’est acceptable — le paper reste honnête."
        )
        print(f"HONEST: {note}", flush=True)

    meta = {
        "kind": "lgbm",
        "horizon_s": horizon * 60,
        "bar_s": 60,
        "primary_horizon_m": horizon,
        "horizons_m": HEADS_M,
        "symbol": "BTC-USD",
        "train_archive": "coinbase_exchange_btc_usd_candles_1m",
        "live_venue": "coinbase",
        "live_product": "BTC-USD",
        "tau": TAU,
        "min_move_bps": MAKER_RT_BPS,
        "features": FEATURES,
        "n_days": round(span_d, 3),
        "n_bars": int(n_bars),
        "span_start": datetime.fromtimestamp(t0 / 1000, tz=timezone.utc).isoformat(),
        "span_end": datetime.fromtimestamp(t1 / 1000, tz=timezone.utc).isoformat(),
        "n_train": primary["n_train"],
        "n_val": primary["n_val"],
        "n_test": primary["n_test"],
        "best_iteration": primary["best_iteration"],
        "val": primary["val"],
        "test": primary["test"],
        "up_rate_test": primary["up_rate_test"],
        "sanity": primary["sanity"],
        "importance": primary["importance"],
        "calib": primary["calib"],
        "heads": head_meta,
        "maker_rt_bps": MAKER_RT_BPS,
        "taker_rt_bps": TAKER_RT_BPS,
        "fee_note": (
            "Gate = RT faiseur 120 bp (Advanced Trade intro non vérifié). "
            "Exchange 60/40 est une alternate nommée, pas le défaut."
        ),
        "honest": note
        or (
            "Edge directionnel possible vs naive ; après RT faiseur 120 bp / preneur 240 bp "
            "l’espérance 15 m peut rester négative. Ce n’est pas un edge ATM."
        ),
    }

    MODELS.mkdir(parents=True, exist_ok=True)
    FN_MODELS.mkdir(parents=True, exist_ok=True)
    write_json(MODELS / "fanal_1m_lgbm.json", bundle)
    (MODELS / "fanal_1m_meta.json").write_text(json.dumps(meta, indent=2))
    write_json(FN_MODELS / "fanal_1m_lgbm.json", bundle)
    (FN_MODELS / "fanal_1m_meta.json").write_text(json.dumps(meta, indent=2))
    (MODELS / "fanal_1m_train_report.json").write_text(json.dumps(meta, indent=2))
    print(f"Wrote live 1m weights → {FN_MODELS / 'fanal_1m_lgbm.json'}", flush=True)
    print("Old 5s dumps in models/fanal_sec_* remain artifacts (not the live scorer).", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
