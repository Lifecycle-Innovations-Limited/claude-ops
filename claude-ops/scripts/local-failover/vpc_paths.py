#!/usr/bin/env python3
"""Read-only VPC-path detection and non-executing provisioning plans."""

from __future__ import annotations

import argparse
import ipaddress
import json
import re
import shlex
import subprocess
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any


Runner = Callable[..., Any]
TEMPLATE = Path(__file__).resolve().parent / "plans" / "aws-client-vpn.yaml"
TEMPLATE_ARGUMENT = "file://scripts/local-failover/plans/aws-client-vpn.yaml"


def _run(runner: Runner, argv: Sequence[str]) -> Any | None:
    try:
        result = runner(
            list(argv),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=15,
            check=False,
        )
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        return None
    return result if result.returncode == 0 else None


def _json_output(result: Any | None) -> dict[str, Any] | None:
    if result is None:
        return None
    try:
        value = json.loads(result.stdout)
    except (TypeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _aws_prefix(region: str, profile: str | None) -> list[str]:
    argv = ["aws"]
    if profile:
        argv.extend(["--profile", profile])
    argv.extend(["--region", region])
    return argv


def _client_vpn_detection(
    region: str, profile: str | None, runner: Runner
) -> dict[str, object]:
    prefix = _aws_prefix(region, profile)
    payload = _json_output(
        _run(
            runner,
            [*prefix, "ec2", "describe-client-vpn-endpoints", "--output", "json"],
        )
    )
    if payload is None:
        return {"state": "unavailable"}
    endpoints = payload.get("ClientVpnEndpoints")
    if not isinstance(endpoints, list):
        return {"state": "unknown"}
    available = 0
    associations = 0
    association_state = "checked"
    for endpoint in endpoints:
        if not isinstance(endpoint, dict):
            continue
        status = endpoint.get("Status")
        if isinstance(status, dict) and status.get("Code") == "available":
            available += 1
        endpoint_id = endpoint.get("ClientVpnEndpointId")
        if not isinstance(endpoint_id, str):
            association_state = "partial"
            continue
        target_payload = _json_output(
            _run(
                runner,
                [
                    *prefix,
                    "ec2",
                    "describe-client-vpn-target-networks",
                    "--client-vpn-endpoint-id",
                    endpoint_id,
                    "--output",
                    "json",
                ],
            )
        )
        if target_payload is None:
            association_state = "partial"
            continue
        targets = target_payload.get("ClientVpnTargetNetworks")
        if isinstance(targets, list):
            associations += sum(
                1
                for target in targets
                if isinstance(target, dict)
                and isinstance(target.get("Status"), dict)
                and target["Status"].get("Code") == "associated"
            )
    return {
        "state": "detected",
        "endpoints": len(endpoints),
        "available_endpoints": available,
        "associated_target_networks": associations,
        "association_check": association_state,
    }


def _ssm_detection(
    region: str, profile: str | None, target: str | None, runner: Runner
) -> dict[str, object]:
    prefix = _aws_prefix(region, profile)
    argv = [*prefix, "ssm", "describe-instance-information"]
    if target:
        argv.extend(["--filters", f"Key=InstanceIds,Values={target}"])
    argv.extend(["--output", "json"])
    payload = _json_output(_run(runner, argv))
    if payload is None:
        return {"state": "unavailable"}
    instances = payload.get("InstanceInformationList")
    if not isinstance(instances, list):
        return {"state": "unknown"}
    online = sum(
        1
        for instance in instances
        if isinstance(instance, dict) and instance.get("PingStatus") == "Online"
    )
    return {
        "state": "detected",
        "matching_managed_nodes": len(instances),
        "online_managed_nodes": online,
        "target_filter_applied": bool(target),
    }


def _tailscale_detection(runner: Runner) -> dict[str, object]:
    payload = _json_output(_run(runner, ["tailscale", "status", "--json"]))
    if payload is None:
        return {"state": "unavailable"}
    self_status = payload.get("Self")
    online = (
        payload.get("BackendState") == "Running"
        and isinstance(self_status, dict)
        and self_status.get("Online") is True
    )
    addresses = payload.get("TailscaleIPs")
    return {
        "state": "detected",
        "online": online,
        "address_count": len(addresses) if isinstance(addresses, list) else 0,
    }


def _route_detection(destination: str | None, runner: Runner) -> dict[str, object]:
    if not destination:
        return {"state": "not_requested"}
    result = _run(runner, ["/sbin/route", "-n", "get", destination])
    if result is None:
        return {"state": "unavailable"}
    interface = ""
    for line in result.stdout.splitlines():
        key, separator, value = line.strip().partition(":")
        if separator and key == "interface":
            interface = value.strip()
            break
    match = re.match(r"[A-Za-z]+", interface)
    return {
        "state": "detected" if match else "unknown",
        "interface_class": match.group(0).lower() if match else None,
    }


def detect(
    *,
    region: str,
    profile: str | None,
    ssm_target: str | None,
    route_destination: str | None,
    runner: Runner = subprocess.run,
) -> dict[str, object]:
    """Return identifier-free readiness facts using only read operations."""

    aws_installed = _run(runner, ["aws", "--version"]) is not None
    plugin_installed = _run(runner, ["session-manager-plugin", "--version"]) is not None
    return {
        "schema_version": 1,
        "read_only": True,
        "aws_cli": {"state": "installed" if aws_installed else "unavailable"},
        "session_manager_plugin": {
            "state": "installed" if plugin_installed else "unavailable"
        },
        "client_vpn": _client_vpn_detection(region, profile, runner),
        "ssm": _ssm_detection(region, profile, ssm_target, runner),
        "tailscale": _tailscale_detection(runner),
        "local_route": _route_detection(route_destination, runner),
    }


def _aws_flags(region: str, profile: str | None) -> str:
    profile_flag = f" --profile {shlex.quote(profile)}" if profile else ""
    return f"--region {shlex.quote(region)}{profile_flag}"


def render_client_vpn_plan(
    *, region: str, profile: str | None, stack_name: str
) -> str:
    flags = _aws_flags(region, profile)
    template = shlex.quote(TEMPLATE_ARGUMENT)
    safe_stack_name = shlex.quote(stack_name)
    return f"""AWS Client VPN review plan (renders commands; executes nothing)

PAID RESOURCE / EXPLICIT AUTHORIZATION GATE
- A deployed endpoint incurs an hourly charge for each target-network association.
- Each active client connection incurs a connection-hour charge; public IPv4 and data charges may apply.
- The template requires existing VPC, subnet, security group, ACM server certificate, DNS, and auth identifiers.
- Authentication can be certificate, Directory Service, or SAML. Do not put private keys in parameters.

Safe validation:
aws cloudformation validate-template {flags} --template-body {template}

Safe review-only change set (replace placeholders; this does not deploy):
aws cloudformation create-change-set {flags} \\
  --stack-name {safe_stack_name} \\
  --change-set-name client-vpn-review \\
  --change-set-type CREATE \\
  --template-body {template} \\
  --parameters file://client-vpn-parameters.review.json

aws cloudformation describe-change-set {flags} \\
  --stack-name {safe_stack_name} --change-set-name client-vpn-review

DO NOT execute the change set without separate authorization for hourly cost, certificates,
subnet association, authorization rules, routes, security groups, DNS, and client rollout.
"""


def render_ssm_plan(
    *,
    region: str,
    profile: str | None,
    target_env: str,
    remote_host_env: str,
    remote_port: int,
    local_port: int,
) -> str:
    for name in (target_env, remote_host_env):
        if not re.fullmatch(r"[A-Z_][A-Z0-9_]*", name):
            raise ValueError("environment variable names must be uppercase shell identifiers")
    if not 1 <= remote_port <= 65535 or not 1 <= local_port <= 65535:
        raise ValueError("ports must be from 1 to 65535")
    flags = _aws_flags(region, profile)
    return f"""AWS Systems Manager remote-host port-forward plan (not executed)

This is a narrow per-service path, not a broad laptop VPC route. It requires an online
managed node, IAM permission, Session Manager plugin, SSM Agent 3.1.1374.0+, and managed-node
DNS/network reachability to the remote host. Port-forward payloads are not Session Manager logged.

Supervised tunnel argv/command:
aws ssm start-session {flags} \\
  --target "${{{target_env}}}" \\
  --document-name AWS-StartPortForwardingSessionToRemoteHost \\
  --parameters '{{"host":["'"${{{remote_host_env}}}"'"],"portNumber":["{remote_port}"],"localPortNumber":["{local_port}"]}}'

The failover supervisor may admit this path only after it observed 127.0.0.1:{local_port}
transition from free to bound by its owned child and semantic health succeeds through the tunnel.
"""


def render_tailscale_plan(*, vpc_cidr: str) -> str:
    network = ipaddress.ip_network(vpc_cidr, strict=True)
    safe_cidr = shlex.quote(str(network))
    return f"""Tailscale subnet-router plan (not executed)

REQUIRES EXPLICIT AUTHORIZATION from the host owner and tailnet administrator.
On the approved Linux subnet-router host:
  sudo sysctl -w net.ipv4.ip_forward=1
  printf 'net.ipv4.ip_forward = 1\\n' | sudo tee /etc/sysctl.d/99-tailscale.conf
  sudo tailscale set --advertise-routes={safe_cidr}

Then approve {network} in the tailnet admin console (or an approved autoApprovers policy)
and authorize the intended identities in tailnet access controls. On macOS, verify read-only:
  tailscale status
  /sbin/route -n get <VPC_DESTINATION>

Rollback (also requires explicit authorization): withdraw the advertised route, remove tailnet
approval, restore the prior forwarding setting, and disable this route in failover configuration.
"""


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)
    detection = subcommands.add_parser("detect", help="run identifier-redacted read checks")
    detection.add_argument("--region", required=True)
    detection.add_argument("--profile")
    detection.add_argument("--ssm-target")
    detection.add_argument("--route-destination")

    plans = subcommands.add_parser("plan", help="print commands without running them")
    plan_kind = plans.add_subparsers(dest="plan_kind", required=True)
    client_vpn = plan_kind.add_parser("client-vpn")
    client_vpn.add_argument("--region", required=True)
    client_vpn.add_argument("--profile")
    client_vpn.add_argument("--stack-name", default="local-access-review")
    ssm = plan_kind.add_parser("ssm")
    ssm.add_argument("--region", required=True)
    ssm.add_argument("--profile")
    ssm.add_argument("--target-env", default="SSM_MANAGED_NODE_ID")
    ssm.add_argument("--remote-host-env", default="SSM_REMOTE_HOST")
    ssm.add_argument("--remote-port", type=int, required=True)
    ssm.add_argument("--local-port", type=int, required=True)
    tailscale = plan_kind.add_parser("tailscale")
    tailscale.add_argument("--vpc-cidr", required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.command == "detect":
        result = detect(
            region=args.region,
            profile=args.profile,
            ssm_target=args.ssm_target,
            route_destination=args.route_destination,
        )
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return 0
    if args.plan_kind == "client-vpn":
        print(
            render_client_vpn_plan(
                region=args.region,
                profile=args.profile,
                stack_name=args.stack_name,
            ),
            end="",
        )
    elif args.plan_kind == "ssm":
        print(
            render_ssm_plan(
                region=args.region,
                profile=args.profile,
                target_env=args.target_env,
                remote_host_env=args.remote_host_env,
                remote_port=args.remote_port,
                local_port=args.local_port,
            ),
            end="",
        )
    else:
        print(render_tailscale_plan(vpc_cidr=args.vpc_cidr), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
