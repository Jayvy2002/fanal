#!/usr/bin/env python3
"""Train leak-free LightGBM 1h / 4h on Coinbase Exchange 5-minute candles.

Label: P(close_{t+h} > close_t), h ∈ {1h, 4h}.
Bars = 5 m completed only. Temporal split, walk-forward, held-out TEST. No shuffle.
"""

from __future__ import annotations

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
from fetch_coinbase_5m import main as fetch_5m

MODELS = ROOT / "models" / "predictor"
FN_MODELS = ROOT / "netlify" / "functions" / "lib" / "predictor" / "_models"

FEATURES = [
    "ret_3",
    "ret_12",
    "ret_48",
    "ret_144",
    "ret_288",
    "rv_12",
    "rv_48",
    "rv_144",
    "rv_288",
    "body_ratio",
    "upper_wick",
    "lower_wick",
    "log_hl",
    "close_loc",
    "vol_z_48",
    "vol_z_288",
    "log_vol",
    "vol_shock_12",
    "range_z_48",
    "hour_sin",
    "hour_cos",
    "dow",
    "is_eth",
]

WARMUP = 289
BAR_S = 300
HORIZON_1H_BARS = 12
HORIZON_4H_BARS = 48


def rolling_std(x: np.ndarray, window: int) -> np.ndarray:
    return pd.Series(x).rolling(window, min_periods=window).std(ddof=0).to_numpy()


def rolling_mean(x: np.ndarray, window: int) -> np.ndarray:
    return pd.Series(x).rolling(window, min_periods=window).mean().to_numpy()


def make_features(df: pd.DataFrame, is_eth: float) -> pd.DataFrame:
    o = df["open"].to_numpy(dtype=np.float64)
    h = df["high"].to_numpy(dtype=np.float64)
    low = df["low"].to_numpy(dtype=np.float64)
    c = df["close"].to_numpy(dtype=np.float64)
    v = df["volume"].to_numpy(dtype=np.float64)

    logc = np.log(np.clip(c, 1e-12, None))
    ret_1 = np.empty_like(logc)
    ret_1[0] = np.nan
    ret_1[1:] = logc[1:] - logc[:-1]

    feat = pd.DataFrame(index=df.index)
    for k in (3, 12, 48, 144, 288):
        col = np.full_like(logc, np.nan)
        col[k:] = logc[k:] - logc[:-k]
        feat[f"ret_{k}"] = col

    feat["rv_12"] = rolling_std(ret_1, 12)
    feat["rv_48"] = rolling_std(ret_1, 48)
    feat["rv_144"] = rolling_std(ret_1, 144)
    feat["rv_288"] = rolling_std(ret_1, 288)

    rng = np.maximum(h - low, 1e-12)
    body = np.abs(c - o)
    upper = h - np.maximum(o, c)
    lower = np.minimum(o, c) - low
    feat["body_ratio"] = body / rng
    feat["upper_wick"] = upper / rng
    feat["lower_wick"] = lower / rng
    feat["log_hl"] = np.log(np.maximum(h, 1e-12) / np.maximum(low, 1e-12))
    feat["close_loc"] = (c - low) / rng

    vmean48 = rolling_mean(v, 48)
    vstd48 = np.maximum(rolling_std(v, 48), 1e-12)
    vmean288 = rolling_mean(v, 288)
    vstd288 = np.maximum(rolling_std(v, 288), 1e-12)
    feat["vol_z_48"] = (v - vmean48) / vstd48
    feat["vol_z_288"] = (v - vmean288) / vstd288
    feat["log_vol"] = np.log(v + 1e-12)
    vmean12 = rolling_mean(v, 12)
    feat["vol_shock_12"] = v / np.maximum(vmean12, 1e-12)
    rmean = rolling_mean(rng, 48)
    rstd = np.maximum(rolling_std(rng, 48), 1e-12)
    feat["range_z_48"] = (rng - rmean) / rstd

    dt = pd.to_datetime(df["open_time"], unit="ms", utc=True)
    hour = dt.dt.hour.to_numpy(dtype=np.float64)
    feat["hour_sin"] = np.sin(2 * np.pi * hour / 24.0)
    feat["hour_cos"] = np.cos(2 * np.pi * hour / 24.0)
    feat["dow"] = dt.dt.dayofweek.to_numpy(dtype=np.float64)
    feat["is_eth"] = is_eth
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


