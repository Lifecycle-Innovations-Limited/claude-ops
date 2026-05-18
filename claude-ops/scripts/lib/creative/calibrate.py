#!/usr/bin/env python3
"""
calibrate.py — Tier 3 self-learning calibrator: fits score→CPL mapping.

CLI:
  python3 calibrate.py --project P --data-dir /path/to/data [--channel meta]
  python3 calibrate.py --predict 75.0 --calibrator /path/to/calibrator.json

Input files (joined by ad_id):
  <data-dir>/autopilot_state/<P>/creatives.jsonl
    Row: {"ts","project","channel","asset_path","asset_type","gen_params",
           "tier0":{...},"tier1":{...},"tier2":{"verdict","prior"},"deploy_ts",
           "ad_id":null|"<id>"}
  <data-dir>/autopilot_state/<P>/kpi.jsonl
    Row: {"ts","project","ad_id","spend","impressions","ctr","cpl"}

Model selection:
  - Need ≥ 5 joined points (creatives with non-null ad_id matched to kpi rows).
  - If fewer: write calibrator.json with model="insufficient_data" and exit 0.
  - ≥ 10 points → isotonic regression (PAVA).
  - < 10 points → ridge regression (closed-form, 1 feature).

Monotonicity direction:
  Higher prior (quality score) should predict LOWER CPL.
  Isotonic PAVA is applied on NEGATED CPL targets (i.e., -CPL is monotone
  non-decreasing with score). This gives a monotone NON-INCREASING prior→CPL
  mapping after negation, which is the correct economic direction.
  Ridge: predicted_cpl = a*score + b where a should be negative (verified).

Output calibrator.json:
  {"fitted_at": ISO, "project": P, "channel": C, "model": "isotonic|ridge|insufficient_data",
   "points": N, "mapping": [{"score": S, "predicted_cpl": C}, ...sorted asc by score],
   "coef": a, "intercept": b}

predict_cpl(calibrator, score):
  - isotonic: linear interpolation within mapping (clamp outside range).
  - ridge: a*score + b.

python3 calibrate.py --predict <score> --calibrator <path>
  Prints the predicted CPL as a float, for bash callers.

stdlib only — no numpy/scipy/sklearn/pandas.
"""

import argparse
import json
import math
import os
import sys
from datetime import datetime, timezone


# ── PAVA — Pool-Adjacent-Violators Algorithm (isotonic regression) ───────────
# Fits a monotone NON-DECREASING sequence.
# We pass NEGATED CPL as targets so the resulting mapping is
# monotone NON-INCREASING in CPL with respect to score.
# See module docstring for monotonicity direction rationale.
def pava_non_decreasing(scores_sorted, targets_sorted):
    """
    Fits isotonic regression (non-decreasing) on paired (scores, targets).
    scores_sorted and targets_sorted must already be sorted by score ascending.
    Returns list of (score, fitted_value) pairs.
    """
    n = len(targets_sorted)
    if n == 0:
        return []

    # Build blocks of (sum, count, score_values) using PAVA
    # Each block holds a constant fitted value = mean of targets in block.
    blocks = []  # list of [target_sum, count, [scores]]
    for i in range(n):
        block = [targets_sorted[i], 1, [scores_sorted[i]]]
        blocks.append(block)
        # Pool-adjacent-violators: merge while current block < previous block
        while len(blocks) >= 2 and blocks[-1][0] / blocks[-1][1] < blocks[-2][0] / blocks[-2][1]:
            prev = blocks.pop()
            cur = blocks[-1]
            cur[0] += prev[0]
            cur[1] += prev[1]
            cur[2] += prev[2]

    # Expand blocks back to per-point fitted values
    result = []
    for block in blocks:
        fitted_val = block[0] / block[1]
        for s in block[2]:
            result.append((s, fitted_val))

    # Sort by score (blocks may have multiple scores mixed due to merging)
    result.sort(key=lambda x: x[0])
    return result


