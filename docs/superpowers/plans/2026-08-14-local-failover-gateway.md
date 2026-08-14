# Local Failover Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deterministically verify loopback-only CLI and MCP failover listeners with health-gated network paths and no automatic side-effect request replay.

**Architecture:** A dependency-free Python package separates validated configuration, circuit/selection state, semantic health probes, tunnel ownership, and byte-stream proxying. A read-only VPC helper reports existing Client VPN, SSM, and Tailscale readiness and prints provisioning plans without executing them.

**Tech Stack:** Python 3.11+ standard library, `unittest`, local HTTP mock servers, macOS launchd template, AWS CLI and Tailscale CLI as optional read-only detector dependencies.

## Global Constraints

- Work only in `claude-ops/scripts/local-failover/` and failover-specific docs/tests.
- Bind listeners to loopback; never modify live services, tmux panes, client configs, credentials, AWS resources, or tailnet state.
- Use `/v1/models` only for authenticated semantic health and never persist its payload.
- Treat health-check `401`/`403` or missing health authorization as configuration-unknown, not provider failure.
- Never automatically replay `POST`, `PUT`, `PATCH`, or `DELETE`, including MCP JSON-RPC and model generation calls.
- Admit the SSM route only when the daemon owns the tunnel process group, observed the configured local port transition from free to exclusively group-owned, and semantic health passes.

---

### Task 1: Validated configuration and circuit state

**Files:**
- Create: `claude-ops/scripts/local-failover/local_failover/config.py`
- Create: `claude-ops/scripts/local-failover/local_failover/circuit.py`
- Create: `claude-ops/scripts/local-failover/tests/test_config_circuit.py`

**Interfaces:**
- Produces: `load_config(path: Path) -> GatewayConfig`, `CircuitBreaker`, `RouteRuntime`, `RouteSelector.choose(session_route: str | None, now: float) -> RouteRuntime | None`.
- Consumes: JSON configuration and an injected monotonic clock value.

- [ ] **Step 1: Write failing validation and state-machine tests**

```python
def test_listener_rejects_non_loopback_bind(self):
    raw = valid_config()
    raw["listeners"][0]["host"] = "0.0.0.0"
    with self.assertRaisesRegex(ConfigError, "loopback"):
        parse_config(raw)

def test_circuit_requires_stable_recovery_before_failback(self):
    breaker = CircuitBreaker(policy(), now=0)
    breaker.observe_failure(0, "connect")
    breaker.observe_failure(1, "connect")
    self.assertFalse(breaker.available(1))
    breaker.observe_success(11)
    breaker.observe_success(12)
    self.assertFalse(breaker.available(12))
    breaker.observe_success(13)
    self.assertTrue(breaker.available(18))
```

- [ ] **Step 2: Run tests and verify RED**

Run: `python3 -m unittest discover -s scripts/local-failover/tests -p 'test_*.py' -v`

Expected: import failure because `local_failover.config` and `local_failover.circuit` do not exist.

- [ ] **Step 3: Implement immutable dataclasses, URL/bind validation, and breaker transitions**

Validate environment variable names, URL schemes/credentials/query fragments, overlay HTTP opt-in, body/time bounds, unique route names, and loopback listeners. Implement `unknown`, `closed`, `open`, and `half_open` states with threshold opening, capped exponential cooldown, recovery success count, and stable hold time.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `python3 -m unittest scripts/local-failover/tests/test_config_circuit.py -v`

Expected: all configuration and state-machine tests pass without sleeps.

- [ ] **Step 5: Commit**

```bash
git add claude-ops/scripts/local-failover/local_failover/{config,circuit}.py \
  claude-ops/scripts/local-failover/tests/test_config_circuit.py
git commit -m "feat: add failover policy state machine"
```

### Task 2: Semantic health and supervised tunnel ownership

**Files:**
- Create: `claude-ops/scripts/local-failover/local_failover/health.py`
- Create: `claude-ops/scripts/local-failover/local_failover/tunnel.py`
- Create: `claude-ops/scripts/local-failover/tests/test_health_tunnel.py`

**Interfaces:**
- Consumes: `RouteConfig`, `RouteRuntime`, environment mapping, injected HTTP connector/process factory/listener checker.
- Produces: `ProbeResult(kind, reason, latency_ms)`, `SemanticHealth.probe(route)`, and `TunnelSupervisor.tick(now) -> TunnelStatus`.

