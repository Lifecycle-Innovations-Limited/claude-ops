#!/usr/bin/env python3
"""test-autopilot-calibrate.py — unit tests for scripts/lib/creative/calibrate.py

Covers:
  - Monotone isotonic case (12 pts) — model/points/sorted mapping/monotone
    non-increasing predict + --predict CLI interpolation.
  - Ridge case (7 pts) — model/coef/intercept present, finite predictions.
  - Insufficient case (3 pts) — model=insufficient_data, exit 0, mapping [].
  - Malformed JSONL robustness — garbage + null ad_id rows skipped, valid fit.
  - Determinism — two fits produce identical mapping/coef.

stdlib only. Invokes calibrate.py via subprocess.
"""
import json
import math
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
CALIBRATE = os.path.normpath(
    os.path.join(HERE, "..", "scripts", "lib", "creative", "calibrate.py")
)


def write_jsonl(path, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        for r in rows:
            if isinstance(r, str):
                f.write(r + "\n")
            else:
                f.write(json.dumps(r) + "\n")


def run_fit(data_dir, project, channel=None):
    cmd = [sys.executable, CALIBRATE, "--project", project, "--data-dir", data_dir]
    if channel:
        cmd += ["--channel", channel]
    return subprocess.run(cmd, capture_output=True, text=True)


def run_predict(calibrator, score):
    cmd = [
        sys.executable, CALIBRATE,
        "--predict", str(score), "--calibrator", calibrator,
    ]
    return subprocess.run(cmd, capture_output=True, text=True)


def load_cal(data_dir, project):
    p = os.path.join(data_dir, "autopilot_state", project, "calibrator.json")
    with open(p, "r", encoding="utf-8") as f:
        return json.load(f), p


def make_rows(pairs, project="p", channel="meta"):
    """pairs: list of (ad_id, prior, cpl) → (creatives_rows, kpi_rows)."""
    creatives, kpis = [], []
    for ad_id, prior, cpl in pairs:
        creatives.append({
            "ts": "2026-01-01T00:00:00Z", "project": project, "channel": channel,
            "asset_path": f"/tmp/{ad_id}.mp4", "asset_type": "video",
            "gen_params": {}, "tier0": {}, "tier1": {},
            "tier2": {"verdict": "approve", "prior": prior},
            "deploy_ts": "2026-01-01T00:00:00Z", "ad_id": ad_id,
        })
        kpis.append({
            "ts": "2026-01-08T00:00:00Z", "project": project, "ad_id": ad_id,
            "spend": cpl * 10, "impressions": 5000, "ctr": 1.5, "cpl": cpl,
        })
    return creatives, kpis


class TestCalibrate(unittest.TestCase):
    def setUp(self):
        self.assertTrue(os.path.exists(CALIBRATE), f"missing {CALIBRATE}")

    # ── Monotone isotonic (12 pts) ───────────────────────────────────────────
    def test_isotonic_monotone(self):
        with tempfile.TemporaryDirectory() as d:
            proj = "iso"
            # priors 5..60 ascending; cpl 60..5 descending → perfectly monotone
            priors = list(range(5, 61, 5))  # 12 values: 5,10,...,60
            cpls = list(range(60, 4, -5))   # 12 values: 60,55,...,5
            pairs = [(f"AD{i}", float(priors[i]), float(cpls[i]))
                     for i in range(12)]
            cre, kpi = make_rows(pairs)
            sd = os.path.join(d, "autopilot_state", proj)
            write_jsonl(os.path.join(sd, "creatives.jsonl"), cre)
            write_jsonl(os.path.join(sd, "kpi.jsonl"), kpi)

            r = run_fit(d, proj)
            self.assertEqual(r.returncode, 0, r.stderr)
            cal, calp = load_cal(d, proj)

            self.assertEqual(cal["model"], "isotonic", cal)
            self.assertEqual(cal["points"], 12)
            scores = [m["score"] for m in cal["mapping"]]
            self.assertEqual(scores, sorted(scores), "mapping not score-sorted")
            cpls_m = [m["predicted_cpl"] for m in cal["mapping"]]
            for a, b in zip(cpls_m, cpls_m[1:]):
                self.assertLessEqual(b, a + 1e-9,
                                     f"predicted_cpl not non-increasing: {cpls_m}")

            # --predict CLI returns a float, monotone non-increasing
            p_low = run_predict(calp, 10.0)
            p_high = run_predict(calp, 55.0)
            self.assertEqual(p_low.returncode, 0, p_low.stderr)
            self.assertEqual(p_high.returncode, 0, p_high.stderr)
            v_low = float(p_low.stdout.strip())
            v_high = float(p_high.stdout.strip())
            self.assertTrue(math.isfinite(v_low) and math.isfinite(v_high))
            self.assertLess(v_high, v_low,
                            f"predict(high prior)={v_high} !< predict(low)={v_low}")

            # Interpolation between two mapping points lands between their CPLs
            s0, s1 = cal["mapping"][2]["score"], cal["mapping"][3]["score"]
            mid = (s0 + s1) / 2.0
            pm = run_predict(calp, mid)
            self.assertEqual(pm.returncode, 0, pm.stderr)
            vm = float(pm.stdout.strip())
            lo = min(cal["mapping"][2]["predicted_cpl"],
                     cal["mapping"][3]["predicted_cpl"])
            hi = max(cal["mapping"][2]["predicted_cpl"],
                     cal["mapping"][3]["predicted_cpl"])
            self.assertTrue(lo - 1e-6 <= vm <= hi + 1e-6,
                            f"interp {vm} not in [{lo},{hi}]")

    # ── Ridge (7 pts) ────────────────────────────────────────────────────────
    def test_ridge(self):
        with tempfile.TemporaryDirectory() as d:
            proj = "rdg"
            priors = [10, 20, 30, 40, 50, 60, 70]
            cpls = [50, 44, 41, 33, 28, 22, 16]
            pairs = [(f"R{i}", float(priors[i]), float(cpls[i]))
                     for i in range(7)]
            cre, kpi = make_rows(pairs)
            sd = os.path.join(d, "autopilot_state", proj)
            write_jsonl(os.path.join(sd, "creatives.jsonl"), cre)
            write_jsonl(os.path.join(sd, "kpi.jsonl"), kpi)

            r = run_fit(d, proj)
            self.assertEqual(r.returncode, 0, r.stderr)
            cal, calp = load_cal(d, proj)
            self.assertEqual(cal["model"], "ridge", cal)
            self.assertEqual(cal["points"], 7)
            self.assertIsNotNone(cal["coef"])
            self.assertIsNotNone(cal["intercept"])
            self.assertTrue(math.isfinite(float(cal["coef"])))
            self.assertTrue(math.isfinite(float(cal["intercept"])))
            # higher prior → lower CPL ⇒ coef negative
            self.assertLess(float(cal["coef"]), 0.0,
                            f"ridge coef should be negative: {cal['coef']}")
            pr = run_predict(calp, 35.0)
            self.assertEqual(pr.returncode, 0, pr.stderr)
            self.assertTrue(math.isfinite(float(pr.stdout.strip())))

    # ── Insufficient (3 pts) ─────────────────────────────────────────────────
    def test_insufficient(self):
        with tempfile.TemporaryDirectory() as d:
            proj = "ins"
            pairs = [("I1", 10.0, 40.0), ("I2", 20.0, 30.0), ("I3", 30.0, 20.0)]
            cre, kpi = make_rows(pairs)
            sd = os.path.join(d, "autopilot_state", proj)
            write_jsonl(os.path.join(sd, "creatives.jsonl"), cre)
            write_jsonl(os.path.join(sd, "kpi.jsonl"), kpi)

            r = run_fit(d, proj)
            self.assertEqual(r.returncode, 0, "must exit 0, never crash")
            cal, _ = load_cal(d, proj)
            self.assertEqual(cal["model"], "insufficient_data", cal)
            self.assertEqual(cal["points"], 3)
            self.assertEqual(cal["mapping"], [])

    # ── Malformed JSONL robustness ───────────────────────────────────────────
    def test_malformed_robustness(self):
        with tempfile.TemporaryDirectory() as d:
            proj = "mal"
            priors = list(range(5, 61, 5))
            cpls = list(range(60, 4, -5))
            pairs = [(f"M{i}", float(priors[i]), float(cpls[i]))
                     for i in range(12)]
            cre, kpi = make_rows(pairs)
            sd = os.path.join(d, "autopilot_state", proj)
            # Inject 2 garbage lines + 1 null-ad_id row into creatives.
            cre_lines = ([json.dumps(x) for x in cre[:6]]
                         + ["{ this is not json",
                            "garbage,,,line"]
                         + [json.dumps({"tier2": {"prior": 99}, "ad_id": None})]
                         + [json.dumps(x) for x in cre[6:]])
            write_jsonl(os.path.join(sd, "creatives.jsonl"), cre_lines)
            kpi_lines = [json.dumps(x) for x in kpi[:6]] + ["@@@bad@@@"] \
                + [json.dumps(x) for x in kpi[6:]]
            write_jsonl(os.path.join(sd, "kpi.jsonl"), kpi_lines)

            r = run_fit(d, proj)
            self.assertEqual(r.returncode, 0, r.stderr)
            cal, _ = load_cal(d, proj)
            # 12 valid creatives joined (null ad_id + garbage skipped)
            self.assertEqual(cal["points"], 12, cal)
            self.assertEqual(cal["model"], "isotonic", cal)

    # ── Determinism ──────────────────────────────────────────────────────────
    def test_determinism(self):
        with tempfile.TemporaryDirectory() as d:
            proj = "det"
            priors = [10, 20, 30, 40, 50, 60, 70]
            cpls = [50, 44, 41, 33, 28, 22, 16]
            pairs = [(f"D{i}", float(priors[i]), float(cpls[i]))
                     for i in range(7)]
            cre, kpi = make_rows(pairs)
            sd = os.path.join(d, "autopilot_state", proj)
            write_jsonl(os.path.join(sd, "creatives.jsonl"), cre)
            write_jsonl(os.path.join(sd, "kpi.jsonl"), kpi)

            run_fit(d, proj)
            cal1, _ = load_cal(d, proj)
            run_fit(d, proj)
            cal2, _ = load_cal(d, proj)
            self.assertEqual(cal1["mapping"], cal2["mapping"])
            self.assertEqual(cal1["coef"], cal2["coef"])
            self.assertEqual(cal1["intercept"], cal2["intercept"])
            self.assertEqual(cal1["points"], cal2["points"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