def fit_isotonic(scores, cpls):
    """
    Fit monotone NON-INCREASING prior→CPL mapping via PAVA on negated CPL.
    Returns list of {"score": S, "predicted_cpl": C} sorted ascending by score.
    """
    # Sort by score ascending
    pairs = sorted(zip(scores, cpls), key=lambda x: x[0])
    sorted_scores = [p[0] for p in pairs]
    # Negate CPL so PAVA (non-decreasing) gives non-increasing CPL w.r.t. score
    neg_cpls = [-p[1] for p in pairs]

    fitted = pava_non_decreasing(sorted_scores, neg_cpls)

    # Un-negate: fitted_val is -CPL, so predicted_cpl = -fitted_val
    mapping = []
    seen_scores = set()
    for s, neg_c in fitted:
        # Deduplicate scores in mapping (keep last, which is the pooled mean)
        score_key = round(s, 4)
        predicted_cpl = round(-neg_c, 4)
        # Update or append
        found = False
        for entry in mapping:
            if abs(entry["score"] - score_key) < 1e-9:
                entry["predicted_cpl"] = predicted_cpl
                found = True
                break
        if not found:
            mapping.append({"score": score_key, "predicted_cpl": predicted_cpl})

    mapping.sort(key=lambda x: x["score"])
    return mapping


def fit_ridge(scores, cpls, alpha=1.0):
    """
    Closed-form ridge regression: predicted_cpl = a*score + b
    with L2 regularization on a (alpha).
    Single feature: X = scores, y = cpls.
    Returns (a, b) where a should be negative (higher score → lower CPL).
    """
    n = len(scores)
    mean_s = sum(scores) / n
    mean_c = sum(cpls) / n

    # Center
    xs = [s - mean_s for s in scores]
    ys = [c - mean_c for c in cpls]

    # Ridge: a = (X'X + alpha*I)^{-1} X'y  (scalar case)
    # X'X = sum(xs^2), X'y = sum(xs*ys)
    xTx = sum(xi ** 2 for xi in xs) + alpha
    xTy = sum(xi * yi for xi, yi in zip(xs, ys))
    a = xTy / xTx if xTx != 0 else 0.0
    b = mean_c - a * mean_s

    return round(a, 6), round(b, 6)


# ── predict_cpl — used by --predict CLI and importers ───────────────────────
def predict_cpl(calibrator, score):
    """
    Interpolate predicted CPL for a given score from calibrator dict.
    - isotonic: linear interpolation within mapping; clamp outside range.
    - ridge: a*score + b.
    - insufficient_data: returns None.
    """
    model = calibrator.get("model", "insufficient_data")
    if model == "insufficient_data":
        return None

    if model == "ridge":
        a = calibrator.get("coef", 0.0)
        b = calibrator.get("intercept", 0.0)
        return round(a * score + b, 4)

    if model == "isotonic":
        mapping = calibrator.get("mapping", [])
        if not mapping:
            return None
        # Clamp at boundaries
        if score <= mapping[0]["score"]:
            return mapping[0]["predicted_cpl"]
        if score >= mapping[-1]["score"]:
            return mapping[-1]["predicted_cpl"]
        # Linear interpolation between bracketing entries
        for i in range(len(mapping) - 1):
            s0, c0 = mapping[i]["score"], mapping[i]["predicted_cpl"]
            s1, c1 = mapping[i + 1]["score"], mapping[i + 1]["predicted_cpl"]
            if s0 <= score <= s1:
                if abs(s1 - s0) < 1e-9:
                    return c0
                t = (score - s0) / (s1 - s0)
                return round(c0 + t * (c1 - c0), 4)

    return None


# ── I/O helpers ──────────────────────────────────────────────────────────────
def read_jsonl(path):
    """Read JSONL file, skipping malformed lines. Returns (rows, skip_count)."""
    rows = []
    skip_count = 0
    if not os.path.exists(path):
        return rows, skip_count
    with open(path, "r", encoding="utf-8") as f:
        for lineno, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                skip_count += 1
    return rows, skip_count


def join_data(creatives, kpis, channel_filter=None):
    """
    Join creatives and kpis by ad_id.
    Returns list of (prior_score, cpl) pairs for joined rows.
    Drops rows with null ad_id or null cpl.
    Applies optional channel filter.
    """
    # Build kpi lookup: ad_id → cpl (take mean if multiple rows per ad_id)
    kpi_by_ad = {}
    for row in kpis:
        ad_id = row.get("ad_id")
        cpl = row.get("cpl")
        if not ad_id or cpl is None:
            continue
        try:
            cpl_f = float(cpl)
        except (TypeError, ValueError):
            continue
        if cpl_f <= 0:
            continue
        if ad_id not in kpi_by_ad:
            kpi_by_ad[ad_id] = []
        kpi_by_ad[ad_id].append(cpl_f)

    # Average CPL per ad_id
    kpi_avg = {k: sum(v) / len(v) for k, v in kpi_by_ad.items()}

    pairs = []
    for row in creatives:
        ad_id = row.get("ad_id")
        if not ad_id:
            continue
        # Channel filter
        if channel_filter:
            row_channel = row.get("channel", "")
            if row_channel and row_channel != channel_filter:
                continue
        # Prior score
        tier2 = row.get("tier2") or {}
        prior = tier2.get("prior")
        if prior is None:
            continue
        try:
            prior_f = float(prior)
        except (TypeError, ValueError):
            continue
        # CPL from kpi join
        cpl = kpi_avg.get(ad_id)
        if cpl is None:
            continue
        pairs.append((prior_f, cpl))

    return pairs


