#!/usr/bin/env python3
"""Offline fixture suite for scripts/ops-aws-audit.sh.

Invokes the changed script through a synthetic aws stub. Never calls AWS.
Synthetic output is method evidence only, not account proof.
"""
import json
import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "scripts/ops-aws-audit.sh"
POLICY = ROOT / "scripts/lambda-runtime-policy.json"
FAKE_PY = ROOT / "tests/aws-audit-offline/fake_aws.py"
AWS_SH = ROOT / "tests/aws-audit-offline/aws"

# CSV columns follow the official IAM credential-report field order.
# https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_getting-report.html
CRED_HEADER = ",".join([
    "user", "arn", "user_creation_time", "password_enabled", "password_last_used",
    "password_last_changed", "password_next_rotation", "mfa_active",
    "access_key_1_active", "access_key_1_last_rotated", "access_key_1_last_used_date",
    "access_key_1_last_used_region", "access_key_1_last_used_service",
    "access_key_2_active", "access_key_2_last_rotated", "access_key_2_last_used_date",
    "access_key_2_last_used_region", "access_key_2_last_used_service",
    "cert_1_active", "cert_1_last_rotated", "cert_2_active", "cert_2_last_rotated",
])


def cred_row(user, arn, key1="false", key1_rotated="N/A", key1_used="N/A",
             key2="false", key2_rotated="N/A", key2_used="N/A", mfa="true"):
    fields = {
        "user": user, "arn": arn, "user_creation_time": "2020-01-01T00:00:00Z",
        "password_enabled": "true", "password_last_used": "2026-10-01T00:00:00Z",
        "password_last_changed": "2026-01-01T00:00:00Z", "password_next_rotation": "N/A",
        "mfa_active": mfa,
        "access_key_1_active": key1, "access_key_1_last_rotated": key1_rotated,
        "access_key_1_last_used_date": key1_used, "access_key_1_last_used_region": "us-east-1",
        "access_key_1_last_used_service": "s3",
        "access_key_2_active": key2, "access_key_2_last_rotated": key2_rotated,
        "access_key_2_last_used_date": key2_used, "access_key_2_last_used_region": "us-east-1",
        "access_key_2_last_used_service": "ec2",
        "cert_1_active": "false", "cert_1_last_rotated": "N/A",
        "cert_2_active": "false", "cert_2_last_rotated": "N/A",
    }
    return ",".join(fields[name] for name in CRED_HEADER.split(","))


QUIET = {
    "account": {"contains": ["sts", "get-caller-identity"], "stdout": '{"Account":"000000000000","Arn":"arn:aws:iam::000000000000:root"}\n'},
    "instances": {"contains": ["describe-instances"], "stdout": '{"Reservations":[]}\n'},
    "analyzers": {"contains": ["accessanalyzer", "list-analyzers"], "stdout": '{"analyzers":[{"name":"aa","type":"ACCOUNT"}]}\n'},
    "volumes": {"contains": ["ec2", "describe-volumes"], "stdout": '{"Volumes":[]}\n'},
    "addresses": {"contains": ["describe-addresses"], "stdout": '{"Addresses":[]}\n'},
    "vpcs": {"contains": ["describe-vpcs"], "stdout": '{"Vpcs":[{"VpcId":"vpc-1"}]}\n'},
    "sgs": {"contains": ["describe-security-groups"], "stdout": '{"SecurityGroups":[]}\n'},
    "rds": {"contains": ["rds", "describe-db-instances"], "stdout": '{"DBInstances":[]}\n'},
    "clusters": {"contains": ["describe-db-clusters"], "stdout": '{"DBClusters":[]}\n'},
    "snaps": {"contains": ["describe-db-snapshots"], "stdout": '{"DBSnapshots":[]}\n'},
    "buckets": {"contains": ["s3api", "list-buckets"], "stdout": '{"Buckets":[]}\n'},
    "pab": {"contains": ["get-public-access-block"], "stdout": '{"PublicAccessBlockConfiguration":{"BlockPublicAcls":true,"IgnorePublicAcls":true,"BlockPublicPolicy":true,"RestrictPublicBuckets":true}}\n'},
    "logs": {"contains": ["describe-log-groups"], "stdout": '{"logGroups":[]}\n'},
    "lambdas": {"contains": ["lambda", "list-functions"], "stdout": '{"Functions":[]}\n'},
    "gd": {"contains": ["guardduty", "list-detectors"], "stdout": '{"DetectorIds":["d1"]}\n'},
    "sh": {"contains": ["securityhub", "describe-hub"], "stdout": '{"HubArn":"arn:aws:securityhub:us-east-1:000000000000:hub/default"}\n'},
    "standards": {"contains": ["get-enabled-standards"], "stdout": '{"StandardsSubscriptions":[{"StandardsArn":"arn:aws:securityhub:::standards/aws-foundational-security-best-practices/v/1.0.0"}]}\n'},
    "ce": {"contains": ["ce", "get-cost-and-usage"], "stdout": '{"ResultsByTime":[{"Groups":[]}]}\n'},
    "anomaly": {"contains": ["get-anomaly-monitors"], "stdout": '{"AnomalyMonitors":[{"MonitorArn":"arn:mon"}]}\n'},
    "optimizer": {"contains": ["compute-optimizer", "get-enrollment-status"], "stdout": '{"status":"Active"}\n'},
}


