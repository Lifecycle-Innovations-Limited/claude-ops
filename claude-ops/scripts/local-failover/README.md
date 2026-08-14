# Local Failover Gateway

This package provides stable loopback HTTP endpoints for LLM-compatible CLIs and MCP HTTP
clients. It selects only pre-provisioned, semantically healthy routes and never changes cloud,
tailnet, client, credential, tmux, or existing service state by itself.

Nothing in this directory is installed or activated by the repository. The example uses unused
high loopback ports. A live install and client cutover require separate authorization and
coordination with the Mac runtime owner.

## Architecture

```text
CLI  -> 127.0.0.1:<stable> -> cloud-edge primary
                              Tailscale direct secondary
                              owned SSM tunnel tertiary

MCP  -> 127.0.0.1:<stable> -> existing local aggregate primary
                              provisioned remote aggregate alternatives
```

The configuration array is the route order. `config.example.json` deliberately orders the LLM
paths as `cloudflare-primary`, `tailscale-secondary`, then `ssm-tertiary`. The two optional routes
ship with `provisioned: false`; an operator must approve and provision them before they can enter
selection.

A route is selectable only when all applicable gates pass:

1. It is explicitly marked provisioned.
2. A network-interface gate confirms the expected local route where configured.
3. A tunnel route was started by this daemon, its port was observed free before startup, its owned
   process is still alive, and every listener on that port belongs to the owned process group.
4. Authenticated semantic health closes the circuit after the configured recovery hysteresis.

The health engine treats `/v1/models` only as a read-only semantic response-shape check and
immediately discards the payload. It does not discover, normalize, persist, rank, refresh, or
rewrite models, aliases, provider inventory, auth, or cache state. An empty inventory does not by
itself admit a route: the separately configured minimal streaming probe must also succeed. Missing
health credentials and HTTP 401/403 are configuration-unknown, not provider failures; stale
unknown health eventually makes the route unavailable.

MCP route health uses the explicitly configured read-only HTTP `GET` `mcp_health_path`, such as the
upstream gateway's `/_failover/status`. Success requires a bounded JSON body that explicitly reports
a ready state or an MCP protocol with an active route. Health probes never create MCP sessions or
send JSON-RPC requests.

## Request and stream safety

- Only `GET`, `HEAD`, and `OPTIONS` are eligible for bounded retry, and never after client-visible
  bytes. The configured maximum includes the first attempt.
- `POST`, `PUT`, `PATCH`, and `DELETE` are sent at most once. This includes model generation and
  every MCP JSON-RPC request, even when its method name appears read-only.
- A stream is never spliced between origins. If an origin interrupts after response headers or
  bytes, the gateway closes the client response and records the route failure.
- Hop-by-hop and proxy-auth headers are stripped. End-to-end authorization and MCP session headers
  are preserved. Request bodies and response payloads are never logged.
- An upstream `Mcp-Session-Id` is pinned in memory to its route. An unknown, expired, or unhealthy
  pinned session receives `503 session_reconnect_required`; it is never migrated to another route.
- Request bodies, health responses, status responses, connect time, and idle time are bounded.
  Client header/body reads also have a deadline, and each listener has a hard concurrent-request
  cap; excess loopback clients receive `503 gateway_overloaded` without allocating another worker.

Circuit breakers start unknown, require stable successes, open after a failure threshold, use
capped exponential cooldown, and require a failback hold. Status and Prometheus-format metrics are
available only on each loopback listener at `/_failover/status` and `/_failover/metrics`. They omit
upstream URLs, model names, credentials, headers, request bodies, and session IDs. Optional state
snapshots are atomic mode-0600 informational files; health starts unknown after every restart.

## Isolated validation

These commands parse configuration and run deterministic mocks only. The tests bind ephemeral or
unused loopback ports and never contact configured providers:

```bash
cd claude-ops
python3 -m json.tool scripts/local-failover/config.example.json >/dev/null
PYTHONPATH=scripts/local-failover python3 -m local_failover check \
  --config scripts/local-failover/config.example.json
python3 -m unittest discover \
  -s scripts/local-failover/tests -p 'test_*.py' -v
python3 -m py_compile scripts/local-failover/local_failover/*.py \
  scripts/local-failover/vpc_paths.py
plutil -lint scripts/local-failover/launchd/com.example.local-failover.plist.template
```

Run the module from `scripts/local-failover` or put that directory on `PYTHONPATH`:

```bash
cd scripts/local-failover
python3 -m local_failover check --config config.example.json
python3 -m local_failover status --config config.example.json
```

`check` never resolves or prints URL environment values. `status` performs only loopback GETs.
`run` starts listeners, health probes, and explicitly enabled owned tunnels, so it is an activation
step and is intentionally not run by repository tests.

## Future macOS installation and rollback (not executed)

The LaunchAgent template contains no credentials. LaunchAgents do not inherit an interactive shell
environment reliably; the runtime owner must approve an existing secret-injection mechanism for the
environment variable names referenced by config. Never write credential values into JSON, plist,
shell history, logs, or this repository.

After isolated validation and explicit installation approval, render a private plist rather than
editing the template:

```bash
set -eu
PACKAGE_ROOT="/absolute/path/to/scripts/local-failover"
PYTHON_BIN="$(command -v python3)"
CONFIG_PATH="$HOME/Library/Application Support/local-failover/config.json"
LOG_DIR="$HOME/Library/Logs/local-failover"
PLIST="$HOME/Library/LaunchAgents/com.example.local-failover.plist"
install -d -m 700 "$(dirname "$CONFIG_PATH")" "$LOG_DIR"
install -m 600 "$PACKAGE_ROOT/config.example.json" "$CONFIG_PATH"
python3 - "$PACKAGE_ROOT" "$PYTHON_BIN" "$CONFIG_PATH" "$LOG_DIR" \
  "$PACKAGE_ROOT/launchd/com.example.local-failover.plist.template" "$PLIST" <<'PY'
import pathlib, sys
from xml.sax.saxutils import escape
root, python, config, logs, source, destination = sys.argv[1:]
text = pathlib.Path(source).read_text()
values = {
    "__PYTHON_BIN__": python,
    "__PACKAGE_ROOT__": root,
    "__CONFIG_PATH__": config,
    "__STDOUT_LOG__": f"{logs}/stdout.log",
    "__STDERR_LOG__": f"{logs}/stderr.log",
}
for token, value in values.items():
    text = text.replace(token, escape(value))
path = pathlib.Path(destination)
path.write_text(text)
path.chmod(0o600)
PY
plutil -lint "$PLIST"
PYTHONPATH="$PACKAGE_ROOT" "$PYTHON_BIN" -m local_failover check --config "$CONFIG_PATH"
```

The following are **activation commands, not validation commands**. They require approval from the
Mac runtime owner after configuration backups and isolated probes:

```bash
# REQUIRES EXPLICIT AUTHORIZATION
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/com.example.local-failover"
```

Before client cutover, make owner-only backups for every client independently:

```bash
umask 077
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
cp -p "$CLIENT_CONFIG" "$CLIENT_CONFIG.before-local-failover.$stamp"
```

Only after a loopback status check and a real read-only client smoke test should an authorized
operator change a client base URL. Rollback restores each exact backup and unloads only this agent:

```bash
# REQUIRES EXPLICIT AUTHORIZATION
launchctl bootout "gui/$(id -u)" "$PLIST"
cp -p "$CLIENT_CONFIG.before-local-failover.$stamp" "$CLIENT_CONFIG"
```

The gateway never modifies existing MCP child services. Rollback therefore leaves their original
ports and processes untouched.

## Optional VPC attachment paths