- [ ] **Step 1: Write failing semantic and ownership tests**

```python
def test_missing_or_rejected_health_auth_is_unknown(self):
    result = health.probe_models(route, env={})
    self.assertEqual(result.kind, "unknown")
    result = health.classify_models_response(401, b"")
    self.assertEqual(result.kind, "unknown")

def test_tunnel_will_not_adopt_preexisting_listener(self):
    supervisor = TunnelSupervisor(config, listener_checker=lambda *_: True)
    self.assertEqual(supervisor.tick(0).state, "conflict")
    self.assertEqual(process_factory.calls, [])
```

- [ ] **Step 2: Run tests and verify RED**

Run: `python3 -m unittest scripts/local-failover/tests/test_health_tunnel.py -v`

Expected: import failure because the health and tunnel modules do not exist.

- [ ] **Step 3: Implement bounded authenticated probes and no-shell tunnel supervision**

Inventory success requires a JSON object with a list-valued `data` field but discards the list immediately. Streaming success requires SSE/NDJSON content, a first event before the configured deadline, multiple cadence events or a terminal marker, a byte cap, and no response-body logging. MCP health uses a bounded read-only status GET and never creates a protocol session. The tunnel starts only from an unbound port, uses `shell=False` and its own process group, verifies the child remains alive while every listener on the port belongs to that group, and applies capped restart backoff.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `python3 -m unittest scripts/local-failover/tests/test_health_tunnel.py -v`

Expected: all health classification, cadence, listener-conflict, process-exit, and restart-backoff tests pass.

- [ ] **Step 5: Commit**

```bash
git add claude-ops/scripts/local-failover/local_failover/{health,tunnel}.py \
  claude-ops/scripts/local-failover/tests/test_health_tunnel.py
git commit -m "feat: supervise semantic route health"
```

### Task 3: Streaming gateway and MCP session affinity

**Files:**
- Create: `claude-ops/scripts/local-failover/local_failover/proxy.py`
- Create: `claude-ops/scripts/local-failover/local_failover/main.py`
- Create: `claude-ops/scripts/local-failover/local_failover/__init__.py`
- Create: `claude-ops/scripts/local-failover/tests/test_gateway_integration.py`

**Interfaces:**
- Consumes: validated `GatewayConfig`, selector/runtime state, semantic health, tunnel supervisors.
- Produces: `GatewayService.start()`, `GatewayService.shutdown()`, loopback HTTP listeners, `/_failover/status`, and `/_failover/metrics`.

- [ ] **Step 1: Write failing local integration tests**

```python
def test_post_is_sent_once_when_selected_origin_interrupts(self):
    response = self.request("POST", "/v1/messages", body=b"{}")
    self.assertIn(response.status, (502, 503))
    self.assertEqual(primary.request_count, 1)
    self.assertEqual(secondary.request_count, 0)

def test_mcp_session_does_not_migrate_between_routes(self):
    session_id = self.initialize_mcp_on_primary()
    primary.mark_unhealthy()
    response = self.mcp_request(session_id)
    self.assertEqual(response.status, 503)
    self.assertEqual(secondary.request_count, 0)
```

- [ ] **Step 2: Run tests and verify RED**

Run: `python3 -m unittest scripts/local-failover/tests/test_gateway_integration.py -v`

Expected: import failure because the proxy and main modules do not exist.

- [ ] **Step 3: Implement bounded forwarding and status**

Strip hop-by-hop and proxy credentials, replace `Host`, preserve end-to-end authorization and MCP session headers, enforce body limits, client read deadlines, and per-listener concurrency caps, and stream with `Connection: close` when no upstream length exists. Retry only idempotent methods and only before client-visible bytes. Bind returned MCP session IDs to a route with idle expiry. Persist redacted informational status atomically with mode `0600`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `python3 -m unittest scripts/local-failover/tests/test_gateway_integration.py -v`

Expected: tests pass for ordered failure, bounded GET retry, POST no-replay, interrupted stream no-splice, recovery, anti-flapping, MCP reconnect-required, and redacted status.

- [ ] **Step 5: Commit**

```bash
git add claude-ops/scripts/local-failover/local_failover \
  claude-ops/scripts/local-failover/tests/test_gateway_integration.py
git commit -m "feat: add session-safe local failover proxy"
```

### Task 4: Read-only VPC detection, dry-run plans, launchd template, and operations guide