def base_calls():
    calls = [
        {"contains": ["iam", "get-credential-report"], "stdout": json.dumps({"Content": "dXNlcixhcm4sYWNjZXNzX2tleV8xX2FjdGl2ZSxhY2Nlc3Nfa2V5XzJfYWN0aXZlXG48cm9vdF9hY2NvdW50Pixhcm4sZmFsc2UsZmFsc2Vcbg=="}) + "\n"},
        {"contains": ["iam", "get-account-summary"], "stdout": '{"SummaryMap":{"AccountMFAEnabled":1}}\n'},
    ]
    calls.extend(dict(item) for item in QUIET.values())
    return calls


class OfflineAudit(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.out = Path(self.tmp.name) / "out"
        self.fixture = Path(self.tmp.name) / "fixture.json"
        self.log = Path(self.tmp.name) / "aws-calls.jsonl"
        bindir = Path(self.tmp.name) / "bin"
        bindir.mkdir()
        aws = bindir / "aws"
        shutil.copy(AWS_SH, aws)
        aws.chmod(aws.stat().st_mode | stat.S_IEXEC)
        self.bindir = bindir

    def write_fixture(self, calls):
        self.fixture.write_text(json.dumps({"calls": calls}), encoding="utf-8")

    def run_audit(self, calls, audit_date="2026-10-18"):
        self.write_fixture(calls)
        env = os.environ.copy()
        env.update({
            "PATH": f"{self.bindir}:{env.get('PATH', '')}",
            "AWS_AUDIT_FIXTURE": str(self.fixture),
            "AWS_AUDIT_FAKE_PY": str(FAKE_PY),
            "AWS_AUDIT_CALL_LOG": str(self.log),
            "AWS_AUDIT_OFFLINE": "1",
            "AUDIT_OUTPUT_DIR": str(self.out),
            "AUDIT_REGIONS": "us-east-1",
            "AUDIT_DATE": audit_date,
            "AUDIT_RUNTIME_POLICY": str(POLICY),
            "HOME": self.tmp.name,
        })
        env.pop("AWS_PROFILE", None)
        env.pop("AWS_ACCESS_KEY_ID", None)
        env.pop("AWS_SECRET_ACCESS_KEY", None)
        env.pop("AWS_SESSION_TOKEN", None)
        return subprocess.run(
            ["bash", str(SOURCE)],
            env=env, capture_output=True, text=True, timeout=60,
        )

    def findings(self):
        data = json.loads((self.out / "findings.json").read_text(encoding="utf-8"))
        return data["findings"] if isinstance(data, dict) else data

    def titles(self):
        rows = self.findings()
        return [row.get("title") or f"{row.get('resource','')} {row.get('issue','')}" for row in rows]

    def coverage(self):
        path = self.out / "coverage.json"
        if not path.exists():
            self.fail("coverage.json missing")
        return json.loads(path.read_text(encoding="utf-8"))

    def aws_argv(self):
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text().splitlines() if line.strip()]

    def test_access_denied_is_not_absence_and_keeps_stderr(self):
        calls = base_calls()
        calls = [c for c in calls if "get-public-access-block" not in c["contains"]]
        calls.append({
            "contains": ["get-public-access-block"],
            "exit": 254,
            "stdout": "",
            "stderr": "An error occurred (AccessDenied) when calling the GetPublicAccessBlock operation: explicit deny\n",
        })
        calls = [c for c in calls if not ("ec2" in c["contains"] and "describe-volumes" in c["contains"])]
        calls.append({
            "contains": ["ec2", "describe-volumes"],
            "exit": 254,
            "stdout": "",
            "stderr": "An error occurred (AccessDenied) when calling the DescribeVolumes operation: denied\n",
        })
        calls = [c for c in calls if "get-cost-and-usage" not in c["contains"]]
        calls.append({
            "contains": ["ce", "get-cost-and-usage"],
            "exit": 254,
            "stdout": "",
            "stderr": "An error occurred (AccessDenied) when calling the GetCostAndUsage operation: denied\n",
        })
        result = self.run_audit(calls)
        self.assertNotEqual(result.returncode, 0, result.stderr)
        text = result.stdout + result.stderr + (self.out / "audit.log").read_text(encoding="utf-8")
        self.assertIn("AccessDenied", text)
        self.assertNotIn("no account-level Block Public Access", text)
        joined = " ".join(self.titles())
        self.assertNotIn("no account-level Block Public Access", joined)
        self.assertNotIn("Cost up", joined)
        cov = self.coverage()
        self.assertEqual(cov["s3-public-access-block"]["status"], "denied")
        self.assertIn("explicit deny", cov["s3-public-access-block"]["stderr"])
        self.assertEqual(cov["ec2-volumes-us-east-1"]["status"], "denied")

    def test_s3_missing_policy_differs_from_denied_read(self):
        calls = base_calls()
        calls = [c for c in calls if "list-buckets" not in " ".join(c["contains"])]
        calls.append({"contains": ["s3api", "list-buckets"], "stdout": '{"Buckets":[{"Name":"bkt"}]}\n'})
        calls.append({
            "contains": ["get-bucket-policy", "bkt"],
            "exit": 254,
            "stderr": "An error occurred (NoSuchBucketPolicy) when calling the GetBucketPolicy operation: The bucket policy does not exist\n",
        })
        calls.append({
            "contains": ["get-bucket-encryption", "bkt"],
            "exit": 254,
            "stderr": "An error occurred (AccessDenied) when calling the GetBucketEncryption operation: denied\n",
        })
        calls.append({"contains": ["get-bucket-lifecycle-configuration", "bkt"], "stdout": '{"Rules":[{"ID":"r","Status":"Enabled"}]}\n'})
        result = self.run_audit(calls)
        text = result.stdout + result.stderr + (self.out / "audit.log").read_text(encoding="utf-8")
        joined = " ".join(self.titles())
        self.assertIn("NoSuchBucketPolicy", text)
        self.assertNotIn("no bucket policy", joined.lower())
        self.assertTrue(any("denied" in t.lower() and "encryption" in t.lower() for t in self.titles()), self.titles())
        self.assertIn("AccessDenied", self.coverage()["s3-bucket-encryption:bkt"]["stderr"])

    def test_root_second_key_and_quoted_csv(self):
        row = cred_row(
            "<root_account>", "arn:aws:iam::000000000000:root",
            key1="false", key2="true",
            key2_rotated="2020-01-01T00:00:00Z", key2_used="2026-10-17T00:00:00Z",
        )
        # A quoted comma in an earlier field must not shift key 2.
        header = CRED_HEADER
        shifted = row.replace("arn:aws:iam::000000000000:root", '"arn:aws:iam::000000000000:root,extra"', 1)
        content = header + "\n" + shifted + "\n"
        calls = base_calls()
        calls = [c for c in calls if "get-credential-report" not in " ".join(c["contains"])]
        calls.append({"contains": ["iam", "get-credential-report"], "stdout": json.dumps({"Content": __import__("base64").b64encode(content.encode()).decode()}) + "\n"})
        result = self.run_audit(calls)
        joined = " ".join(self.titles())
        self.assertIn("root access key", joined.lower())
        self.assertTrue(any("2" in t or "second" in t.lower() for t in self.titles()), self.titles())
        for argv in self.aws_argv():
            self.assertNotIn("generate-credential-report", argv)

    def test_read_only_audit_never_generates_credential_report(self):
        result = self.run_audit(base_calls())
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        for argv in self.aws_argv():
            self.assertNotIn("generate-credential-report", argv)
        self.assertEqual(self.coverage()["iam-credential-report"]["status"], "ok")

    def test_security_group_ipv6_range_and_all_protocols(self):
        calls = base_calls()
        calls = [c for c in calls if "describe-security-groups" not in c["contains"]]
        groups = {"SecurityGroups": [
            {"GroupId": "sg-range", "IpPermissions": [{"IpProtocol": "tcp", "FromPort": 20, "ToPort": 30, "IpRanges": [{"CidrIp": "0.0.0.0/0"}]}]},
            {"GroupId": "sg-v6", "IpPermissions": [{"IpProtocol": "tcp", "FromPort": 22, "ToPort": 22, "Ipv6Ranges": [{"CidrIpv6": "::/0"}], "IpRanges": []}]},
            {"GroupId": "sg-all", "IpPermissions": [{"IpProtocol": "-1", "IpRanges": [{"CidrIp": "0.0.0.0/0"}]}]},
            {"GroupId": "sg-closed", "IpPermissions": [{"IpProtocol": "tcp", "FromPort": 443, "ToPort": 443, "IpRanges": [{"CidrIp": "10.0.0.0/8"}]}]},
        ]}
        calls.append({"contains": ["describe-security-groups"], "stdout": json.dumps(groups) + "\n"})
        result = self.run_audit(calls)
        self.assertEqual(result.returncode, 0, result.stderr)
        joined = " ".join(self.titles())
        self.assertIn("sg-range", joined)
        self.assertIn("sg-v6", joined)
        self.assertIn("sg-all", joined)
        self.assertNotIn("sg-closed", joined)

    def test_rds_successful_empty_and_cluster_source_is_not_orphan(self):
        calls = base_calls()
        calls = [c for c in calls if "describe-db-instances" not in c["contains"] and "describe-db-clusters" not in c["contains"] and "describe-db-snapshots" not in c["contains"]]
        calls.append({"contains": ["rds", "describe-db-instances"], "stdout": '{"DBInstances":[]}\n'})
        calls.append({"contains": ["describe-db-clusters"], "stdout": '{"DBClusters":[{"DBClusterIdentifier":"cluster-a"}]}\n'})
        calls.append({"contains": ["describe-db-snapshots"], "stdout": json.dumps({"DBSnapshots": [
            {"DBSnapshotIdentifier": "snap-cluster", "SnapshotType": "manual", "DBInstanceIdentifier": "cluster-a"},
            {"DBSnapshotIdentifier": "snap-gone", "SnapshotType": "manual", "DBInstanceIdentifier": "deleted-db"},
        ]}) + "\n"})
        result = self.run_audit(calls)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        joined = " ".join(self.titles())
        self.assertIn("snap-gone", joined)
        self.assertNotIn("snap-cluster", joined)
        self.assertEqual(self.coverage()["rds-instances-us-east-1"]["status"], "ok")

    def test_rds_partial_denial_does_not_orphan_known_source(self):
        calls = base_calls()
        calls = [c for c in calls if "describe-db-instances" not in c["contains"] and "describe-db-clusters" not in c["contains"] and "describe-db-snapshots" not in c["contains"]]
        calls.append({
            "contains": ["rds", "describe-db-instances"],
            "exit": 254, "stderr": "An error occurred (AccessDenied) when calling the DescribeDBInstances operation: denied\n",
        })
        calls.append({"contains": ["describe-db-clusters"], "stdout": '{"DBClusters":[{"DBClusterIdentifier":"other"}]}\n'})
        calls.append({"contains": ["describe-db-snapshots"], "stdout": json.dumps({"DBSnapshots": [
            {"DBSnapshotIdentifier": "snap-maybe", "SnapshotType": "manual", "DBInstanceIdentifier": "hidden-db"},
        ]}) + "\n"})
        result = self.run_audit(calls)
        joined = " ".join(self.titles())
        self.assertNotIn("snap-maybe", joined)
        self.assertEqual(self.coverage()["rds-instances-us-east-1"]["status"], "denied")
        self.assertIn("AccessDenied", self.coverage()["rds-instances-us-east-1"]["stderr"])

    def test_runtime_uses_audit_date_against_official_policy(self):
        calls = base_calls()
        calls = [c for c in calls if not ("lambda" in c["contains"] and "list-functions" in c["contains"])]
        calls.append({"contains": ["lambda", "list-functions"], "stdout": json.dumps({"Functions": [
            {"FunctionName": "py310", "Runtime": "python3.10"},
            {"FunctionName": "py311", "Runtime": "python3.11"},
            {"FunctionName": "node20", "Runtime": "nodejs20.x"},
            {"FunctionName": "node18", "Runtime": "nodejs18.x"},
            {"FunctionName": "dotnet6", "Runtime": "dotnet6"},
            {"FunctionName": "node22", "Runtime": "nodejs22.x"},
        ]}) + "\n"})
        early = self.run_audit(calls, audit_date="2026-04-01")
        self.assertEqual(early.returncode, 0, early.stderr)
        early_titles = " ".join(self.titles())
        self.assertIn("node18", early_titles)
        self.assertIn("dotnet6", early_titles)
        self.assertNotIn("node20", early_titles)
        self.assertNotIn("py310", early_titles)
        self.assertNotIn("py311", early_titles)
        self.assertNotIn("node22", early_titles)
        self.log.write_text("")
        late = self.run_audit(calls, audit_date="2026-11-01")
        self.assertEqual(late.returncode, 0, late.stderr)
        late_titles = " ".join(self.titles())
        self.assertIn("node20", late_titles)
        self.assertIn("py310", late_titles)
        self.assertNotIn("py311", late_titles)
        self.assertNotIn("node22", late_titles)

    def test_invalid_findings_fail_instead_of_empty_report(self):
        result = self.run_audit(base_calls())
        self.assertEqual(result.returncode, 0, result.stderr)
        path = self.out / "findings.json"
        path.write_text("{not json", encoding="utf-8")
        env = os.environ.copy()
        env.update({
            "PATH": f"{self.bindir}:{env.get('PATH', '')}",
            "AWS_AUDIT_OFFLINE": "1",
            "AUDIT_OUTPUT_DIR": str(self.out),
            "AUDIT_REGIONS": "us-east-1",
            "AUDIT_DATE": "2026-10-18",
            "AUDIT_RUNTIME_POLICY": str(POLICY),
        })
        again = subprocess.run(["bash", str(SOURCE), "--report-only"], env=env, capture_output=True, text=True, timeout=30)
        self.assertNotEqual(again.returncode, 0, again.stdout)
        self.assertIn("findings", (again.stderr + again.stdout).lower())
        report = (self.out / "report.md").read_text(encoding="utf-8") if (self.out / "report.md").exists() else ""
        self.assertNotIn("Total: 0", report)

    def test_paginated_results_are_consumed(self):
        calls = base_calls()
        calls = [c for c in calls if not ("ec2" in c["contains"] and "describe-volumes" in c["contains"])]
        calls.append({
            "contains": ["ec2", "describe-volumes"],
            "pages": [
                {"token": None, "stdout": json.dumps({"Volumes": [{"VolumeId": "vol-page1", "State": "available", "VolumeType": "gp3", "Encrypted": True, "Size": 8}], "NextToken": "page-2"}) + "\n"},
                {"token": "page-2", "stdout": json.dumps({"Volumes": [{"VolumeId": "vol-page2", "State": "available", "VolumeType": "gp3", "Encrypted": True, "Size": 8}]}) + "\n"},
            ],
        })
        result = self.run_audit(calls)
        self.assertEqual(result.returncode, 0, result.stderr)
        joined = " ".join(self.titles())
        self.assertIn("vol-page1", joined)
        self.assertIn("vol-page2", joined)
        tokens = [argv[argv.index("--starting-token") + 1] for argv in self.aws_argv() if "--starting-token" in argv]
        self.assertIn("page-2", tokens)

    def test_text_output_denial_is_coverage_not_absence(self):
        """Access Analyzer, EIP, logs, Security Hub and Compute Optimizer discard stderr today."""
        calls = base_calls()
        denied = [
            (["accessanalyzer", "list-analyzers"], "ListAnalyzers"),
            (["describe-addresses"], "DescribeAddresses"),
            (["describe-log-groups"], "DescribeLogGroups"),
            (["get-enabled-standards"], "GetEnabledStandards"),
            (["compute-optimizer", "get-enrollment-status"], "GetEnrollmentStatus"),
        ]
        for needles, _name in denied:
            calls = [c for c in calls if not all(part in c["contains"] for part in needles)]
            calls.append({
                "contains": needles,
                "exit": 254,
                "stdout": "",
                "stderr": f"An error occurred (AccessDenied) when calling the {_name} operation: explicit deny\\n",
            })
        result = self.run_audit(calls)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        joined = " ".join(self.titles())
        self.assertNotIn("No unused-access", joined)
        self.assertNotIn("Security Hub standards not enabled", joined)
        self.assertNotIn("Compute Optimizer not enrolled", joined)
        cov = self.coverage()
        for key in (
            "accessanalyzer-us-east-1",
            "ec2-addresses-us-east-1",
            "logs-us-east-1",
            "securityhub-standards-us-east-1",
            "compute-optimizer",
        ):
            self.assertEqual(cov[key]["status"], "denied", cov.get(key))
            self.assertIn("AccessDenied", cov[key]["stderr"])

    def test_empty_json_is_not_a_resource_and_null_status_is_not_active(self):
        """AWS CLI text prints nothing for [] and the literal None for null. JSON must not invent either."""
        calls = base_calls()
        calls = [c for c in calls if "describe-log-groups" not in c["contains"] and "get-enrollment-status" not in c["contains"]]
        calls.append({"contains": ["describe-log-groups"], "stdout": '{"logGroups":[]}\n'})
        calls.append({"contains": ["compute-optimizer", "get-enrollment-status"], "stdout": '{"status":null}\n'})
        result = self.run_audit(calls)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        joined = " ".join(self.titles())
        self.assertNotIn('{"logGroups":[]}', joined)
        self.assertNotIn("None", joined)
        self.assertNotIn("log group", joined.lower())
        self.assertTrue(any("unknown" in t.lower() and "optimizer" in t.lower() for t in self.titles()), self.titles())

    def test_image_and_unknown_runtime_are_unassessed_custom_is_known(self):
        calls = base_calls()
        calls = [c for c in calls if not ("lambda" in c["contains"] and "list-functions" in c["contains"])]
        calls.append({"contains": ["lambda", "list-functions"], "stdout": json.dumps({"Functions": [
            {"FunctionName": "img", "PackageType": "Image"},
            {"FunctionName": "mystery", "Runtime": "made-up-runtime"},
            {"FunctionName": "custom", "Runtime": "provided.al2023"},
        ]}) + "\n"})
        result = self.run_audit(calls, audit_date="2026-11-01")
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        rows = json.loads((self.out / "findings.json").read_text(encoding="utf-8"))
        by_name = {row["resource"]: row for row in rows}
        self.assertEqual(by_name["img"].get("coverage"), "unassessed")
        self.assertEqual(by_name["mystery"].get("coverage"), "unassessed")
        self.assertNotIn("custom", by_name)

    def test_nodejs20_deprecation_is_april_not_the_phase1_block(self):
        policy = json.loads(POLICY.read_text(encoding="utf-8"))
        row = next(item for item in policy["deprecated"] if item["id"] == "nodejs20.x")
        self.assertEqual(row["deprecation"], "2026-04-30")
        source = policy["source_rows"]["nodejs20.x"]
        self.assertEqual(source["deprecation"], "Apr 30, 2026")
        self.assertEqual(source["block_function_update"], "Jul 31, 2026")
        dates = [item["deprecation"] for item in policy["deprecated"] + policy["supported"]]
        self.assertNotIn("2026-08-31", dates)
        self.assertIn("19:02:51Z", policy["retrieved"])

    def test_denied_guard_mutation_still_fails_closed(self):
        """Regression: a stub that returns denial must never be stored as ok/empty."""
        calls = base_calls()
        calls = [c for c in calls if "list-detectors" not in c["contains"]]
        calls.append({
            "contains": ["guardduty", "list-detectors"],
            "exit": 254,
            "stderr": "An error occurred (AccessDenied) when calling the ListDetectors operation: denied\n",
        })
        result = self.run_audit(calls)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("GuardDuty not enabled", " ".join(self.titles()))
        self.assertEqual(self.coverage()["guardduty-us-east-1"]["status"], "denied")
        self.assertNotEqual(self.coverage()["guardduty-us-east-1"]["status"], "ok")


if __name__ == "__main__":
    unittest.main(verbosity=2)