def vol_proxy_bps(X: np.ndarray, horizon_bars: int) -> np.ndarray:
    rv12 = X[:, FEATURES.index("rv_12")]
    rv48 = X[:, FEATURES.index("rv_48")]
    return np.maximum(rv12, rv48) * math.sqrt(max(horizon_bars, 1)) * 1e4


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


def move_cap(horizon_bars: int) -> float:
    return 1000.0 if horizon_bars >= 24 else 400.0


def predict_abs_move(p: np.ndarray, X: np.ndarray, calib: dict, horizon_bars: int) -> np.ndarray:
    conf = np.abs(p - 0.5)
    vol = vol_proxy_bps(X, horizon_bars)
    lin = (
        float(calib.get("abs_intercept") or 0.0)
        + float(calib.get("abs_beta_conf") or 0.0) * conf
        + float(calib.get("abs_beta_vol") or 0.0) * vol
    )
    lin = np.maximum(lin, 0.05)
    bin_e = lookup_bins(conf, calib.get("abs_bins") or [], float(calib.get("mean_abs_bps") or 1.0))
    typical = np.maximum(float(calib.get("mean_abs_bps") or 0.5), 0.5) * (
        0.45 + 0.55 * np.clip(conf / 0.5, 0, 1)
    )
    blended = 0.40 * lin + 0.35 * bin_e + 0.25 * typical
    return np.clip(blended, 0.05, move_cap(horizon_bars))


def gate_mask(p: np.ndarray, tau: float) -> np.ndarray:
    return (p >= tau) | (p <= (1.0 - tau))


def brier_score(p: np.ndarray, y: np.ndarray) -> float:
    ok = np.isfinite(p) & np.isfinite(y)
    if not ok.any():
        return float("nan")
    return float(np.mean((p[ok] - y[ok]) ** 2))


def logloss_score(p: np.ndarray, y: np.ndarray) -> float:
    ok = np.isfinite(p) & np.isfinite(y)
    if not ok.any():
        return float("nan")
    pp = np.clip(p[ok], 1e-6, 1 - 1e-6)
    yy = y[ok]
    return float(-np.mean(yy * np.log(pp) + (1 - yy) * np.log(1 - pp)))


def eval_gate(
    y: np.ndarray,
    p: np.ndarray,
    bps: np.ndarray,
    tau: float,
) -> dict:
    gated = gate_mask(p, tau)
    n = int(gated.sum())
    empty = {
        "tau": float(tau),
        "gated_acc": None,
        "n": 0,
        "coverage": 0.0,
        "mean_abs_move_bps": None,
        "mean_signed_bps": None,
        "expectancy_10bp": None,
        "expectancy_120bp": None,
        "brier": brier_score(p, y),
        "logloss": logloss_score(p, y),
    }
    if n == 0 or len(y) == 0:
        return empty
    pred = (p >= 0.5).astype(np.int32)
    acc = float((pred[gated] == y[gated]).mean())
    pred_sign = np.where(p >= 0.5, 1.0, -1.0)
    signed = pred_sign[gated] * bps[gated]
    mean_signed = float(np.nanmean(signed))
    return {
        "tau": float(tau),
        "gated_acc": acc,
        "n": n,
        "coverage": float(n / len(y)),
        "mean_abs_move_bps": float(np.nanmean(np.abs(bps[gated]))),
        "mean_signed_bps": mean_signed,
        "expectancy_10bp": mean_signed - 10.0,
        "expectancy_120bp": mean_signed - 120.0,
        "brier": brier_score(p, y),
        "logloss": logloss_score(p, y),
        "brier_gated": brier_score(p[gated], y[gated]),
        "logloss_gated": logloss_score(p[gated], y[gated]),
    }


