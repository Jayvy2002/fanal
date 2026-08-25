#!/usr/bin/env python3
"""Train leak-free LightGBM on Coinbase Exchange 1-minute candles.

Two heads, one public contract:
  intra  — next completed 1m bar (≈ 60 s)
  slot   — next 5 completed 1m bars (5-minute Up/Down window)

Temporal split only. No shuffle. No Binance. No copied weights.
Live scores the last *completed* 1m bar with the same features.
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
from fetch_coinbase_1m import main as fetch_1m

MODELS = ROOT / "models" / "predictor"
FN_MODELS = ROOT / "netlify" / "functions" / "lib" / "predictor" / "_models"

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
    "body_ratio",
    "upper_wick",
    "lower_wick",
    "log_hl",
    "close_loc",
    "vol_z_30",
    "vol_z_60",
    "log_vol",
    "vol_shock_5",
    "range_z_30",
    "is_eth",
]

WARMUP = 61
HORIZON_INTRA_BARS = 1
HORIZON_SLOT_BARS = 5
BAR_S = 60


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
    for k in (1, 3, 5, 15, 30, 60):
        col = np.full_like(logc, np.nan)
        col[k:] = logc[k:] - logc[:-k]
        feat[f"ret_{k}"] = col

    feat["rv_5"] = rolling_std(ret_1, 5)
    feat["rv_15"] = rolling_std(ret_1, 15)
    feat["rv_30"] = rolling_std(ret_1, 30)
    feat["rv_60"] = rolling_std(ret_1, 60)

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
    rmean = rolling_mean(rng, 30)
    rstd = np.maximum(rolling_std(rng, 30), 1e-12)
    feat["range_z_30"] = (rng - rmean) / rstd
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
    rv5 = X[:, FEATURES.index("rv_5")]
    rv60 = X[:, FEATURES.index("rv_60")]
    return np.maximum(rv5, rv60) * math.sqrt(max(horizon_bars, 1)) * 1e4


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
    cap = 80.0 if horizon_bars >= 5 else 40.0
    blended = 0.40 * lin + 0.35 * bin_e + 0.25 * typical
    return np.clip(blended, 0.05, cap)


def gate_mask(p: np.ndarray, e_abs: np.ndarray, tau: float, min_move: float) -> np.ndarray:
    return ((p >= tau) | (p <= (1.0 - tau))) & (e_abs >= min_move)


def eval_gate(
    y: np.ndarray,
    p: np.ndarray,
    bps: np.ndarray,
    e_abs: np.ndarray,
    tau: float,
    min_move: float,
) -> dict:
    gated = gate_mask(p, e_abs, tau, min_move)
    n = int(gated.sum())
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
        "min_move_bps": float(min_move),
        "gated_acc": acc,
        "n": n,
        "coverage": float(n / len(y)),
        "mean_abs_move_bps": float(np.nanmean(np.abs(bps[gated]))),
        "mean_signed_bps": mean_signed,
        "expectancy_1bp": mean_signed - 1.0,
        "expectancy_2bp": mean_signed - 2.0,
    }


def pick_gate(
    y: np.ndarray,
    p: np.ndarray,
    bps: np.ndarray,
    e_abs: np.ndarray,
    default_move: float,
) -> tuple[float, float, dict]:
    taus = [0.54, 0.56, 0.58, 0.60, 0.62, 0.64]
    moves = sorted({default_move, 3.0, 4.0, 5.0, 6.0, 8.0, 10.0, 12.0, 15.0})
    cands: list[dict] = []
    for tau in taus:
        for mv in moves:
            st = eval_gate(y, p, bps, e_abs, float(tau), float(mv))
            if st["n"] < 80 or st["coverage"] < 0.01:
                continue
            if st["expectancy_1bp"] is None:
                continue
            cands.append(st)
    if not cands:
        st = eval_gate(y, p, bps, e_abs, 0.58, default_move)
        return 0.58, default_move, st

    def score(st: dict) -> tuple:
        e1 = float(st["expectancy_1bp"])
        cov = float(st["coverage"])
        return (e1 + 0.02 * min(cov, 0.15), e1, cov)

    ranked = sorted(cands, key=score, reverse=True)
    return float(ranked[0]["tau"]), float(ranked[0]["min_move_bps"]), ranked[0]


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
    """Empirical frequency bins — confidence is never a fake 99%."""
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


def train_head(
    name: str,
    X_tr: np.ndarray,
    y_tr: np.ndarray,
    X_va: np.ndarray,
    y_va: np.ndarray,
    X_te: np.ndarray,
    y_te: np.ndarray,
    bps_va: np.ndarray,
    bps_te: np.ndarray,
    horizon_bars: int,
    default_move: float,
    te_is_eth: np.ndarray,
) -> dict:
    dtrain = lgb.Dataset(X_tr, y_tr, feature_name=FEATURES, free_raw_data=False)
    dval = lgb.Dataset(X_va, y_va, feature_name=FEATURES, reference=dtrain, free_raw_data=False)
    params = {
        "objective": "binary",
        "metric": ["auc", "binary_logloss"],
        "learning_rate": 0.04,
        "num_leaves": 24,
        "max_depth": 5,
        "min_child_samples": 200,
        "subsample": 0.8,
        "subsample_freq": 1,
        "colsample_bytree": 0.8,
        "reg_lambda": 2.0,
        "reg_alpha": 0.2,
        "min_gain_to_split": 0.01,
        "verbose": -1,
        "seed": 42,
    }
    print(f"Training {name} horizon={horizon_bars * BAR_S}s …", flush=True)
    # Intra 1m is barely above chance: keep a small fixed forest so the scorer
    # is a real function (not a 1-tree stub) and let TEST speak.
    rounds = 80 if name == "intra" else 350
    cbs = [lgb.log_evaluation(50)]
    if name != "intra":
        cbs.insert(0, lgb.early_stopping(40, verbose=True))
    booster = lgb.train(
        params,
        dtrain,
        num_boost_round=rounds,
        valid_sets=[dtrain, dval],
        valid_names=["train", "val"],
        callbacks=cbs,
    )
    p_va = booster.predict(X_va, num_iteration=booster.best_iteration or 0)
    p_te = booster.predict(X_te, num_iteration=booster.best_iteration or 0)
    calib = fit_move_calib(p_va, bps_va, X_va, horizon_bars)
    e_va = predict_abs_move(p_va, X_va, calib, horizon_bars)
    e_te = predict_abs_move(p_te, X_te, calib, horizon_bars)
    tau, min_move, val_st = pick_gate(y_va, p_va, bps_va, e_va, default_move)
    calib["min_move_bps"] = float(min_move)
    test_st = eval_gate(y_te, p_te, bps_te, e_te, tau, min_move)
    ret1 = X_te[:, FEATURES.index("ret_1")]
    naive_pred = (ret1 > 0).astype(np.int32)
    naive_last_acc = float((naive_pred == y_te).mean())
    test_st["naive_last_acc"] = naive_last_acc
    pred_all = (p_te >= 0.5).astype(np.int32)
    test_st["flat_acc"] = float((pred_all == y_te).mean())
    ungated = eval_gate(y_te, p_te, bps_te, e_te, tau, 0.0)
    ungated["naive_last_acc"] = naive_last_acc
    test_st["ungated_tau_only"] = {
        "gated_acc": ungated["gated_acc"],
        "n": ungated["n"],
        "coverage": ungated["coverage"],
        "mean_abs_move_bps": ungated["mean_abs_move_bps"],
        "expectancy_1bp": ungated["expectancy_1bp"],
    }
    # Per-symbol TEST (honest).
    by_sym = {}
    for label, mask in (("BTC-USD", te_is_eth < 0.5), ("ETH-USD", te_is_eth >= 0.5)):
        if int(mask.sum()) < 50:
            continue
        st = eval_gate(y_te[mask], p_te[mask], bps_te[mask], e_te[mask], tau, min_move)
        st["naive_last_acc"] = float((naive_pred[mask] == y_te[mask]).mean())
        by_sym[label] = st
    test_st["by_symbol"] = by_sym

    p_bins = fit_p_calib(p_va, y_va)
    compact = compact_dump(booster)
    sanity = verify_dump(compact, X_te, p_te)
    gain = booster.feature_importance(importance_type="gain")
    importance = [{"name": FEATURES[i], "gain": float(gain[i])} for i in np.argsort(-gain)]
    print(
        f"TEST {name} tau={tau:.3f} min={min_move:.2f}bp "
        f"acc={test_st['gated_acc']} n={test_st['n']} cov={test_st['coverage']:.3f} "
        f"naive={naive_last_acc:.4f} |move|={test_st['mean_abs_move_bps']}",
        flush=True,
    )
    return {
        "name": name,
        "compact": compact,
        "tau": float(tau),
        "min_move_bps": float(min_move),
        "default_min_edge_bps": float(max(min_move, default_move)),
        "val": val_st,
        "test": test_st,
        "sanity": sanity,
        "importance": importance,
        "calib": calib,
        "p_calib": p_bins,
        "horizon_s": horizon_bars * BAR_S,
        "horizon_bars": horizon_bars,
        "best_iteration": int(booster.best_iteration),
    }


def load_frame(paths: dict[str, Path]) -> tuple[np.ndarray, dict[int, dict]]:
    frames = []
    for product, path in paths.items():
        is_eth = 1.0 if product.startswith("ETH") else 0.0
        df, feat = load_product(path, is_eth)
        frames.append((product, df, feat))
        print(f"  {product} bars={len(df):,}", flush=True)
    return frames


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
    days = int(sys.argv[1]) if len(sys.argv) > 1 else 60
    print(f"Coinbase 1m predictor train days={days}", flush=True)
    paths = fetch_1m(days)
    frames = load_frame(paths)

    heads = []
    for name, h_bars, default_move in (
        ("intra", HORIZON_INTRA_BARS, 4.0),
        ("slot", HORIZON_SLOT_BARS, 10.0),
    ):
        X, y, bps, is_eth, t = stack_head(frames, h_bars)
        n = len(y)
        i_tr = int(n * 0.70)
        i_va = int(n * 0.85)
        print(f"{name}: n={n:,} up={y.mean():.3f} split {i_tr}/{i_va}/{n}", flush=True)
        head = train_head(
            name,
            X[:i_tr],
            y[:i_tr],
            X[i_tr:i_va],
            y[i_tr:i_va],
            X[i_va:],
            y[i_va:],
            bps[i_tr:i_va],
            bps[i_va:],
            h_bars,
            default_move,
            is_eth[i_va:],
        )
        t0 = datetime.fromtimestamp(int(t[0]) / 1000, tz=timezone.utc).isoformat()
        t1 = datetime.fromtimestamp(int(t[-1]) / 1000, tz=timezone.utc).isoformat()
        head["train_span"] = {"t0": t0, "t1": t1, "n": n, "days": days}
        heads.append(head)

    MODELS.mkdir(parents=True, exist_ok=True)
    FN_MODELS.mkdir(parents=True, exist_ok=True)
    report = {"kind": "lgbm_1m", "bar_s": BAR_S, "venue": "coinbase", "features": FEATURES, "heads": {}}
    for head in heads:
        name = head["name"]
        meta = {
            "kind": "lgbm",
            "name": name,
            "horizon_s": head["horizon_s"],
            "horizon_bars": head["horizon_bars"],
            "bar_s": BAR_S,
            "symbols": ["BTC-USD", "ETH-USD"],
            "train_archive": "coinbase_exchange_1m_candles",
            "live_venue": "coinbase",
            "tau": head["tau"],
            "min_move_bps": head["min_move_bps"],
            "default_min_edge_bps": head["default_min_edge_bps"],
            "features": FEATURES,
            "test": head["test"],
            "val": head["val"],
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
            "min_move_bps": head["min_move_bps"],
            "test": head["test"],
        }
        print(f"wrote {name} → {MODELS}", flush=True)

    write_json(MODELS / "train_report.json", report)
    write_json(FN_MODELS / "train_report.json", report)
    print(json.dumps(report, indent=2)[:2000], flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