# ── main ─────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Creative CPL calibrator")
    parser.add_argument("--project", help="Project name")
    parser.add_argument("--data-dir", help="OPS_DATA_DIR base path")
    parser.add_argument("--channel", default=None, help="Filter by channel (e.g. meta)")
    parser.add_argument("--predict", type=float, default=None,
                        help="Predict CPL for this score (requires --calibrator)")
    parser.add_argument("--calibrator", default=None,
                        help="Path to calibrator.json for --predict mode")
    args = parser.parse_args()

    # ── Predict mode ─────────────────────────────────────────────────────────
    if args.predict is not None:
        if not args.calibrator:
            print("Error: --predict requires --calibrator", file=sys.stderr)
            sys.exit(1)
        if not os.path.exists(args.calibrator):
            print(f"Error: calibrator not found: {args.calibrator}", file=sys.stderr)
            sys.exit(1)
        with open(args.calibrator, "r", encoding="utf-8") as f:
            cal = json.load(f)
        result = predict_cpl(cal, args.predict)
        if result is None:
            print("null")
        else:
            print(result)
        return

    # ── Fit mode ─────────────────────────────────────────────────────────────
    if not args.project or not args.data_dir:
        print("Error: --project and --data-dir are required for fit mode", file=sys.stderr)
        sys.exit(1)

    state_dir = os.path.join(args.data_dir, "autopilot_state", args.project)
    creatives_path = os.path.join(state_dir, "creatives.jsonl")
    kpi_path = os.path.join(state_dir, "kpi.jsonl")
    out_path = os.path.join(state_dir, "calibrator.json")

    os.makedirs(state_dir, exist_ok=True)

    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    creatives, skip_c = read_jsonl(creatives_path)
    kpis, skip_k = read_jsonl(kpi_path)

    if skip_c > 0 or skip_k > 0:
        print(f"[calibrate] skipped {skip_c} malformed creative rows, {skip_k} kpi rows",
              file=sys.stderr)

    pairs = join_data(creatives, kpis, channel_filter=args.channel)
    n = len(pairs)

    MIN_POINTS = 5
    if n < MIN_POINTS:
        result = {
            "fitted_at": now_iso,
            "project": args.project,
            "channel": args.channel or "all",
            "model": "insufficient_data",
            "points": n,
            "mapping": [],
            "coef": None,
            "intercept": None,
        }
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2)
        print(f"[calibrate] insufficient data ({n}/{MIN_POINTS} min) — wrote placeholder",
              file=sys.stderr)
        sys.exit(0)

    scores = [p[0] for p in pairs]
    cpls = [p[1] for p in pairs]

    ISOTONIC_THRESHOLD = 10

    if n >= ISOTONIC_THRESHOLD:
        # Isotonic regression (PAVA)
        mapping = fit_isotonic(scores, cpls)
        # Compute ridge coef/intercept as supplementary info
        a, b = fit_ridge(scores, cpls)
        model_name = "isotonic"
    else:
        # Ridge (closed-form)
        a, b = fit_ridge(scores, cpls)
        # Build a dense mapping from ridge line for --predict interpolation convenience
        min_s, max_s = min(scores), max(scores)
        step = max((max_s - min_s) / max(n - 1, 1), 1.0)
        map_scores = sorted(set(
            [round(min_s + i * step, 2) for i in range(n)] + scores
        ))
        mapping = [{"score": round(s, 4), "predicted_cpl": round(a * s + b, 4)}
                   for s in map_scores]
        mapping.sort(key=lambda x: x["score"])
        model_name = "ridge"

    result = {
        "fitted_at": now_iso,
        "project": args.project,
        "channel": args.channel or "all",
        "model": model_name,
        "points": n,
        "mapping": mapping,
        "coef": a if n < ISOTONIC_THRESHOLD else a,
        "intercept": b if n < ISOTONIC_THRESHOLD else b,
    }

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)

    print(f"[calibrate] fitted {model_name} on {n} points → {out_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
