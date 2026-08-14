from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import vpc_paths


class FakeRunner:
    def __init__(self) -> None:
        self.calls: list[tuple[str, ...]] = []

    def __call__(self, argv, **_kwargs):
        command = tuple(argv)
        self.calls.append(command)
        joined = " ".join(command)
        if "describe-client-vpn-endpoints" in command:
            payload = {
                "ClientVpnEndpoints": [
                    {
                        "ClientVpnEndpointId": "cvpn-endpoint-private-identifier",
                        "Status": {"Code": "available"},
                    }
                ]
            }
        elif "describe-client-vpn-target-networks" in command:
            payload = {
                "ClientVpnTargetNetworks": [
                    {"AssociationId": "cvpn-assoc-private", "Status": {"Code": "associated"}}
                ]
            }
        elif "describe-instance-information" in command:
            payload = {
                "InstanceInformationList": [
                    {
                        "InstanceId": "i-privateidentifier",
                        "PingStatus": "Online",
                        "AgentVersion": "3.2.0.0",
                    }
                ]
            }
        elif command[:2] == ("tailscale", "status"):
            payload = {
                "BackendState": "Running",
                "TailscaleIPs": ["100.64.0.10"],
                "Self": {"Online": True, "DNSName": "private-name.example.ts.net."},
            }
        elif command[:3] == ("/sbin/route", "-n", "get"):
            return SimpleNamespace(returncode=0, stdout="interface: utun9\n", stderr="")
        elif command[:2] in {
            ("aws", "--version"),
            ("session-manager-plugin", "--version"),
        }:
            return SimpleNamespace(returncode=0, stdout="installed\n", stderr="")
        else:
            self.fail_unexpected(joined)
        return SimpleNamespace(returncode=0, stdout=json.dumps(payload), stderr="")

    def fail_unexpected(self, command: str) -> None:
        raise AssertionError(f"unexpected command: {command}")


class DetectionTests(unittest.TestCase):
    def test_detection_is_read_only_and_redacts_resource_identifiers(self) -> None:
        runner = FakeRunner()

        result = vpc_paths.detect(
            region="us-east-1",
            profile=None,
            ssm_target=None,
            route_destination="10.0.0.10",
            runner=runner,
        )

        rendered = json.dumps(result, sort_keys=True)
        self.assertEqual(result["client_vpn"]["available_endpoints"], 1)
        self.assertEqual(result["client_vpn"]["associated_target_networks"], 1)
        self.assertEqual(result["ssm"]["online_managed_nodes"], 1)
        self.assertTrue(result["tailscale"]["online"])
        self.assertEqual(result["local_route"]["interface_class"], "utun")
        for private_value in (
            "cvpn-endpoint-private-identifier",
            "cvpn-assoc-private",
            "i-privateidentifier",
            "private-name.example.ts.net",
            "100.64.0.10",
            "utun9",
        ):
            self.assertNotIn(private_value, rendered)
        commands = "\n".join(" ".join(command).lower() for command in runner.calls)
        for mutation in (
            " create-",
            " delete-",
            " modify-",
            " authorize-",
            " start-session",
            "advertise-routes",
        ):
            self.assertNotIn(mutation, commands)

    def test_missing_tools_are_reported_without_error_text(self) -> None:
        def missing(_argv, **_kwargs):
            raise FileNotFoundError("private installation path")

        result = vpc_paths.detect(
            region="us-east-1",
            profile=None,
            ssm_target=None,
            route_destination=None,
            runner=missing,
        )

        rendered = json.dumps(result)
        self.assertIn('"state": "unavailable"', rendered)
        self.assertNotIn("private installation path", rendered)


class PlanTests(unittest.TestCase):
    def test_client_vpn_template_covers_auth_network_and_access_resources(self) -> None:
        text = vpc_paths.TEMPLATE.read_text(encoding="utf-8")

        for expected in (
            "AWS::EC2::ClientVpnEndpoint",
            "AWS::EC2::ClientVpnTargetNetworkAssociation",
            "AWS::EC2::ClientVpnAuthorizationRule",
            "AWS::EC2::ClientVpnRoute",
            "certificate-authentication",
            "directory-service-authentication",
            "federated-authentication",
            "ExistingSecurityGroupId",
            "DnsServers",
        ):
            self.assertIn(expected, text)

    def test_client_vpn_plan_is_change_set_only_and_marks_paid_gate(self) -> None:
        text = vpc_paths.render_client_vpn_plan(
            region="us-east-1", profile="example", stack_name="local-access-review"
        )

        self.assertIn("validate-template", text)
        self.assertIn("create-change-set", text)
        self.assertIn("describe-change-set", text)
        self.assertIn("PAID RESOURCE", text)
        self.assertIn("DO NOT execute", text)
        self.assertNotIn("execute-change-set --", text)
        self.assertNotIn("/Users/", text)

    def test_ssm_plan_is_narrow_remote_host_forwarding(self) -> None:
        text = vpc_paths.render_ssm_plan(
            region="us-east-1",
            profile=None,
            target_env="SSM_MANAGED_NODE_ID",
            remote_host_env="SSM_REMOTE_HOST",
            remote_port=8317,
            local_port=18317,
        )

        self.assertIn("AWS-StartPortForwardingSessionToRemoteHost", text)
        self.assertIn('"localPortNumber":["18317"]', text)
        self.assertIn("supervisor", text.lower())
        self.assertIn("semantic health", text.lower())

    def test_tailscale_plan_requires_forwarding_and_tailnet_approval(self) -> None:
        text = vpc_paths.render_tailscale_plan(vpc_cidr="10.0.0.0/16")

        self.assertIn("net.ipv4.ip_forward", text)
        self.assertIn("--advertise-routes", text)
        self.assertIn("tailnet", text.lower())
        self.assertIn("REQUIRES EXPLICIT AUTHORIZATION", text)


if __name__ == "__main__":
    unittest.main()