**Files:**
- Create: `claude-ops/scripts/local-failover/vpc_paths.py`
- Create: `claude-ops/scripts/local-failover/config.example.json`
- Create: `claude-ops/scripts/local-failover/launchd/com.example.local-failover.plist.template`
- Create: `claude-ops/scripts/local-failover/plans/aws-client-vpn.yaml`
- Create: `claude-ops/scripts/local-failover/README.md`
- Create: `claude-ops/scripts/local-failover/tests/test_vpc_paths.py`

**Interfaces:**
- Produces: `vpc_paths.py detect` (read-only, identifier-redacted JSON) and `vpc_paths.py plan {client-vpn,ssm,tailscale}` (stdout only).
- Consumes: explicit region/profile/target/subnet/CIDR placeholders; it never reads credential files or executes plan output.

- [ ] **Step 1: Write failing detection and dry-run tests**

```python
def test_detect_invokes_only_allowlisted_read_operations(self):
    detect(runner=fake_runner)
    self.assertNotIn("create", " ".join(fake_runner.argv).lower())
    self.assertNotIn("modify", " ".join(fake_runner.argv).lower())

def test_plans_print_without_executing(self):
    text = render_ssm_plan(plan_args())
    self.assertIn("AWS-StartPortForwardingSessionToRemoteHost", text)
    self.assertEqual(fake_runner.calls, [])
```

- [ ] **Step 2: Run tests and verify RED**

Run: `python3 -m unittest scripts/local-failover/tests/test_vpc_paths.py -v`

Expected: import failure because `vpc_paths.py` does not exist.

- [ ] **Step 3: Implement redacted detection and exact non-executing plans**

Use only `describe-client-vpn-endpoints`, `describe-client-vpn-target-networks`, `describe-instance-information`, local CLI version/status, and route inspection. Render Client VPN CloudFormation validation/change-set commands, SSM remote-host forwarding argv, Tailscale IP-forwarding/advertise/approval steps, cost implications, rollback, and explicit authorization gates.

- [ ] **Step 4: Run focused tests and documentation checks**

Run: `python3 -m unittest scripts/local-failover/tests/test_vpc_paths.py -v`

Run: `python3 -m json.tool scripts/local-failover/config.example.json >/dev/null`

Run: `plutil -lint scripts/local-failover/launchd/com.example.local-failover.plist.template`

Expected: tests pass, JSON parses, and the plist template is structurally valid.

- [ ] **Step 5: Commit**

```bash
git add claude-ops/scripts/local-failover
git commit -m "docs: add failover deployment and VPC plans"
```

### Task 5: Full isolated verification and review artifact

**Files:**
- Modify: `claude-ops/tests/run-all.sh`
- Create: `claude-ops/tests/test-local-failover.sh`
- Create outside Git: review patch generated from the exact base commit.

**Interfaces:**
- Consumes: all failover modules and fixtures.
- Produces: one repository test-suite entry and a patch with branch/base/head provenance.

- [ ] **Step 1: Add a shell suite that invokes the deterministic Python tests and static validators**

```bash
python3 -m unittest discover -s "$ROOT/scripts/local-failover/tests" -p 'test_*.py' -v
python3 -m json.tool "$ROOT/scripts/local-failover/config.example.json" >/dev/null
```

- [ ] **Step 2: Run focused and repository verification**

Run: `bash tests/test-local-failover.sh`

Run: `npm run lint`

Run: `npm test`

Run: `bash tests/run-all.sh`

Expected: all failover tests, static checks, lint, secret scan, and repository suites pass without touching external or existing local ports.

- [ ] **Step 3: Verify source safety and worktree scope**

Run: `git diff --check origin/main...HEAD`

Run: `bash tests/test-no-secrets.sh`

Run: `git status --short`

Expected: no whitespace errors, no secret/PII findings, and only intended failover files before the final commit.

- [ ] **Step 4: Commit and create the review artifact**

```bash
git add claude-ops/tests/run-all.sh claude-ops/tests/test-local-failover.sh
git commit -m "test: verify local failover scenarios"
git format-patch --stdout origin/main..HEAD > ../local-failover-gateway.patch
```

- [ ] **Step 5: Record exact provenance**

Run: `git rev-parse origin/main HEAD && git branch --show-current && shasum -a 256 ../local-failover-gateway.patch`

Expected: exact base/head SHAs, branch name, and patch checksum are available for the completion report.