def pick_tau(y: np.ndarray, p: np.ndarray, bps: np.ndarray) -> tuple[float, dict]:
    """Tune τ on VAL for E after 10 bp, not headline accuracy."""
    taus = [0.52, 0.54, 0.56, 0.58, 0.60, 0.62, 0.64, 0.66, 0.68]
    cands: list[dict] = []
    n_min = max(80, int(0.03 * len(y)))
    for tau in taus:
        st = eval_gate(y, p, bps, float(tau))
        if st["n"] < n_min:
            continue
        if st["expectancy_10bp"] is None:
            continue
        cands.append(st)
    if not cands:
        st = eval_gate(y, p, bps, 0.58)
        return 0.58, st

    def score(st: dict) -> tuple:
        e10 = float(st["expectancy_10bp"])
        cov = float(st["coverage"])
        return (e10 + 0.05 * min(cov, 0.25), e10, cov)

    ranked = sorted(cands, key=score, reverse=True)
    return float(ranked[0]["tau"]), ranked[0]


def fit_move_calib(p: np.ndarray, bps: np.ndarray, X: np.ndarray, horizon_bars: int) -> dict:
    ok = np.isfinite(p) & np.isfinite(bps)
    abs_y = np.abs(bps)
    conf = np.abs(p - 0.5)
    vol = vol_proxy_bps(X, horizon_bars)
    mean_abs = float(np.nanmean(abs_y[ok])) if ok.any() else 1.0
    if int(ok.sum()) < 80 or float(np.var(p[ok] - 0.5)) < 1e-12:
        return {
            "abs_intercept": mean_abs,
            "abs_beta_conf": 0.0,
            "abs_beta_vol": 1.0,
            "mean_abs_bps": mean_abs,
            "abs_bins": [],
        }
    A = np.column_stack([np.ones(ok.sum()), conf[ok], vol[ok]])
    coef, _, _, _ = np.linalg.lstsq(A, abs_y[ok], rcond=None)
    bins: list[dict] = []
    edges = np.linspace(0.0, 0.5, 11)
    for i in range(len(edges) - 1):
        hi = edges[i + 1]
        m = ok & (conf >= edges[i]) & (conf < hi if i < len(edges) - 2 else conf <= hi)
        if int(m.sum()) < 40:
            continue
        bins.append({"lo": float(edges[i]), "hi": float(hi), "mean_abs": float(np.mean(abs_y[m]))})
    return {
        "abs_intercept": float(coef[0]),
        "abs_beta_conf": float(coef[1]),
        "abs_beta_vol": float(coef[2]),
        "mean_abs_bps": mean_abs,
        "abs_bins": bins,
    }


def fit_p_calib(p: np.ndarray, y: np.ndarray) -> list[dict]:
    ok = np.isfinite(p) & np.isfinite(y)
    bins: list[dict] = []
    edges = np.linspace(0.0, 1.0, 11)
    for i in range(len(edges) - 1):
        lo, hi = float(edges[i]), float(edges[i + 1])
        m = ok & (p >= lo) & (p < hi if i < len(edges) - 2 else p <= hi)
        n = int(m.sum())
        if n < 40:
            continue
        bins.append({"lo": lo, "hi": hi, "mean_y": float(y[m].mean()), "n": n})
    return bins


def apply_p_calib(p: np.ndarray, bins: list[dict]) -> np.ndarray:
    out = np.clip(p, 0.05, 0.95)
    if not bins:
        return out
    cal = out.copy()
    for b in bins:
        m = (out >= b["lo"]) & (out < b["hi"])
        emp = min(0.92, max(0.08, float(b["mean_y"])))
        cal[m] = 0.65 * emp + 0.35 * out[m]
    last = bins[-1]
    m_hi = out >= last["hi"]
    emp = min(0.92, max(0.08, float(last["mean_y"])))
    cal[m_hi] = 0.65 * emp + 0.35 * out[m_hi]
    return np.clip(cal, 0.05, 0.92)


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