Run identifier-redacted detection only when approved to use the already-authenticated CLIs:

```bash
python3 scripts/local-failover/vpc_paths.py detect \
  --region "$AWS_REGION" \
  --route-destination "$VPC_DESTINATION"
```

Detection invokes only CLI version/status, `describe-client-vpn-endpoints`,
`describe-client-vpn-target-networks`, `describe-instance-information`, `tailscale status --json`,
and local route inspection. It reports counts and coarse state; it never prints resource IDs,
tailnet names, addresses, command stderr, or credential locations. It does not start sessions.

### A. AWS Client VPN: managed full-VPC laptop route

AWS Client VPN is an OpenVPN-based managed remote-access service. AWS documents certificate
(mutual), AWS Managed Microsoft AD, and SAML federated authentication; every endpoint also needs an
ACM server certificate. A production design requires:

- a non-overlapping client CIDR and split/full-tunnel decision;
- endpoint creation and at least one target subnet association;
- authorization rules distinct from routes;
- VPC and additional destination routes as needed;
- existing security groups and reachable DNS servers;
- certificate lifecycle or AD/SAML configuration and a macOS client rollout;
- connection logging and retention decisions.

The managed convenience has the broadest route scope and largest blast radius of these options.
Least-privilege authorization rules, narrow security groups, split tunneling, MFA-capable user auth,
and DNS testing are important. SAML uses the AWS-provided client; OpenVPN-compatible client choices
depend on the selected auth mode.

Client VPN is paid. AWS bills endpoint association-hours and active client connection-hours; public
IPv4, data transfer, logging, and related services can add cost. The official pricing page currently
illustrates US East (Ohio) with one association at $0.10/hour and ten connections totaling
$0.50/hour, but rates vary by Region and can change—review the current pricing page and a change set
before authorization.

The repository template is review-only:

```bash
python3 scripts/local-failover/vpc_paths.py plan client-vpn \
  --region "$AWS_REGION" --stack-name local-access-review
```

It prints exact `validate-template`, `create-change-set`, and `describe-change-set` commands around
`plans/aws-client-vpn.yaml`. A change set does not deploy. Executing it would create an endpoint,
association, authorization rule, and optional route and therefore needs separate paid/network/
security approval. The template consumes existing certificates and security groups; it does not
create or alter either.

Rollback after a real deployment is destructive and must be separately approved. CloudFormation
should first preview deletion impact. The exact final operation is:

```bash
# ⚠ REQUIRES EXPLICIT CONFIRMATION; DO NOT RUN AS PART OF DETECTION/PLANNING
aws cloudformation delete-stack --region "$AWS_REGION" --stack-name "$STACK_NAME"
```

Exported client profiles, DNS, security groups, certificates, and identity-provider objects have
independent lifecycles and must not be removed merely because the endpoint stack is rolled back.

Official AWS guidance:

