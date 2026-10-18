#!/usr/bin/env python3
"""Synthetic, offline coverage of credential presence (not API validity)."""
import json
from typing import Any
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "bin/ops-credentials"
SECRET = "synthetic-credential-value-abcdefgh"


class CredentialAudit(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.data = self.root / "data"
        self.data.mkdir()
        self.env = {"HOME": str(self.root), "PATH": str(self.bin) + ":/usr/bin:/bin",
                    "OPS_DATA_DIR": str(self.data), "MOCK_ROOT": str(self.root)}
        jq = shutil.which("jq")
        assert jq is not None, "jq is required"
        (self.bin / "jq").symlink_to(jq)
        self.mock("uname", "printf Linux")
        self.mock("security", "exit 91")
        self.mock("dcli", 'printf called >> "$MOCK_ROOT/vault-calls"\n'
                  + "printf '%s' '[{\"password\":\"" + SECRET + "\"}]'")
        self.mock("doppler", 'cat >/dev/null\nprintf "%s\\n" "$*" >> "$MOCK_ROOT/doppler-calls"\n'
                  + 'case "$3" in GOOD) printf "%s" "' + SECRET + '";; '
                  + 'FAIL) printf "partial-secret-output"; exit 1;; *) exit 1;; esac')

    def mock(self, name, body):
        path = self.bin / name
        path.write_text("#!/bin/bash\n" + body + "\n")
        path.chmod(0o755)

    def audit(self, prefs=None, service=None, text=False, extra=None) -> Any:
        (self.data / "preferences.json").write_text(json.dumps(prefs or {}))
        args = ["/bin/bash", str(SCRIPT)]
        if not text:
            args.append("--json")
        if service:
            args += ["--service", service]
        result = subprocess.run(args, env={**self.env, **(extra or {})},
                                input="stdin payload\n", text=True, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        for raw in (SECRET, "partial-secret-output"):
            self.assertNotIn(raw, result.stdout + result.stderr)
        return result.stdout if text else json.loads(result.stdout)

    def test_website_password_never_used_even_token_shaped(self):
        for password in (SECRET, "sk_test_" + "x" * 32):
            self.mock("dcli", 'printf called >> "$MOCK_ROOT/vault-calls"\n'
                      + "printf '%s' '[{\"password\":\"" + password + "\"}]'")
            rows = self.audit()
            self.assertTrue(all(not row["configured"] for row in rows))
            self.assertFalse((self.root / "vault-calls").exists())

    def test_user_config_catalog_mapping(self):
        keys = {"telegram_api_hash": "Telegram (api_hash)", "telegram_session": "Telegram (session)",
                "discord_bot_token": "Discord bot token", "discord_default_webhook_url": "Discord webhook",
                "pushover_user_key": "Pushover user key", "pushover_app_token": "Pushover app token",
                "datadog_api_key": "Datadog API key", "datadog_app_key": "Datadog app key",
                "newrelic_api_key": "New Relic API key", "doppler_token": "Doppler service token",
                "klaviyo_private_key": "Klaviyo private key", "meta_ads_token": "Meta Ads access token",
                "shopify_admin_token": "Shopify admin token", "shipbob_access_token": "ShipBob access token",
                "bland_ai_api_key": "Bland AI API key", "elevenlabs_api_key": "ElevenLabs API key",
                "groq_api_key": "Groq API key", "stripe_secret_key": "Stripe secret key",
                "revenuecat_api_key": "RevenueCat API key", "postnl_customer_code": "PostNL customer code",
                "dpd_password": "DPD password", "ups_client_secret": "UPS client secret",
                "fedex_client_secret": "FedEx client secret"}
        rows = {row["label"]: row for row in self.audit({"user_config": dict.fromkeys(keys, SECRET)})}
        for key, label in keys.items():
            with self.subTest(key=key):
                self.assertTrue(rows[label]["configured"])
                self.assertEqual(rows[label]["source"], "prefs:.user_config." + key)

    def test_scoped_and_default_doppler_refs(self):
        cases = [("doppler:demo/stg/GOOD", {}, "secrets get GOOD --plain --project demo --config stg"),
                 ("doppler:stg:GOOD", {"project": "demo"}, "secrets get GOOD --plain --project demo --config stg"),
                 ("doppler:GOOD", {"project": "demo", "config": "dev"}, "secrets get GOOD --plain --project demo --config dev"),
                 ("doppler:GOOD", {}, "secrets get GOOD --plain")]
        for ref, defaults, command in cases:
            with self.subTest(ref=ref, defaults=defaults):
                row = self.audit({"telegram": {"api_hash": ref}, "doppler": defaults}, "telegram")[0]
                self.assertTrue(row["configured"])
                self.assertEqual(row["source"], ref)
                self.assertEqual((self.root / "doppler-calls").read_text().splitlines()[-1], command)

    def test_user_config_doppler_defaults(self):
        row = self.audit({"user_config": {"telegram_api_hash": "doppler:GOOD",
                         "doppler_project": "demo", "doppler_config": "dev"}}, "telegram")[0]
        self.assertTrue(row["configured"])
        self.assertEqual((self.root / "doppler-calls").read_text().strip(),
                         "secrets get GOOD --plain --project demo --config dev")

    def test_missing_failed_and_bad_refs_are_unresolved(self):
        for ref in ("doppler:MISSING", "doppler:FAIL", "doppler:", "doppler:a/b", "doppler:a//GOOD",
                    "doppler:a/b/GOOD/extra", "doppler:--help", "doppler:bad key", "env:MISSING",
                    "env:BAD-NAME"):
            with self.subTest(ref=ref):
                row = self.audit({"telegram": {"api_hash": ref}}, "telegram")[0]
                self.assertFalse(row["configured"])
                self.assertEqual(row["status"], "unresolved")
                self.assertNotIn("masked", row)
                self.assertNotIn(ref, row.get("source", ""))

    def test_missing_cli_is_unresolved(self):
        (self.bin / "doppler").unlink()
        row = self.audit({"telegram": {"api_hash": "doppler:GOOD"}}, "telegram")[0]
        self.assertFalse(row["configured"])
        self.assertEqual(row["status"], "unresolved")

    def test_env_and_legacy_preferences_remain_compatible(self):
        row = self.audit({"telegram": {"api_hash": SECRET}}, "telegram")[0]
        self.assertEqual(row["source"], "prefs:.telegram.api_hash")
        row = self.audit({"telegram": {"api_hash": "doppler:MISSING"}}, "telegram",
                         extra={"TELEGRAM_API_HASH": SECRET})[0]
        self.assertEqual(row["source"], "env:TELEGRAM_API_HASH")
        row = self.audit({"telegram": {"api_hash": "env:SYNTHETIC_TOKEN"}}, "telegram",
                         extra={"SYNTHETIC_TOKEN": SECRET})[0]
        self.assertEqual(row["source"], "env:SYNTHETIC_TOKEN")

    def test_invalid_preference_types_not_credentials(self):
        for value in (False, 123, {}, [], "${user_config.telegram_api_hash}"):
            with self.subTest(value=value):
                self.assertFalse(self.audit({"telegram": {"api_hash": value}}, "telegram")[0]["configured"])

    def test_keychain_remains_supported_without_vault_fallback(self):
        self.mock("uname", "printf Darwin")
        self.mock("security", 'cat >/dev/null\nprintf "%s" "' + SECRET + '"')
        row = self.audit(service="linear")[0]
        self.assertTrue(row["configured"])
        self.assertEqual(row["source"], "keychain:linear-api-key")
        self.assertFalse((self.root / "vault-calls").exists())

    def test_empty_success_is_unresolved(self):
        self.mock("doppler", "exit 0")
        row = self.audit({"telegram": {"api_hash": "doppler:GOOD"}}, "telegram")[0]
        self.assertFalse(row["configured"])
        self.assertEqual(row["status"], "unresolved")

    def test_malformed_refs_never_invoke_doppler(self):
        for ref in ("doppler:", "doppler:a/b", "doppler:a//GOOD", "doppler:a/b/GOOD/extra",
                    "doppler:--help", "doppler:bad key", "doppler::GOOD"):
            self.audit({"telegram": {"api_hash": ref}}, "telegram")
        self.assertFalse((self.root / "doppler-calls").exists())

    def test_stdin_drain_keeps_entire_catalog(self):
        rows = self.audit({"telegram": {"api_hash": "doppler:GOOD"}})
        catalog = SCRIPT.read_text().split("CATEOF", 2)[1].splitlines()[1:]
        self.assertEqual(len(rows), len([line for line in catalog if "|" in line]))
        self.assertTrue(rows[0]["configured"])

    def test_text_and_compact_unresolved_are_not_configured(self):
        for extra in ({}, {"OPS_MOBILE": "1"}):
            output = self.audit({"telegram": {"api_hash": "doppler:MISSING"}}, "telegram", True, extra)
            self.assertIn("unresolved", output)
            self.assertNotIn("✓", output)


if __name__ == "__main__":
    unittest.main()
