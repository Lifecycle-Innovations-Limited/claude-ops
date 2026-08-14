# Local Failover Gateway Design

## Goal

Provide stable loopback endpoints for OpenAI/Anthropic-compatible CLIs and HTTP MCP clients while selecting among pre-provisioned network paths in a fixed order. The gateway must preserve local MCP child services, avoid request duplication, supervise optional per-service tunnels, and expose enough state to diagnose failover without logging credentials or request bodies.

## Scope and ownership

The implementation lives entirely under `claude-ops/scripts/local-failover/` plus failover-specific documentation and tests. It does not edit or signal existing tmux panes, local MCP processes, client configurations, credentials, cloud resources, VPN routes, or tailnet policy. Runtime installation and client cutover are explicit later operator actions.

The model inventory endpoint is used only as an authenticated semantic health check. The gateway never stores, rewrites, aliases, ranks, or refreshes model inventory.

## Architecture

One dependency-free Python daemon owns one or more loopback-only listeners. Each listener has an ordered route set and protocol policy:

```text
CLI -> stable loopback listener -> Cloud edge -> overlay address -> supervised tunnel
MCP -> stable loopback listener -> local aggregate -> optional remote aggregate paths
```

Routes are eligible only when provisioned, their network gate is satisfied, and semantic health is closed. A supervised tunnel route additionally requires a process group started by this daemon, a newly bound local listener whose owning processes all belong to that group, and successful semantic checks through that listener. A pre-existing, raced, or replaced listener is never adopted as proof of tunnel health.

The daemon contains five bounded units:

1. **Configuration** validates loopback binds, safe upstream URLs, environment-only health credentials, timeouts, body limits, and route order.
2. **Health engine** performs authenticated inventory and minimal stream checks for LLM routes and read-only bounded status GETs for MCP routes, classifying missing/invalid health authorization as configuration-unknown rather than provider failure. It never creates a health-check MCP session.
3. **Circuit and selector** apply failure thresholds, exponential cooldown, recovery successes, failback hold time, and active-route stickiness.
4. **Streaming reverse proxy** forwards bytes once, strips hop-by-hop headers, preserves authorization and MCP session headers, and never changes upstream after client-visible bytes.
5. **Tunnel supervisor** starts an argv array without a shell, records and owns only its new process group, verifies a previously free local port became bound exclusively by that group, terminates the whole continuously existing group with bounded TERM/KILL escalation, and restarts with capped backoff.

## Retry and stream safety

Automatic retries are allowed only for `GET`, `HEAD`, and `OPTIONS`, are bounded by configuration, and stop as soon as response bytes become client-visible. `POST`, `PUT`, `PATCH`, and `DELETE` are never replayed. This includes OpenAI/Anthropic generation requests and MCP JSON-RPC calls, regardless of whether a particular method appears read-only.

An interrupted stream is terminated and recorded against the selected route. The gateway does not splice a second upstream into an existing stream. The client can decide whether to issue a new request.

## MCP session behavior

When an upstream returns `Mcp-Session-Id`, the gateway binds that opaque value to the selected route in memory. Requests carrying the session ID stay on that route. If the route becomes unavailable, the gateway returns a reconnect-required `503` rather than sending the session to another upstream. Session bindings expire after a configured idle TTL and are never persisted.

The existing local aggregate and its child services remain unchanged. A future MCP cutover points clients at the new listener while its primary route points at the existing aggregate.

## Observability

Loopback-only `/_failover/status` and `/_failover/metrics` endpoints expose route names, circuit states, health reason codes, transition timestamps, counters, active route, and supervised-tunnel state. They do not expose upstream URLs, headers, credentials, model lists, request bodies, or query strings. Optional state snapshots are atomically written with owner-only permissions and are informational only; stale health is not trusted after restart.

## Optional VPC paths

The implementation provides read-only detection and dry-run planning only:

- **AWS Client VPN** is the managed full-VPC option. AWS documents it as an OpenVPN-based managed client VPN with certificate, Active Directory, or SAML authentication. It requires a server certificate, endpoint, target subnet association, authorization rules, routes, security groups, and DNS design. AWS bills each endpoint association and each active client connection hourly; additional public IPv4, transfer, logging, and optional integration charges can apply. SAML endpoints require the AWS-provided client, including on Apple Silicon. Sources: [AWS Client VPN overview](https://docs.aws.amazon.com/vpn/latest/clientvpn-admin/what-is.html), [authentication](https://docs.aws.amazon.com/vpn/latest/clientvpn-admin/client-authentication.html), [target networks](https://docs.aws.amazon.com/vpn/latest/clientvpn-admin/cvpn-working-target.html), [routes](https://docs.aws.amazon.com/vpn/latest/clientvpn-admin/cvpn-working-routes.html), [authorization](https://docs.aws.amazon.com/vpn/latest/clientvpn-admin/cvpn-working-rules.html), [macOS/OpenVPN clients](https://docs.aws.amazon.com/vpn/latest/clientvpn-user/connect.html), and [pricing](https://aws.amazon.com/vpn/pricing/#AWS_Client_VPN_pricing).
- **Systems Manager port forwarding to a remote host** is the narrow per-service option. It requires the Session Manager plugin, a managed node, IAM authorization, outbound Systems Manager connectivity, and SSM Agent 3.1.1374.0 or later for `AWS-StartPortForwardingSessionToRemoteHost`. Port-forwarded payloads are not available in Session Manager session logs. Sources: [start a remote-host port-forwarding session](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-sessions-start.html#sessions-remote-port-forwarding) and [Session Manager prerequisites](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-prerequisites.html).
- **Tailscale subnet routing** is the simplest existing non-AWS-managed route when an approved subnet router already exists. It requires IP forwarding, route advertisement, route approval (or an approved `autoApprovers` policy), and access rules. Source: [Tailscale subnet routers](https://tailscale.com/kb/1019/subnets).

Site-to-Site VPN connects a VPC to an on-premises network through customer-gateway equipment, and Direct Connect is a physical/partner Ethernet connection; neither is a laptop remote-access design. AWS Verified Access is appropriate for application-level access, not general laptop VPC routing.

## Security model

Trust boundaries are the local client request, route configuration, upstream responses, and optional tunnel child process. Controls are loopback-only binds, strict config validation, TLS verification, no shell execution, bounded client concurrency and request-body deadlines, bounded upstream timeouts, credential references by environment variable name, status redaction, and zero automatic replay of side-effect-capable requests.

The gateway does not create broad network access. A route enters selection only after separate provisioning approval and local semantic validation.

## Test strategy

Deterministic unit tests use a fake clock for circuit transitions, hysteresis, backoff, anti-flapping, selection, MCP affinity, and tunnel ownership. A real local subprocess regression verifies that shutdown removes an exited leader's descendant listener while preserving an unrelated listener. Local mock origins verify authenticated inventory checks, stream cadence, read-only MCP health, fixed route order, bounded client concurrency, stalled-body deadlines, bounded idempotent retries, non-idempotent no-replay, recovery, stream interruption, status redaction, and reconnect-required MCP behavior. No test uses operator credentials, external provider requests, or existing local service ports.

## Rollback

Before a future cutover, copy each client config to a timestamped owner-only backup. Rollback restores those backups and unloads only the failover LaunchAgent. Existing origins, MCP children, and network paths remain untouched, so rollback does not require cloud or tailnet changes.