def load_product(path: Path, is_eth: float) -> tuple[pd.DataFrame, pd.DataFrame]:
    df = pd.read_csv(path, compression="gzip")
    for c in ["open_time", "open", "high", "low", "close", "volume"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df = df.dropna(subset=["close"]).sort_values("open_time").drop_duplicates("open_time")
    df = df.reset_index(drop=True)
    feat = make_features(df, is_eth)
    return df, feat


def naive_from_ret(X: np.ndarray, horizon_bars: int) -> np.ndarray:
    key = "ret_12" if horizon_bars <= 12 else "ret_48"
    ret = X[:, FEATURES.index(key)]
    return (ret > 0).astype(np.int32)


def train_lgbm(X_tr, y_tr, X_va, y_va) -> lgb.Booster:
    dtrain = lgb.Dataset(X_tr, y_tr, feature_name=FEATURES, free_raw_data=False)
    dval = lgb.Dataset(X_va, y_va, feature_name=FEATURES, reference=dtrain, free_raw_data=False)
    params = {
        "objective": "binary",
        "metric": ["auc", "binary_logloss"],
        "learning_rate": 0.03,
        "num_leaves": 31,
        "max_depth": 6,
        "min_child_samples": 160,
        "subsample": 0.8,
        "subsample_freq": 1,
        "colsample_bytree": 0.8,
        "reg_lambda": 2.5,
        "reg_alpha": 0.3,
        "min_gain_to_split": 0.01,
        "verbose": -1,
        "seed": 42,
    }
    booster = lgb.train(
        params,
        dtrain,
        num_boost_round=400,
        valid_sets=[dtrain, dval],
        valid_names=["train", "val"],
        callbacks=[lgb.early_stopping(40, verbose=False), lgb.log_evaluation(80)],
    )
    return booster


def walk_forward_report(X, y, bps, n_test_start: int, horizon_bars: int) -> list[dict]:
    """Expanding folds on the non-TEST prefix."""
    n = n_test_start
    folds = []
    cuts = [(0.50, 0.62), (0.62, 0.74), (0.74, 0.86), (0.86, 1.00)]
    for i, (a, b) in enumerate(cuts):
        i_tr = max(int(n * a) - 1, WARMUP)
        i_va0 = i_tr
        i_va1 = min(int(n * b), n)
        if i_va1 - i_va0 < 200 or i_tr < 400:
            continue
        booster = train_lgbm(X[:i_tr], y[:i_tr], X[i_va0:i_va1], y[i_va0:i_va1])
        p = booster.predict(X[i_va0:i_va1], num_iteration=booster.best_iteration or 0)
        naive = naive_from_ret(X[i_va0:i_va1], horizon_bars)
        yy = y[i_va0:i_va1]
        pred = (p >= 0.5).astype(np.int32)
        folds.append({
            "fold": i + 1,
            "n": int(len(yy)),
            "flat_acc": float((pred == yy).mean()),
            "naive_acc": float((naive == yy).mean()),
            "brier": brier_score(p, yy),
            "logloss": logloss_score(p, yy),
        })
        print(
            f"  WF fold {i+1}: n={len(yy)} acc={folds[-1]['flat_acc']:.4f} "
            f"naive={folds[-1]['naive_acc']:.4f} brier={folds[-1]['brier']:.4f}",
            flush=True,
        )
    return folds


def train_head(
    name: str,
    X: np.ndarray,
    y: np.ndarray,
    bps: np.ndarray,
    is_eth: np.ndarray,
    t: np.ndarray,
    horizon_bars: int,
) -> dict:
    n = len(y)
    i_te = int(n * 0.85)
    i_tr = int(i_te * 0.80)
    print(f"{name}: n={n:,} up={y.mean():.3f} tr={i_tr} va={i_te - i_tr} te={n - i_te}", flush=True)
    print(f"Walk-forward on prefix n={i_te}…", flush=True)
    wf = walk_forward_report(X, y, bps, i_te, horizon_bars)

    booster = train_lgbm(X[:i_tr], y[:i_tr], X[i_tr:i_te], y[i_tr:i_te])
    p_va_raw = booster.predict(X[i_tr:i_te], num_iteration=booster.best_iteration or 0)
    p_te_raw = booster.predict(X[i_te:], num_iteration=booster.best_iteration or 0)
    p_bins = fit_p_calib(p_va_raw, y[i_tr:i_te])
    p_va = apply_p_calib(p_va_raw, p_bins)
    p_te = apply_p_calib(p_te_raw, p_bins)
    calib = fit_move_calib(p_va, bps[i_tr:i_te], X[i_tr:i_te], horizon_bars)
    tau, val_st = pick_tau(y[i_tr:i_te], p_va, bps[i_tr:i_te])
    test_st = eval_gate(y[i_te:], p_te, bps[i_te:], tau)
    naive_pred = naive_from_ret(X[i_te:], horizon_bars)
    naive_last_acc = float((naive_pred == y[i_te:]).mean())
    gated = gate_mask(p_te, tau)
    naive_gated = float((naive_pred[gated] == y[i_te:][gated]).mean()) if gated.any() else None
    test_st["naive_last_acc"] = naive_last_acc
    test_st["naive_gated_acc"] = naive_gated
    pred_all = (p_te >= 0.5).astype(np.int32)
    test_st["flat_acc"] = float((pred_all == y[i_te:]).mean())
    test_st["beats_naive_flat"] = bool(test_st["flat_acc"] > naive_last_acc + 1e-12)
    test_st["beats_naive_gated"] = bool(
        test_st["gated_acc"] is not None and naive_gated is not None and test_st["gated_acc"] > naive_gated + 1e-12
    )

    by_sym = {}
    for label, mask in (("BTC-USD", is_eth[i_te:] < 0.5), ("ETH-USD", is_eth[i_te:] >= 0.5)):
        if int(mask.sum()) < 80:
            continue
        st = eval_gate(y[i_te:][mask], p_te[mask], bps[i_te:][mask], tau)
        nv = naive_from_ret(X[i_te:][mask], horizon_bars)
        st["naive_last_acc"] = float((nv == y[i_te:][mask]).mean())
        st["flat_acc"] = float(((p_te[mask] >= 0.5).astype(np.int32) == y[i_te:][mask]).mean())
        st["beats_naive_flat"] = bool(st["flat_acc"] > st["naive_last_acc"] + 1e-12)
        by_sym[label] = st
    test_st["by_symbol"] = by_sym

    compact = compact_dump(booster)
    sanity = verify_dump(compact, X[i_te:], p_te_raw)
    gain = booster.feature_importance(importance_type="gain")
    importance = [{"name": FEATURES[i], "gain": float(gain[i])} for i in np.argsort(-gain)]
    print(
        f"TEST {name} tau={tau:.3f} acc={test_st['gated_acc']} n={test_st['n']} "
        f"cov={test_st['coverage']:.3f} naive={naive_last_acc:.4f} flat={test_st['flat_acc']:.4f} "
        f"|move|={test_st['mean_abs_move_bps']} E10={test_st['expectancy_10bp']} E120={test_st['expectancy_120bp']}",
        flush=True,
    )
    t0 = datetime.fromtimestamp(int(t[0]) / 1000, tz=timezone.utc).isoformat()
    t1 = datetime.fromtimestamp(int(t[-1]) / 1000, tz=timezone.utc).isoformat()
    return {
        "name": name,
        "compact": compact,
        "tau": float(tau),
        "min_move_bps": 0.0,
        "default_min_edge_bps": 0.0,
        "val": val_st,
        "test": test_st,
        "walk_forward": wf,
        "sanity": sanity,
        "importance": importance,
        "calib": calib,
        "p_calib": p_bins,
        "horizon_s": horizon_bars * BAR_S,
        "horizon_bars": horizon_bars,
        "best_iteration": int(booster.best_iteration),
        "train_span": {"t0": t0, "t1": t1, "n": n},
    }


def stack_head(frames, horizon_bars: int):
    Xs, ys, bpss, eths, times = [], [], [], [], []
    for product, df, feat in frames:
        close = df["close"].to_numpy(dtype=np.float64)
        y = make_label(close, horizon_bars)
        bps = fwd_bps(close, horizon_bars)
        valid = feat.notna().all(axis=1) & pd.notna(y) & pd.notna(bps)
        valid.iloc[:WARMUP] = False
        Xs.append(feat.loc[valid, FEATURES].to_numpy(dtype=np.float64))
        ys.append(y[valid.to_numpy()].astype(np.int32))
        bpss.append(bps[valid.to_numpy()])
        eths.append(feat.loc[valid, "is_eth"].to_numpy(dtype=np.float64))
        times.append(df.loc[valid, "open_time"].to_numpy(dtype=np.int64))
    X = np.concatenate(Xs)
    y = np.concatenate(ys)
    bps = np.concatenate(bpss)
    is_eth = np.concatenate(eths)
    t = np.concatenate(times)
    order = np.argsort(t)
    return X[order], y[order], bps[order], is_eth[order], t[order]


def write_json(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj))


