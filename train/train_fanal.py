#!/usr/bin/env python3
"""Train leak-free LightGBM 5s (+ optional 15s) or a 60s paper head.

1s bars are reconstructed from public REST trades (see fetch_coinbase.py). No API key.
Live Fanal scores the last *completed* 1s bar with the same relative microstructure
features. Time-based split only.

  python3 train/train_fanal.py 14              # 5s + 15s Coinbase (historique)
  python3 train/train_fanal.py --horizon 60    # tête paper 60s (gate = RT faiseur)

Le paper 60s n'entre pas sur la tête 5s. Gate = 120 bp (2 × 60 bp faiseur,
hypothèse Advanced Trade intro — voir netlify/functions/lib/paperFees.ts).
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
from fetch_coinbase import BARS_PATH, fetch_days
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

FEATURES_60 = FEATURES + [
    "ret_120",
    "rv_120",
    "tbr_60",
    "imb_60",
    "cvd_60",
    "vol_z_120",
]

# Must match netlify/functions/lib/paperFees.ts (Advanced Trade intro hyp., not Exchange).
TAKER_FEE_BPS = 120
MAKER_FEE_BPS = 60
MAKER_RT_BPS = 2 * MAKER_FEE_BPS
TAKER_RT_BPS = 2 * TAKER_FEE_BPS

# Current main (Binance Vision 1s, τ=0.58 only) — honest comparison target.
PREV_MAIN = {
    "gated_acc": 0.7025870427206409,
    "n": 299106,
    "coverage": 0.7494174655114527,
    "naive_last_acc": 0.5108890102676401,
    "mean_abs_move_bps": 1.0328544312011778,
    "expectancy_1bp": -0.7816733953462245,
    "expectancy_2bp": -1.7816733953462245,
    "tau": 0.58,
    "min_move_bps": 0.0,
    "train_archive": "binance_vision_btcusdt_1s",
}

BASELINE_GATED = PREV_MAIN["gated_acc"]
BASELINE_E1 = PREV_MAIN["expectancy_1bp"]
HORIZON_5 = 5
HORIZON_15 = 15
HORIZON_60 = 60
WARMUP = 60
WARMUP_60 = 120
COST_BPS = 1.0
MIN_COVERAGE = 0.01
PREF_COVERAGE = 0.05
TARGET_MIN_MOVE = 1.0
MAX_FILL_S = 30


def rolling_std(x: np.ndarray, window: int) -> np.ndarray:
    return pd.Series(x).rolling(window, min_periods=window).std(ddof=0).to_numpy()


def rolling_mean(x: np.ndarray, window: int) -> np.ndarray:
    return pd.Series(x).rolling(window, min_periods=window).mean().to_numpy()


def rolling_sum(x: np.ndarray, window: int) -> np.ndarray:
    return pd.Series(x).rolling(window, min_periods=window).sum().to_numpy()


def make_features(df: pd.DataFrame, names: list[str] | None = None) -> pd.DataFrame:
    """Features at bar t use only that completed bar and its past (no future close)."""
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

    col120 = np.full_like(logc, np.nan)
    col120[120:] = logc[120:] - logc[:-120]
    feat["ret_120"] = col120
    feat["rv_120"] = rolling_std(ret_1, 120)
    feat["tbr_60"] = rolling_mean(tbr, 60)
    vol60s = np.maximum(rolling_sum(v, 60), 1e-12)
    feat["imb_60"] = rolling_sum(signed, 60) / vol60s
    feat["cvd_60"] = rolling_sum(signed, 60)
    vmean120 = rolling_mean(v, 120)
    vstd120 = np.maximum(rolling_std(v, 120), 1e-12)
    feat["vol_z_120"] = (v - vmean120) / vstd120
    cols = names if names is not None else FEATURES
    return feat[cols]


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


def densify_chunk(part: pd.DataFrame) -> pd.DataFrame:
    part = part.copy()
    part["sec"] = (part["open_time"].to_numpy(dtype=np.int64) // 1000).astype(np.int64)
    part = part.drop_duplicates("sec", keep="last").set_index("sec").sort_index()
    full = pd.RangeIndex(int(part.index.min()), int(part.index.max()) + 1, name="sec")
    out = part.reindex(full)
    out["close"] = out["close"].ffill()
    miss = out["volume"].isna()
    out.loc[miss, "open"] = out.loc[miss, "close"]
    out.loc[miss, "high"] = out.loc[miss, "close"]
    out.loc[miss, "low"] = out.loc[miss, "close"]
    out.loc[miss, "volume"] = 0.0
    out.loc[miss, "count"] = 0.0
    out.loc[miss, "taker_buy_base"] = 0.0
    out["open_time"] = out.index.to_numpy(dtype=np.int64) * 1000
    return out.reset_index(drop=True)


def densify_1s(df: pd.DataFrame, max_gap_s: int = MAX_FILL_S) -> pd.DataFrame:
    df = df.sort_values("open_time").drop_duplicates("open_time", keep="last").reset_index(drop=True)
    t = (df["open_time"].to_numpy(dtype=np.int64) // 1000)
    if len(t) == 0:
        return df
    cuts = [0]
    for i in range(1, len(t)):
        if int(t[i] - t[i - 1]) > max_gap_s:
            cuts.append(i)
    cuts.append(len(t))
    chunks = []
    for a, b in zip(cuts, cuts[1:]):
        if b - a < WARMUP + 10:
            continue
        chunks.append(densify_chunk(df.iloc[a:b]))
    if not chunks:
        return densify_chunk(df)
    out = pd.concat(chunks, ignore_index=True)
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


def vol_proxy_bps(X: np.ndarray, horizon: int = HORIZON_5, names: list[str] | None = None) -> np.ndarray:
    cols = names or FEATURES
    def col(name: str) -> np.ndarray:
        if name not in cols:
            return np.zeros(len(X))
        return X[:, cols.index(name)]

    if horizon >= 60:
        rv = np.maximum.reduce([col("rv_15"), col("rv_30"), col("rv_60"), col("rv_120")])
    else:
        rv = np.maximum(col("rv_5"), col("rv_60"))
    return rv * math.sqrt(horizon) * 1e4


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


def predict_abs_move(
    p: np.ndarray,
    X: np.ndarray,
    calib: dict,
    horizon: int = HORIZON_5,
    names: list[str] | None = None,
) -> np.ndarray:
    conf = np.abs(p - 0.5)
    vol_h = horizon if horizon >= 60 else HORIZON_5
    cap = 400.0 if horizon >= 60 else 25.0
    vol = vol_proxy_bps(X, vol_h, names)
    mean_abs_floor = 4.0 if horizon >= 60 else 0.5
    lin = (
        float(calib.get("abs_intercept") or 0.0)
        + float(calib.get("abs_beta_conf") or 0.0) * conf
        + float(calib.get("abs_beta_vol") or 0.0) * vol
    )
    lin = np.maximum(lin, 0.05)
    bin_e = lookup_bins(conf, calib.get("abs_bins") or [], float(calib.get("mean_abs_bps") or 1.0))
    typical = np.maximum(float(calib.get("mean_abs_bps") or mean_abs_floor), mean_abs_floor) * (
        0.45 + 0.55 * np.clip(conf / 0.5, 0, 1)
    )
    blended = 0.40 * lin + 0.35 * bin_e + 0.25 * typical
    return np.clip(blended, 0.05, cap)


def gate_mask(p: np.ndarray, e_abs: np.ndarray, tau: float, min_move: float) -> np.ndarray:
    return ((p >= tau) | (p <= (1.0 - tau))) & (e_abs >= min_move)


def eval_gate(y: np.ndarray, p: np.ndarray, bps: np.ndarray, e_abs: np.ndarray, tau: float, min_move: float) -> dict:
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
        "expectancy_1bp": None,
        "expectancy_2bp": None,
        "expectancy_maker_rt": None,
        "expectancy_taker_rt": None,
        "mean_e_abs_bps": None,
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
        "expectancy_1bp": mean_signed - 1.0,
        "expectancy_2bp": mean_signed - 2.0,
        "expectancy_maker_rt": mean_signed - MAKER_RT_BPS,
        "expectancy_taker_rt": mean_signed - TAKER_RT_BPS,
        "mean_e_abs_bps": float(np.nanmean(e_abs[gated])),
    }


def pick_gate(y: np.ndarray, p: np.ndarray, bps: np.ndarray, e_abs: np.ndarray) -> tuple[float, float, dict]:
    taus = [0.52, 0.54, 0.55, 0.56, 0.57, 0.58, 0.59, 0.60, 0.62, 0.64, 0.66]
    moves = [0.80, 0.90, 1.00, 1.10, 1.20, 1.40, 1.60, 2.00, 2.50]
    cands: list[dict] = []
    for tau in taus:
        for mv in moves:
            st = eval_gate(y, p, bps, e_abs, float(tau), float(mv))
            if st["n"] < 200 or st["coverage"] < MIN_COVERAGE:
                continue
            if st["expectancy_1bp"] is None:
                continue
            cands.append(st)
    if not cands:
        st = eval_gate(y, p, bps, e_abs, 0.58, TARGET_MIN_MOVE)
        return 0.58, TARGET_MIN_MOVE, st

    def score(st: dict) -> tuple:
        e1 = float(st["expectancy_1bp"])
        cov = float(st["coverage"])
        mv = float(st["min_move_bps"])
        tau = float(st["tau"])
        cov_bonus = 0.015 if cov >= PREF_COVERAGE else 0.0
        cov_term = 0.02 * min(cov, 0.12)
        prefer_1bp = 0.012 if abs(mv - TARGET_MIN_MOVE) < 1e-9 else 0.0
        prefer_tau = 0.004 if abs(tau - 0.58) < 1e-9 else 0.0
        return (e1 + cov_bonus + cov_term + prefer_1bp + prefer_tau, e1, cov)

    ranked = sorted(cands, key=score, reverse=True)
    best_e1 = float(ranked[0]["expectancy_1bp"])
    near = [
        st
        for st in ranked
        if float(st["expectancy_1bp"]) >= best_e1 - 0.02 and st["coverage"] >= PREF_COVERAGE
    ]
    pool = near or ranked
    pool.sort(
        key=lambda st: (
            abs(float(st["min_move_bps"]) - TARGET_MIN_MOVE),
            abs(float(st["tau"]) - 0.58),
            -float(st["expectancy_1bp"]),
        )
    )
    chosen = pool[0]
    return float(chosen["tau"]), float(chosen["min_move_bps"]), chosen


def fit_move_calib(
    p: np.ndarray,
    bps: np.ndarray,
    X: np.ndarray,
    tau: float,
    horizon: int = HORIZON_5,
    names: list[str] | None = None,
) -> dict:
    ok = np.isfinite(p) & np.isfinite(bps)
    x = p[ok] - 0.5
    y = bps[ok]
    abs_y = np.abs(bps)
    conf = np.abs(p - 0.5)
    vol_h = horizon if horizon >= 60 else HORIZON_5
    vol = vol_proxy_bps(X, vol_h, names)
    if len(x) < 100 or float(np.var(x)) < 1e-12:
        mean_abs = float(np.nanmean(abs_y[ok])) if ok.any() else 0.0
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
        if int(m.sum()) < 80:
            continue
        bins.append(
            {
                "lo": float(edges[i]),
                "hi": float(edges[i + 1]),
                "mean_abs": float(np.mean(abs_y[m])),
                "p50": float(np.median(abs_y[m])),
                "p70": float(np.quantile(abs_y[m], 0.70)),
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
    }


def compact_dump(booster: lgb.Booster, names: list[str] | None = None) -> dict:
    dumped = booster.dump_model(num_iteration=booster.best_iteration)
    return {
        "objective": "binary",
        "features": names or FEATURES,
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
        "min_child_samples": 400,
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

    calib = fit_move_calib(p_va, bps_va, X_va, 0.58)
    e_va = predict_abs_move(p_va, X_va, calib)
    e_te = predict_abs_move(p_te, X_te, calib)
    tau, min_move, val_st = pick_gate(y_va, p_va, bps_va, e_va)
    calib["min_move_bps"] = float(min_move)
    test_st = eval_gate(y_te, p_te, bps_te, e_te, tau, min_move)

    ret1 = X_te[:, FEATURES.index("ret_1")]
    naive_pred = (ret1 > 0).astype(np.int32)
    naive_last_acc = float((naive_pred == y_te).mean())
    test_st["naive_last_acc"] = naive_last_acc

    ungated = eval_gate(y_te, p_te, bps_te, e_te, tau, 0.0)
    ungated["naive_last_acc"] = naive_last_acc
    test_st["ungated_tau_only"] = {
        "gated_acc": ungated["gated_acc"],
        "n": ungated["n"],
        "coverage": ungated["coverage"],
        "mean_abs_move_bps": ungated["mean_abs_move_bps"],
        "expectancy_1bp": ungated["expectancy_1bp"],
        "expectancy_2bp": ungated["expectancy_2bp"],
    }

    print(
        f"VAL  h={horizon} tau={tau:.3f} min_move={min_move:.2f}bp "
        f"gated_acc={val_st['gated_acc']:.4f} n={val_st['n']} cov={val_st['coverage']:.3f} "
        f"|move|={val_st['mean_abs_move_bps']:.3f}bps E1={val_st['expectancy_1bp']:.3f} "
        f"E2={val_st['expectancy_2bp']:.3f}",
        flush=True,
    )
    print(
        f"TEST h={horizon} tau={tau:.3f} min_move={min_move:.2f}bp "
        f"gated_acc={test_st['gated_acc']:.4f} n={test_st['n']} cov={test_st['coverage']:.3f} "
        f"naive={naive_last_acc:.4f} |move|={test_st['mean_abs_move_bps']:.3f}bps "
        f"E1={test_st['expectancy_1bp']:.3f} E2={test_st['expectancy_2bp']:.3f}",
        flush=True,
    )
    u = test_st["ungated_tau_only"]
    print(
        f"TEST τ-only (no move gate) acc={u['gated_acc']:.4f} cov={u['coverage']:.3f} "
        f"|move|={u['mean_abs_move_bps']:.3f} E1={u['expectancy_1bp']:.3f}",
        flush=True,
    )

    compact = compact_dump(booster)
    sanity = verify_dump(compact, X_te, p_te)
    gain = booster.feature_importance(importance_type="gain")
    importance = [{"name": FEATURES[i], "gain": float(gain[i])} for i in np.argsort(-gain)]
    print(f"Dump scorer matches LightGBM predict() (h={horizon}).", flush=True)
    print(
        f"calib h={horizon} beta={calib['beta_bps']:.4f} abs_b0={calib['abs_intercept']:.4f} "
        f"abs_bconf={calib['abs_beta_conf']:.4f} abs_bvol={calib['abs_beta_vol']:.4f} "
        f"up={calib['gated_up_mean_bps']:.4f} down={calib['gated_down_mean_bps']:.4f}",
        flush=True,
    )
    return {
        "booster": booster,
        "compact": compact,
        "tau": float(tau),
        "min_move_bps": float(min_move),
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
    n = int(test_st.get("n") or 0)
    usable = cov >= MIN_COVERAGE and n >= 200
    if acc is None or not usable:
        return False, (
            f"couverture TEST trop faible (cov={cov:.4f}, n={n}) — on garde les poids live"
        )
    better_e = e1 is not None and e1 > BASELINE_E1 + 1e-12
    better_acc = acc + 1e-12 >= BASELINE_GATED
    if better_e:
        return True, (
            f"TEST E après 1bp {e1:.3f} > main {BASELINE_E1:.3f} "
            f"(acc={acc:.4f}, cov={cov:.3f})"
        )
    if better_acc:
        return True, (
            f"TEST gated {acc:.4f} ≥ main {BASELINE_GATED:.4f} "
            f"(E1={e1:.3f}, cov={cov:.3f})"
        )
    return False, (
        f"on garde les poids live actuels "
        f"(TEST gated {acc:.4f} vs {BASELINE_GATED:.4f}, "
        f"E1={e1:.3f} vs {BASELINE_E1:.3f}, cov={cov:.3f})"
    )


def write_json(path: Path, obj: dict) -> None:
    path.write_text(json.dumps(obj))


def bars_span_days(path: Path) -> float:
    df = pd.read_csv(path, compression="gzip", usecols=["open_time"])
    t = df["open_time"].to_numpy(dtype=np.int64)
    if len(t) < 2:
        return 0.0
    return float((t.max() - t.min()) / 1000.0 / 86400.0)


def ensure_bars(n_days: int) -> Path:
    if BARS_PATH.exists():
        span = bars_span_days(BARS_PATH)
        print(f"Existing Coinbase 1s bars span={span:.2f}d at {BARS_PATH}", flush=True)
        if span >= max(3.0, 0.85 * n_days):
            return BARS_PATH
        print("Span short of target — fetching more trades…", flush=True)
    else:
        print("No Coinbase 1s bars yet — downloading public trades…", flush=True)
    return fetch_days(n_days)


def load_coinbase_bars(path: Path) -> pd.DataFrame:
    df = pd.read_csv(path, compression="gzip")
    for c in ["open_time", "open", "high", "low", "close", "volume", "count", "taker_buy_base"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df = df.dropna(subset=["close"]).sort_values("open_time").reset_index(drop=True)
    print(f"  raw traded seconds={len(df):,}", flush=True)
    dense = densify_1s(df)
    print(f"  densified 1s bars={len(dense):,}", flush=True)
    t0 = int(dense["open_time"].iloc[0])
    t1 = int(dense["open_time"].iloc[-1])
    print(
        f"  range {datetime.fromtimestamp(t0 / 1000, tz=timezone.utc).isoformat()} → "
        f"{datetime.fromtimestamp(t1 / 1000, tz=timezone.utc).isoformat()} "
        f"({(t1 - t0) / 1000 / 86400:.2f} d)",
        flush=True,
    )
    return dense


def main_5s(n_days: int) -> int:
    print(f"Coinbase BTC-USD 1s train target={n_days}d", flush=True)
    path = ensure_bars(n_days)
    df = load_coinbase_bars(path)
    span_d = float(
        (df["open_time"].iloc[-1] - df["open_time"].iloc[0]) / 1000.0 / 86400.0
    )
    fallback_note = None
    if span_d < 3:
        print(f"Not enough Coinbase 1s history ({span_d:.2f} d).", file=sys.stderr)
        return 1
    if span_d < 7:
        fallback_note = (
            f"historique 1s Coinbase {span_d:.1f} j (< 7 j visés) — horizon 5s conservé, "
            "pas de bascule 5 minutes"
        )
        print(f"NOTE: {fallback_note}", flush=True)

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
    t0 = int(df["open_time"].iloc[0])
    t1 = int(df["open_time"].iloc[-1])
    days = sorted(
        {
            datetime.fromtimestamp(int(ts) / 1000, tz=timezone.utc).date().isoformat()
            for ts in (t0, t1)
        }
    )

    def pack_meta(head: dict, n_tr: int, n_va: int, n_te: int, extra: dict | None = None) -> dict:
        meta = {
            "kind": "lgbm",
            "horizon_s": head["horizon_s"],
            "bar_s": 1,
            "symbol": "BTC-USD",
            "train_archive": "coinbase_exchange_btc_usd_trades_1s",
            "live_venue": "coinbase",
            "live_product": "BTC-USD",
            "tau": head["tau"],
            "min_move_bps": head["min_move_bps"],
            "features": FEATURES,
            "n_days": round(span_d, 3),
            "span_start": datetime.fromtimestamp(t0 / 1000, tz=timezone.utc).isoformat(),
            "span_end": datetime.fromtimestamp(t1 / 1000, tz=timezone.utc).isoformat(),
            "days": days,
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
            "previous_main": PREV_MAIN,
            "fallback_note": fallback_note,
            "swapped_live": swap if head["horizon_s"] == HORIZON_5 else None,
            "swap_reason": reason if head["horizon_s"] == HORIZON_5 else None,
            "honest": (
                "Edge directionnel vs naive possible, mais l'espérance après 1 bp de friction "
                "peut rester négative — ce n'est pas un edge ATM."
            ),
        }
        if extra:
            meta.update(extra)
        return meta

    report = pack_meta(head5, i_train, i_val - i_train, n - i_val)
    meta15 = pack_meta(head15, i_tr15, i_va15 - i_tr15, n15 - i_va15)
    enabled15 = (
        head15["test"]["gated_acc"] is not None
        and head15["test"]["gated_acc"] >= 0.54
        and head15["test"]["coverage"] >= MIN_COVERAGE
    )
    meta15["enabled"] = bool(enabled15)

    # Always keep the Coinbase experiment on disk (even if live 5s trees stay).
    head5["booster"].save_model(
        str(MODELS / "fanal_sec_lgbm_coinbase.txt"), num_iteration=head5["best_iteration"]
    )
    write_json(MODELS / "fanal_sec_lgbm_coinbase.json", head5["compact"])
    (MODELS / "fanal_sec_train_report.json").write_text(json.dumps(report, indent=2))
    head15["booster"].save_model(
        str(MODELS / "fanal_sec_lgbm_15_coinbase.txt"), num_iteration=head15["best_iteration"]
    )
    write_json(MODELS / "fanal_sec_lgbm_15_coinbase.json", head15["compact"])
    (MODELS / "fanal_sec_meta_15_coinbase.json").write_text(json.dumps(meta15, indent=2))
    print("Wrote Coinbase experiment dumps (models/*coinbase*)", flush=True)

    prev15_acc = 0.643
    live15_ok = bool(enabled15) and float(head15["test"]["gated_acc"] or 0) + 1e-12 >= prev15_acc
    live15_enabled = bool(enabled15)
    if swap and live15_ok:
        txt15 = MODELS / "fanal_sec_lgbm_15.txt"
        head15["booster"].save_model(str(txt15), num_iteration=head15["best_iteration"])
        write_json(MODELS / "fanal_sec_lgbm_15.json", head15["compact"])
        (MODELS / "fanal_sec_meta_15.json").write_text(json.dumps(meta15, indent=2))
        write_json(FN_MODELS / "fanal_sec_lgbm_15.json", head15["compact"])
        (FN_MODELS / "fanal_sec_meta_15.json").write_text(json.dumps(meta15, indent=2))
        print(f"Wrote live 15s model enabled={enabled15}", flush=True)
    else:
        print(
            f"Kept previous live 15s (Coinbase 15s TEST acc={head15['test']['gated_acc']})",
            flush=True,
        )
        live15_path = MODELS / "fanal_sec_meta_15.json"
        if live15_path.exists():
            old15 = json.loads(live15_path.read_text())
            old15["min_move_bps"] = TARGET_MIN_MOVE
            old15["coinbase_train_15"] = {
                "test": head15["test"],
                "tau": head15["tau"],
                "min_move_bps": head15["min_move_bps"],
                "kept_previous_live": True,
            }
            live15_enabled = bool(old15.get("enabled", True))
            live15_path.write_text(json.dumps(old15, indent=2))
            shutil.copy2(live15_path, FN_MODELS / "fanal_sec_meta_15.json")

    report["horizon_15_enabled"] = live15_enabled

    if swap:
        txt5 = MODELS / "fanal_sec_lgbm.txt"
        head5["booster"].save_model(str(txt5), num_iteration=head5["best_iteration"])
        write_json(MODELS / "fanal_sec_lgbm.json", head5["compact"])
        (MODELS / "fanal_sec_meta.json").write_text(json.dumps(report, indent=2))
        write_json(FN_MODELS / "fanal_sec_lgbm.json", head5["compact"])
        (FN_MODELS / "fanal_sec_meta.json").write_text(json.dumps(report, indent=2))
        print(f"Wrote live 5s weights {txt5}", flush=True)
    else:
        print("Kept previous live 5s trees; enabling 1bp move gate on existing calib.", flush=True)
        live_meta_path = MODELS / "fanal_sec_meta.json"
        if live_meta_path.exists():
            old = json.loads(live_meta_path.read_text())
            old_feats = old.get("features") or []
            if old_feats == FEATURES:
                old.update(
                    {
                        "min_move_bps": TARGET_MIN_MOVE,
                        "live_venue": "coinbase",
                        "live_product": "BTC-USD",
                        "symbol": "BTC-USD",
                        "swap_reason": reason,
                        "swapped_live": False,
                        "horizon_15_enabled": live15_enabled,
                        "previous_main": PREV_MAIN,
                        "coinbase_train": {
                            "archive": "coinbase_exchange_btc_usd_trades_1s",
                            "test": head5["test"],
                            "val": head5["val"],
                            "tau": head5["tau"],
                            "min_move_bps": head5["min_move_bps"],
                            "n_days": round(span_d, 3),
                            "kept_previous_live": True,
                            "note": "poids live inchangés (Binance Vision) ; gate 1 bp appliqué à l'inférence",
                        },
                        "fallback_note": fallback_note,
                        "honest": report["honest"],
                    }
                )
                live_meta_path.write_text(json.dumps(old, indent=2))
                shutil.copy2(live_meta_path, FN_MODELS / "fanal_sec_meta.json")

    return 0


def try_load_any_bars() -> tuple[pd.DataFrame, str] | None:
    if BARS_PATH.exists():
        print(f"Using Coinbase 1s bars {BARS_PATH}", flush=True)
        return load_coinbase_bars(BARS_PATH), "coinbase_exchange_btc_usd_trades_1s"
    vision = ROOT / "data" / "binance"
    files = sorted(vision.glob("BTCUSDT-1s-*.csv")) + sorted(vision.glob("*.csv.gz"))
    if files:
        print(f"Using Binance Vision 1s {files[0].parent} ({len(files)} files)", flush=True)
        parts = []
        for f in files:
            part = pd.read_csv(f, header=None)
            part.columns = [
                "open_time", "open", "high", "low", "close", "volume",
                "close_time", "quote_volume", "count", "taker_buy_base",
                "taker_buy_quote", "ignore",
            ][: len(part.columns)]
            parts.append(part)
        df = pd.concat(parts, ignore_index=True)
        for c in ["open_time", "open", "high", "low", "close", "volume", "count", "taker_buy_base"]:
            df[c] = pd.to_numeric(df[c], errors="coerce")
        df = df.dropna(subset=["close"]).sort_values("open_time").reset_index(drop=True)
        ot0 = float(df["open_time"].iloc[0])
        if ot0 > 1e14:  # microseconds
            df["open_time"] = df["open_time"] / 1000.0
        elif ot0 < 1e12:  # seconds
            df["open_time"] = df["open_time"] * 1000.0
        dense = densify_1s(df)
        return dense, "binance_vision_btcusdt_1s"
    return None


def train_60_main(n_days: int) -> int:
    """Tête paper 60s. Ne remplace pas les poids live 5s."""
    loaded = try_load_any_bars()
    if loaded is None:
        print(
            "Aucun dump 1s dans data/ (gitignoré). "
            "Télécharger des klines Binance Vision 1s dans data/binance/ "
            "ou lancer fetch_coinbase.py, puis relancer --horizon 60.",
            flush=True,
        )
        return 2

    df, archive = loaded
    span_d = float((df["open_time"].iloc[-1] - df["open_time"].iloc[0]) / 1000.0 / 86400.0)
    print(f"60s train archive={archive} span={span_d:.2f}d rows={len(df):,}", flush=True)
    if span_d < 0.5:
        print("Historique trop court pour un TEST 60s.", file=sys.stderr)
        return 1

    X_df = make_features(df, FEATURES_60)
    close_all = df["close"].to_numpy(dtype=np.float64)
    y_all = make_label(close_all, HORIZON_60)
    bps_all = fwd_bps(close_all, HORIZON_60)
    valid = X_df.notna().all(axis=1) & pd.notna(y_all) & pd.notna(bps_all)
    valid.iloc[:WARMUP_60] = False
    X = X_df.loc[valid, FEATURES_60].to_numpy(dtype=np.float64)
    y = y_all[valid.to_numpy()].astype(np.int32)
    bps = bps_all[valid.to_numpy()]
    close = close_all[valid.to_numpy()]
    print(f"  usable 60s={len(y):,}  up_rate={y.mean():.4f}  |move|={np.nanmean(np.abs(bps)):.2f}bp", flush=True)

    n = len(y)
    i_train = int(n * 0.70)
    i_val = int(n * 0.85)
    X_tr, y_tr = X[:i_train], y[:i_train]
    X_va, y_va = X[i_train:i_val], y[i_train:i_val]
    X_te, y_te = X[i_val:], y[i_val:]
    bps_va, bps_te = bps[i_train:i_val], bps[i_val:]

    dtrain = lgb.Dataset(X_tr, y_tr, feature_name=FEATURES_60, free_raw_data=False)
    dval = lgb.Dataset(X_va, y_va, feature_name=FEATURES_60, reference=dtrain, free_raw_data=False)
    params = {
        "objective": "binary",
        "metric": ["auc", "binary_logloss"],
        "learning_rate": 0.05,
        "num_leaves": 15,
        "max_depth": 5,
        "min_child_samples": 200,
        "subsample": 0.8,
        "subsample_freq": 1,
        "colsample_bytree": 0.85,
        "reg_lambda": 2.0,
        "verbose": -1,
        "seed": 42,
    }
    print("Training LightGBM horizon=60s (small) …", flush=True)
    booster = lgb.train(
        params,
        dtrain,
        num_boost_round=150,
        valid_sets=[dtrain, dval],
        valid_names=["train", "val"],
        callbacks=[lgb.early_stopping(30, verbose=True), lgb.log_evaluation(30)],
    )
    p_va = booster.predict(X_va, num_iteration=booster.best_iteration)
    p_te = booster.predict(X_te, num_iteration=booster.best_iteration)
    calib = fit_move_calib(p_va, bps_va, X_va, 0.58, HORIZON_60, FEATURES_60)
    e_va = predict_abs_move(p_va, X_va, calib, HORIZON_60, FEATURES_60)
    e_te = predict_abs_move(p_te, X_te, calib, HORIZON_60, FEATURES_60)

    tau = 0.58
    min_move = float(MAKER_RT_BPS)
    calib["min_move_bps"] = min_move
    val_st = eval_gate(y_va, p_va, bps_va, e_va, tau, min_move)
    test_st = eval_gate(y_te, p_te, bps_te, e_te, tau, min_move)
    ungated = eval_gate(y_te, p_te, bps_te, e_te, tau, 0.0)
    at10 = eval_gate(y_te, p_te, bps_te, e_te, tau, 10.0)
    ret1 = X_te[:, FEATURES_60.index("ret_60")]
    naive = float(((ret1 > 0).astype(np.int32) == y_te).mean())
    test_st["naive_last_acc"] = naive
    test_st["ungated_tau_only"] = ungated
    test_st["gate_10bp"] = at10

    def _fmt(st: dict, tag: str) -> None:
        acc = st.get("gated_acc")
        acc_s = f"{acc:.4f}" if acc is not None else "n/a"
        mv = st.get("mean_abs_move_bps")
        mv_s = f"{mv:.2f}" if mv is not None else "n/a"
        em = st.get("expectancy_maker_rt")
        et = st.get("expectancy_taker_rt")
        em_s = f"{em:.2f}" if em is not None else "n/a"
        et_s = f"{et:.2f}" if et is not None else "n/a"
        print(
            f"{tag} tau={tau:.2f} min_move={st.get('min_move_bps')}bp "
            f"acc={acc_s} n={st['n']} cov={st['coverage']:.5f} "
            f"|move|={mv_s} E_makerRT={em_s} E_takerRT={et_s}",
            flush=True,
        )

    _fmt(val_st, "VAL  60s gate=RT faiseur")
    _fmt(test_st, "TEST 60s gate=RT faiseur")
    _fmt(at10, "TEST 60s gate=10bp (référence, pas le paper)")
    _fmt(ungated, "TEST 60s τ-only")

    compact = compact_dump(booster, FEATURES_60)
    sanity = verify_dump(compact, X_te, p_te)
    gain = booster.feature_importance(importance_type="gain")
    importance = [{"name": FEATURES_60[i], "gain": float(gain[i])} for i in np.argsort(-gain)]
    t0 = int(df["open_time"].iloc[0])
    t1 = int(df["open_time"].iloc[-1])
    meta = {
        "kind": "lgbm",
        "horizon_s": 60,
        "bar_s": 1,
        "enabled": True,
        "fallback": False,
        "symbol": "BTC-USD",
        "train_archive": archive,
        "live_venue": "coinbase",
        "tau": tau,
        "min_move_bps": min_move,
        "features": FEATURES_60,
        "n_days": round(span_d, 3),
        "span_start": datetime.fromtimestamp(t0 / 1000, tz=timezone.utc).isoformat(),
        "span_end": datetime.fromtimestamp(t1 / 1000, tz=timezone.utc).isoformat(),
        "n_train": int(i_train),
        "n_val": int(i_val - i_train),
        "n_test": int(n - i_val),
        "best_iteration": int(booster.best_iteration),
        "val": val_st,
        "test": test_st,
        "up_rate_test": float(y_te.mean()),
        "sanity": sanity,
        "importance": importance,
        "calib": calib,
        "cost_bps": MAKER_RT_BPS,
        "maker_rt_bps": MAKER_RT_BPS,
        "taker_rt_bps": TAKER_RT_BPS,
        "honest": (
            "Gate paper = 120 bp (RT faiseur, hypothèse Advanced Trade intro). "
            "Le |move| 60s BTC est souvent ~10 bp : couverture minuscule. "
            "E après frais négative n'est pas maquillée. Ce n'est pas un meilleur 5s."
        ),
    }
    MODELS.mkdir(parents=True, exist_ok=True)
    FN_MODELS.mkdir(parents=True, exist_ok=True)
    booster.save_model(str(MODELS / "fanal_sec_lgbm_60.txt"), num_iteration=booster.best_iteration)
    write_json(MODELS / "fanal_sec_lgbm_60.json", compact)
    (MODELS / "fanal_sec_meta_60.json").write_text(json.dumps(meta, indent=2))
    write_json(FN_MODELS / "fanal_sec_lgbm_60.json", compact)
    (FN_MODELS / "fanal_sec_meta_60.json").write_text(json.dumps(meta, indent=2))
    print("Wrote 60s paper model (live 5s weights unchanged).", flush=True)
    _ = n_days
    return 0


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Train Fanal LightGBM heads")
    p.add_argument("days", nargs="?", type=int, default=14, help="jours Coinbase à viser (5s/15s)")
    p.add_argument("--horizon", type=int, default=5, choices=[5, 15, 60], help="5 (défaut) ou 60 (paper)")
    return p.parse_args(argv)


def cli(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    if args.horizon == 60:
        return train_60_main(args.days)
    return main_5s(args.days)


def main() -> int:
    return cli()


if __name__ == "__main__":
    raise SystemExit(main())