- [What is AWS Client VPN?](https://docs.aws.amazon.com/vpn/latest/clientvpn-admin/what-is.html)
- [Client authentication](https://docs.aws.amazon.com/vpn/latest/clientvpn-admin/client-authentication.html)
- [Mutual authentication](https://docs.aws.amazon.com/vpn/latest/clientvpn-admin/client-auth-mutual-enable.html)
- [SAML federation](https://docs.aws.amazon.com/vpn/latest/clientvpn-admin/federated-authentication.html)
- [Endpoint workflow](https://docs.aws.amazon.com/vpn/latest/clientvpn-admin/cvpn-working-endpoints.html)
- [Target networks](https://docs.aws.amazon.com/vpn/latest/clientvpn-admin/cvpn-working-target.html)
- [Routes](https://docs.aws.amazon.com/vpn/latest/clientvpn-admin/cvpn-working-routes.html)
- [Authorization rules](https://docs.aws.amazon.com/vpn/latest/clientvpn-admin/cvpn-working-rules.html)
- [Security groups](https://docs.aws.amazon.com/vpn/latest/clientvpn-admin/client-vpn-security-groups.html)
- [Best practices](https://docs.aws.amazon.com/vpn/latest/clientvpn-admin/what-is-best-practices.html)
- [macOS and other clients](https://docs.aws.amazon.com/vpn/latest/clientvpn-user/connect.html)
- [Current AWS VPN pricing](https://aws.amazon.com/vpn/pricing/)

### B. Systems Manager: narrow per-service tunnel

`AWS-StartPortForwardingSessionToRemoteHost` forwards one local port through an SSM managed node to
a remote host reachable from that node. It does not provide a broad laptop route. Current AWS
guidance requires SSM Agent 3.1.1374.0 or later for remote-host forwarding, the Session Manager
plugin, IAM permission, managed-node Systems Manager connectivity, and remote DNS/network access.
The remote host itself need not be managed by SSM. Port-forward payloads are not available in
Session Manager session logs, reducing content auditability.

Render, but do not execute, the exact command:

```bash
python3 scripts/local-failover/vpc_paths.py plan ssm \
  --region "$AWS_REGION" --remote-port 8317 --local-port 18317
```

An enabled SSM route is still unavailable until the gateway owns the tunnel process group, observed
its port transition, verifies every listener on the port belongs to that process group, and passes
authenticated semantic health through it. A bind race or listener replacement revokes readiness
and signals only the recorded process group. Process exit removes the gate immediately; if an owned
descendant still holds the listener, the supervisor terminates the continuously existing group with
TERM and bounded KILL escalation. Restart uses capped backoff. A pre-existing listener is reported
as a conflict and never adopted or killed.

Official AWS guidance:

- [Start Session Manager sessions and remote-host forwarding](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-sessions-start.html)
- [Session Manager prerequisites](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-prerequisites.html)
- [Session Manager overview](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager.html)
- [`aws ssm start-session`](https://docs.aws.amazon.com/cli/latest/reference/ssm/start-session.html)

### C. Tailscale subnet router: simplest existing overlay route

When Tailscale already connects the laptop and an approved VPC host, a subnet router is usually the
simplest non-AWS-managed broad route. The router host must enable IP forwarding, advertise the VPC
CIDR, receive tailnet route approval (or an approved `autoApprovers` rule), and have access controls
that permit the intended identities. These are host and shared-tailnet mutations, so this repository
only prints a dry-run plan:

```bash
python3 scripts/local-failover/vpc_paths.py plan tailscale --vpc-cidr 10.0.0.0/16
```

The failover route remains `provisioned: false` until those approvals exist and local route plus
semantic health checks pass. Rollback withdraws and unapproves the route and restores forwarding;
each step requires the same owners' authorization.

Official guidance: [Tailscale subnet routers](https://tailscale.com/kb/1019/subnets).

## Paths that are not laptop VPC routing

AWS Site-to-Site VPN connects networks through customer-gateway infrastructure, and Direct Connect
is a physical/partner private connection. Neither is an individual macOS laptop solution. AWS
Verified Access can protect application-level access without a VPN, but it is not a general laptop
route into a VPC and is not used as a gateway failover path here.

## Permissions still required for live end-to-end proof

Repository tests prove local forwarding and simulated path failures. A live claim that existing CLIs
continue across the real cloud-edge, Tailscale, and SSM paths still requires all of the following:

1. Mac runtime-owner approval to render and bootstrap the LaunchAgent on unused production ports.
2. Approval for an existing credential injector to expose only named health variables to the agent.
3. Tailscale host, route-advertisement, route-approval, and access-control approval if that path does
   not already exist.
4. SSM managed-node/IAM confirmation before enabling the owned tunnel.
5. Separate cost/network/security authorization before any Client VPN change set is executed.
6. Per-client backup, base-URL cutover approval, and a rollback window.

No permission in this list is implied by repository review or passing tests.