def main() -> int:
    days = int(sys.argv[1]) if len(sys.argv) > 1 else 150
    print(f"Coinbase 5m 1h/4h train days={days}", flush=True)
    paths = fetch_5m(days)
    frames = []
    for product, path in paths.items():
        is_eth = 1.0 if product.startswith("ETH") else 0.0
        df, feat = load_product(path, is_eth)
        frames.append((product, df, feat))
        print(f"  {product} bars={len(df):,}", flush=True)

    heads = []
    for name, h_bars in (("h1h", HORIZON_1H_BARS), ("h4h", HORIZON_4H_BARS)):
        X, y, bps, is_eth, t = stack_head(frames, h_bars)
        head = train_head(name, X, y, bps, is_eth, t, h_bars)
        heads.append(head)

    MODELS.mkdir(parents=True, exist_ok=True)
    FN_MODELS.mkdir(parents=True, exist_ok=True)
    report = {
        "kind": "lgbm_5m",
        "bar_s": BAR_S,
        "venue": "coinbase",
        "features": FEATURES,
        "days": days,
        "heads": {},
    }
    for head in heads:
        name = head["name"]
        meta = {
            "kind": "lgbm",
            "name": name,
            "horizon_s": head["horizon_s"],
            "horizon_bars": head["horizon_bars"],
            "bar_s": BAR_S,
            "symbols": ["BTC-USD", "ETH-USD"],
            "train_archive": "coinbase_exchange_5m_candles",
            "live_venue": "coinbase",
            "tau": head["tau"],
            "min_move_bps": head["min_move_bps"],
            "default_min_edge_bps": head["default_min_edge_bps"],
            "features": FEATURES,
            "test": head["test"],
            "val": head["val"],
            "walk_forward": head["walk_forward"],
            "calib": head["calib"],
            "p_calib": head["p_calib"],
            "sanity": head["sanity"],
            "importance": head["importance"],
            "best_iteration": head["best_iteration"],
            "train_span": head["train_span"],
        }
        write_json(MODELS / f"{name}_lgbm.json", head["compact"])
        write_json(MODELS / f"{name}_meta.json", meta)
        shutil.copy2(MODELS / f"{name}_lgbm.json", FN_MODELS / f"{name}_lgbm.json")
        shutil.copy2(MODELS / f"{name}_meta.json", FN_MODELS / f"{name}_meta.json")
        report["heads"][name] = {
            "tau": head["tau"],
            "test": {
                k: head["test"][k]
                for k in (
                    "gated_acc",
                    "n",
                    "coverage",
                    "naive_last_acc",
                    "flat_acc",
                    "mean_abs_move_bps",
                    "expectancy_10bp",
                    "expectancy_120bp",
                    "brier",
                    "logloss",
                    "beats_naive_flat",
                    "beats_naive_gated",
                    "by_symbol",
                )
                if k in head["test"]
            },
            "walk_forward": head["walk_forward"],
        }
        print(f"wrote {name} → {MODELS}", flush=True)

    write_json(MODELS / "train_report.json", report)
    write_json(FN_MODELS / "train_report.json", report)
    print(json.dumps(report, indent=2)[:4000], flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
