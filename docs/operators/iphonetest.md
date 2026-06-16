# `/iphonetest` operator guide — live tunnel drive

Authoritative reference for a Claude session driving a real iPhone on AWS Device Farm
through `/iphonetest --mode tunnel`. Pre-empts every billing-leak, every silent-hang,
and every Appium-extension surprise that has been observed live.

- Upstream slash-command:
  `your-org/my-project` → `.claude/commands/iphonetest.md`
  ([file](https://github.com/your-org/my-project/blob/main/.claude/commands/iphonetest.md))
- Driver script: `my-project/scripts/devicefarm/iphonetest.py` → hands off to
  `tunnel.py` for `--mode tunnel`. This guide documents the **JSON-RPC surface
  of `tunnel.py` as it exists today**, verified against
  [`tunnel.py @ 22cf0cac`](https://github.com/your-org/my-project/blob/22cf0cac5d9b88d066b4badd94b59d480be5285e/scripts/devicefarm/tunnel.py)
  (my-project [PR #6174](https://github.com/your-org/my-project/pull/6174),
  merged 2026-05-29). When the surface drifts, update this file and re-pin the SHA.
- Device Farm API surface:
  [`CreateRemoteAccessSession`](https://docs.aws.amazon.com/devicefarm/latest/APIReference/API_CreateRemoteAccessSession.html).
- Appium driver: `appium-xcuitest-driver` —
  [execute-methods reference](https://appium.github.io/appium-xcuitest-driver/latest/reference/execute-methods/).
  Latest upstream release at time of writing is **v11.7.4 (2026-05-28)**; the
  driver bundled in AWS Device Farm's managed Appium server lags upstream
  (see the "What works vs. what's broken" matrix below).

---

## 1. What `/iphonetest` does

`/iphonetest` is the single entrypoint for driving a real iPhone on AWS Device
Farm from a Claude session. It auto-resolves the latest My-Project staging (or
production) IPA, uploads it to Device Farm, then — depending on `--mode` —
either runs an autonomous Appium + Claude agentic loop (`walkthrough` /
`explore`) or holds open one remote-access session + one Appium WebDriver
connection that an operating agent drives turn-by-turn (`tunnel`). All modes
auto-stop the session on exit so a crashed run cannot leak billing minutes.
Source-of-truth: `my-project/.claude/commands/iphonetest.md`.

## 2. Modes

| `--mode`                                                                                  | Shape                                                                                   | When to use                                         |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `tunnel` **(default since [PR #6172](https://github.com/your-org/my-project/pull/6172))** | Interactive REPL or JSON-RPC over stdio; one session held open across many commands     | An operating Claude driving the device turn-by-turn |
| `walkthrough`                                                                             | Autonomous loop with the built-in My-Project-QA goal (visit every tab, screenshot each) | Smoke a fresh build                                 |
| `explore`                                                                                 | Autonomous loop with operator-supplied `--goal`                                         | Single user-observable outcome, hands-off           |

> PR #6172 (merged 2026-05-29 17:48 UTC) flipped the default from `walkthrough`
> to `tunnel`. Prior to that, you had to type `--mode tunnel` explicitly. Today,
> bare `/iphonetest` lands you in interactive tunnel mode.

**`tunnel` is the canonical mode for an operating Claude.** Walkthrough/Explore
are for fire-and-forget runs where no human or agent is steering. The rest of
this guide is about tunnel.

### 2a. Interaction mode on the AWS side

`tunnel.py` always opens a Device Farm remote-access session with
`interactionMode="NO_VIDEO"`. The AWS API exposes three values —
`INTERACTIVE | NO_VIDEO | VIDEO_ONLY` — but only **`NO_VIDEO`** returns a
usable `remoteDriverEndpoint` (HTTPS managed Appium server) suitable for an
Appium WebDriver client. `INTERACTIVE` mode exposes only `interactiveEndpoint`,
which is a WSS video stream meant for a human's browser and is incompatible
with the urllib3-based Appium Python client
(`URLSchemeUnknown('wss')`). The `interactionMode` parameter is marked
deprecated in the AWS API reference — `NO_VIDEO` continues to work and is the
only mode `tunnel.py` will ever request.

Source quote from
[`CreateRemoteAccessSession`](https://docs.aws.amazon.com/devicefarm/latest/APIReference/API_CreateRemoteAccessSession.html):

> _This parameter has been deprecated. The interaction mode of the remote
> access session. … Valid Values: `INTERACTIVE | NO_VIDEO | VIDEO_ONLY`._

And the verbatim selection logic from `tunnel.py:Tunnel.start`:

```python
# Device Farm exposes two endpoints when interactionMode=NO_VIDEO:
#   endpoints.remoteDriverEndpoint -> HTTPS managed Appium server
#   endpoints.interactiveEndpoint  -> WSS video stream (browser-only)
# The top-level `endpoint` field is the WSS stream and is
# incompatible with the urllib3-based Appium Python client
# (URLSchemeUnknown('wss')).
endpoints = info.get("endpoints") or {}
self.endpoint = (
    endpoints.get("remoteDriverEndpoint")
    or info.get("endpoint")
    or info.get("hostAddress")
    or ""
)
```

## 3. Pre-flight checklist

Run these in order before invoking the command. Abort if any fails.

```bash
# 1. AWS Device Farm project visible (us-west-2 only)
aws devicefarm list-projects --region us-west-2 \
  --query 'projects[].name' --output text
#   → expect: My-Project-iOS-E2E

# 2. Doppler secrets present
doppler secrets --project my-project --config dev_local --only-names \
  | grep -E "EAS_ACCESS_TOKEN|EXPO_TOKEN|DEVICEFARM_PROJECT_ARN|BEDROCK_AWS"

# 3. Python deps
pip show boto3 Appium-Python-Client anthropic | grep -E "^Name|^Version"
#   missing? → pip install -r scripts/devicefarm/requirements.txt

# 4. No orphan sessions currently billing
python3 scripts/devicefarm/list-sessions.py
#   any RUNNING / SCHEDULING listed? → stop them BEFORE you start another:
python3 scripts/devicefarm/stop-session.py --all-active
```

## 4. JSON-RPC command catalogue

`tunnel.py --json` reads one JSON object per stdin line and writes one JSON
response per stdout line. The full handlers dict from `tunnel.py:jsonrpc`
(quoted verbatim from my-project@`22cf0cac5d9b88d066b4badd94b59d480be5285e`):

```python
handlers: dict[str, Any] = {
    "start": lambda m: t.start(
        app_arn=m.get("app_arn"), device_arn=m.get("device_arn")
    ),
    "screenshot": lambda m: t.screenshot(m.get("path")),
    "tap": lambda m: t.tap(float(m["x"]), float(m["y"])),
    "tap_text": lambda m: t.tap_text(m["text"]),
    "swipe": _swipe,
    "type": lambda m: t.type_text(m["text"], submit=bool(m.get("submit", False))),
    "press": lambda m: t.press(m["button"]),
    "launch_app": lambda m: t.launch_app(m.get("bundle_id")),
    "wait": lambda m: time.sleep(float(m["seconds"])),
    "status": lambda m: t.status(),
    "stop": _stop,
}
```

`quit` / `exit` are handled separately and trigger the cleanup callback before
acknowledging.

Every command below returns `{"ok": true, ...}` on success or
`{"ok": false, "error": "..."}` on failure. Field reads are by **name** (not
position) so wire order can never swap `tap`'s `x`/`y` or turn `--submit` into
typed text.

### `start`

Reserve a device. Auto-runs at script startup unless `--no-autostart` is
passed. Call explicitly only after a manual `stop`. With `/iphonetest --mode
tunnel`, the IPA ARN is already injected by the orchestrator — you usually do
not call `start` yourself.

```json
{
  "cmd": "start",
  "app_arn": "arn:aws:devicefarm:us-west-2:...:upload/...",
  "device_arn": "arn:aws:devicefarm:us-west-2::device/..."
}
```

Response:

```json
{
  "ok": true,
  "session_arn": "arn:aws:devicefarm:...",
  "device": "Apple iPhone 17 Pro",
  "endpoint": "https://...",
  "width": 402,
  "height": 874,
  "artifacts": "artifacts/devicefarm-tunnel/20260529-180000-abcd1234"
}
```

`session_arn` and the screen dimensions are what you reference for the rest of
the run.

### `screenshot`

Capture a PNG. Default path is `artifacts/devicefarm-tunnel/<sess>/NNNN.png`
(auto-incremented index). Use an explicit `path` when you want a stable
filename you'll `Read` next turn.

```json
{ "cmd": "screenshot", "path": "artifacts/iphonetest/run/step-01.png" }
```

Response: `{"ok":true,"path":"...","width":402,"height":874}`.

### `tap`

Tap at point coordinates. Coordinates are in **points** (matches `width` /
`height` from `start` / `screenshot`), not pixels.

```json
{ "cmd": "tap", "x": 201, "y": 612 }
```

### `tap_text`

Find an element by accessibility label / name / value and tap its center.
Tries exact predicate match first, then `CONTAINS`.

```json
{ "cmd": "tap_text", "text": "Continue with Apple" }
```

Response includes the matched predicate and rect:

```json
{
  "ok": true,
  "matched": "label == \"Continue with Apple\" OR name == \"Continue with Apple\" OR value == \"Continue with Apple\"",
  "rect": { "x": 40, "y": 596, "width": 322, "height": 56 }
}
```

Quoted verbatim from `tunnel.py:Tunnel.tap_text`:

```python
predicates = [
    f'label == "{escaped}" OR name == "{escaped}" OR value == "{escaped}"',
    f'label CONTAINS "{escaped}" OR name CONTAINS "{escaped}" OR value CONTAINS "{escaped}"',
]
```

Fails with `No element matched text '...'` if neither predicate hits. See
gotcha §6.2 for the iOS-system-UI workaround.

### `swipe`

Two forms — direction (convenience) and coordinate (precise).

Direction form (60% screen-distance swipe from center):

```json
{ "cmd": "swipe", "direction": "up", "duration_ms": 400 }
```

`direction` ∈ `{up,down,left,right}`.

Coordinate form (raw drag):

```json
{
  "cmd": "swipe",
  "x1": 201,
  "y1": 700,
  "x2": 201,
  "y2": 200,
  "duration_ms": 600
}
```

Both compile down to `mobile: dragFromToForDuration` on the driver.

### `type`

Send keys to whichever field is focused. `submit: true` appends a newline
(send-keys `"\n"` on the focused element) after the text lands.

```json
{ "cmd": "type", "text": "hello Anna", "submit": false }
```

Since my-project@`22cf0cac5d9b88d066b4badd94b59d480be5285e`, `type_text` cascades
through the same four strategies `explore.py:execute_action` uses, in this
order (verbatim from `tunnel.py:Tunnel.type_text`):

1. Focused element (`AppiumBy.IOS_PREDICATE, "hasKeyboardFocus == 1"`) →
   `set_value(text)`
2. Same focused element → `send_keys(text)`
3. First-visible TextField or SecureTextField (predicate
   `(type == 'XCUIElementTypeTextField' OR type == 'XCUIElementTypeSecureTextField') AND visible == 1`,
   sorted top-left first) → tap, then `set_value`, falling back to
   `send_keys` on `set_value` failure
4. `mobile: keys` (last resort — usually fails on Device Farm; kept for
   local Appium / simulator hosts)

The first three strategies are why **`type` now works on app-rendered My-Project
UI without first having to focus the field manually** — see the matrix in §5
and gotcha §6.1 for what's still broken (iOS Springboard / Spotlight system
search fields).

### `press`

Hardware-button press. Valid values:
`home | lock | volumeup | volumedown`.

```json
{ "cmd": "press", "button": "home" }
```

### `launch_app`

Launch (or bring to foreground) an app by bundle id. Device Farm does NOT
auto-launch the freshly-installed IPA after `start` — the device lands on
Springboard. This command is the canonical recovery; call it once right
after `start`. Added in my-project [PR #6174](https://github.com/your-org/my-project/pull/6174)
(merged 2026-05-29, SHA `22cf0cac5d9b88d066b4badd94b59d480be5285e`).

Explicit bundle id form:

```json
{ "cmd": "launch_app", "bundle_id": "com.staging.my-project" }
```

Auto-resolve form (`bundle_id` omitted — `tunnel.py` reads the IPA's
`package_name` field out of the upload metadata Device Farm holds against
the `app_arn` cached at `start` time, via
`df.get_upload(arn=app_arn)["upload"]["metadata"]["package_name"]`):

```json
{ "cmd": "launch_app" }
```

Response on success:

```json
{ "ok": true, "bundle_id": "com.staging.my-project", "method": "activateApp" }
```

`method` is `activateApp` when `mobile: activateApp` succeeds, or `launchApp`
when `tunnel.py` falls back to the older `mobile: launchApp` (kept for older
Appium driver builds). Quoted verbatim from `tunnel.py:Tunnel.launch_app`:

```python
try:
    self.driver.execute_script("mobile: activateApp", {"bundleId": bundle})
    return {"ok": True, "bundle_id": bundle, "method": "activateApp"}
except Exception as exc_activate:
    try:
        self.driver.execute_script("mobile: launchApp", {"bundleId": bundle})
        return {"ok": True, "bundle_id": bundle, "method": "launchApp"}
    except Exception as exc_launch:
        return {
            "ok": False,
            "error": f"activateApp: {exc_activate!r} | launchApp: {exc_launch!r}",
        }
```

Error paths:

- Called before `start` (no Appium driver yet):
  `{"ok": false, "error": "session not started"}`.
- No `bundle_id` and no cached `app_arn`:
  `{"ok": false, "error": "no bundle_id provided and no app_arn cached on the session"}`.
- IPA upload metadata is missing or has no `package_name`:
  `{"ok": false, "error": "upload metadata has no \`package_name\`; pass bundle_id explicitly"}`
  (or a sibling error covering "no metadata" / "metadata is not valid JSON").
- Both `mobile: activateApp` and `mobile: launchApp` throw:
  `{"ok": false, "error": "activateApp: <repr> | launchApp: <repr>"}`.

### `wait`

Sleep without sending anything to the device. Use this to let an animation
or network call settle before the next screenshot.

```json
{ "cmd": "wait", "seconds": 2 }
```

### `status`

Report session liveness, device name, elapsed seconds, and screen size.

```json
{ "cmd": "status" }
```

Response when running: `{"ok":true,"running":true,"session_arn":"...","device":"Apple iPhone 17 Pro","elapsed_sec":143,"width":402,"height":874,"artifacts":"artifacts/devicefarm-tunnel/..."}`.

### `stop`

Stop the Device Farm session **without exiting the tunnel process**. You can
call `start` again after this. If `stop_remote_access_session` raises, the
ARN is **not cleared** and the response is `{"ok": false, "error": "..."}` —
the session may still be billing. Retry with
`python3 scripts/devicefarm/stop-session.py --arn <arn>`.

```json
{ "cmd": "stop" }
```

### `quit` / `exit`

Stop the session AND exit the process. Runs cleanup BEFORE acknowledging so
the client sees the actual outcome — a successful response means the device
is no longer billing.

```json
{ "cmd": "quit" }
```

Response on clean stop: `{"ok":true,"quit":true}`. On stop failure:
`{"ok":false,"quit":true,"error":"stop_remote_access_session failed; session may still be billing — run scripts/devicefarm/stop-session.py --all-active"}`
(process exits with code 2).

## 5. What works vs. what's broken on Device Farm

Behavior observed live on iPhone 17 Pro / iOS 26.3.1 driving My-Project staging
(2026-05-29, against my-project@`22cf0cac5d9b88d066b4badd94b59d480be5285e`). The
Appium driver bundled in Device Farm's managed Appium server lags upstream
`appium-xcuitest-driver` v11.7.4
([reference](https://appium.github.io/appium-xcuitest-driver/latest/reference/execute-methods/)),
which is why some `mobile:` extensions the docs list are not actually
exposed at the WDA endpoint.

| `cmd`                         | App-rendered My-Project UI                                                                                                                                                                                                                                       | iOS system UI (Springboard / Spotlight)                                                                                                                                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tap` (coords)                | ✓                                                                                                                                                                                                                                                                | ✓                                                                                                                                                                                                                                                     |
| `tap_text`                    | ✓ (every interactive My-Project element ships an accessibility label per `figma-design-system.md`)                                                                                                                                                               | ✗ — Springboard / Spotlight system controls (Cancel, search field, App-Library labels) often have no label exposed to WDA's predicate matcher                                                                                                         |
| `type`                        | ✓ — the 4-strategy fallback (focused element → `set_value`/`send_keys`, then first-visible TextField/SecureTextField, then `mobile: keys`) lands on any field with `hasKeyboardFocus == 1` OR any visible TextField, with no operator-side pre-focusing required | ✗ — iOS Springboard / Spotlight / App-Library search fields are not exposed in the active app's accessibility tree, so the predicate-based fallbacks find nothing and `mobile: keys` returns `Unhandled endpoint: /wda/element/0/keyboardInput` on DF |
| `swipe` (both forms)          | ✓                                                                                                                                                                                                                                                                | ✓                                                                                                                                                                                                                                                     |
| `press`                       | ✓                                                                                                                                                                                                                                                                | ✓                                                                                                                                                                                                                                                     |
| `launch_app`                  | ✓ — `mobile: activateApp` succeeds against the staging bundle id; `mobile: launchApp` fallback covers older driver builds                                                                                                                                        | n/a (operates on installed-app bundle ids, not system UI)                                                                                                                                                                                             |
| `screenshot` / `tap` (coords) | ✓                                                                                                                                                                                                                                                                | ✓ — **always usable as the last-resort fallback**                                                                                                                                                                                                     |

## 6. Workarounds catalog

Each of these has been hit live; treat the workaround as the primary path
when you recognise the symptom.

### 6.1 `type` returns `Unhandled endpoint: /wda/element/0/keyboardInput` (system UI only)

**Symptom:** `{"cmd":"type","text":"my-project"}` against the iOS Spotlight /
App-Library system search field comes back as
`{"ok":false,"error":"Unhandled endpoint: /wda/element/0/keyboardInput"}`.

**Cause:** Device Farm's bundled `appium-xcuitest-driver` does **not** expose
`mobile: keys` (the strategy-4 last resort `tunnel.py:Tunnel.type_text`
dispatches when nothing earlier matches). Even though upstream v11.7.4
documents `mobile: keys`, the managed Appium server on DF is older /
stripped. Springboard / Spotlight / App-Library search fields aren't exposed
in the active app's accessibility tree, so strategies 1–3 (focused element +
first-visible TextField) find nothing and the cascade tumbles into
strategy 4 — which fails.

**App-rendered My-Project UI: `type` just works now.** Since my-project@`22cf0cac`,
`tunnel.py:Tunnel.type_text` cascades through the same four strategies
`explore.py:execute_action` uses (focused-element `set_value` →
focused-element `send_keys` → first-visible TextField/SecureTextField with
tap + `set_value`/`send_keys` → `mobile: keys`). You do **not** need to
pre-focus the field with `tap_text` first — strategy 3 finds the topmost
visible TextField on its own. See §4 `type` for the verbatim cascade.

**Workaround for iOS system text fields (Spotlight, App Library, Settings
search):** `type` is still unusable here. Instead, tap each on-screen
keyboard letter individually by coordinate (read them off the screenshot),
or skip the system search entirely and reach the app via `launch_app`
(§6.3) — which is now the canonical recovery.

### 6.2 `tap_text` returns `No element matched text 'Cancel'`

**Symptom:** `{"cmd":"tap_text","text":"Cancel"}` (or any system-button label
in Springboard / Spotlight / Control Center) fails with
`No element matched text 'Cancel'`.

**Cause:** iOS Springboard and Spotlight UI elements often have no
accessibility label, name, or value exposed via WDA's
`IOS_PREDICATE_STRING` matcher. The two predicate fallbacks inside
`tap_text` both miss.

**Workaround:** screenshot, eyeball the coordinates, and use coordinate
`tap`:

```bash
./tx.sh '{"cmd":"screenshot","path":"01.png"}'
# Read 01.png, locate "Cancel" at e.g. (360, 60)
./tx.sh '{"cmd":"tap","x":360,"y":60}'
```

### 6.3 App is installed but not launched after `start`

**Symptom:** Right after `tunnel.py` reports `{"ok":true,"event":"ready",...}`,
the screenshot shows the iOS home screen — not the My-Project app.

**Cause:** `tunnel.py` installs the IPA on session start (`appArn` is passed
to `create_remote_access_session`), but the Device Farm runtime does **not**
auto-launch it. The bundle is on the device — it's just sitting in App
Library → Recently Added.

**Canonical fix (since my-project@`22cf0cac`):** issue `launch_app` once. Either
form works:

```bash
# Explicit bundle id (recommended — no extra metadata round-trip)
./tx.sh '{"cmd":"launch_app","bundle_id":"com.staging.my-project"}'

# Auto-resolve from IPA upload metadata (tunnel.py reads `package_name`
# off the `app_arn` cached at `start` time)
./tx.sh '{"cmd":"launch_app"}'
```

Expect `{"ok":true,"bundle_id":"com.staging.my-project","method":"activateApp"}`.
On older Appium driver builds the response will be
`...,"method":"launchApp"` — same outcome, fallback path. See §4 `launch_app`
for the full error catalogue.

**Fallback (if `launch_app` itself fails):** swipe left to App Library, tap
"Recently Added" by coords, find the My-Project icon (one-liner pattern:
`swipe left → swipe left → screenshot → tap "Recently Added" → screenshot →
tap My-Project icon`). Useful when `activateApp` and `launchApp` both throw
and you need a screenshot-driven recovery while you file the bug.

### 6.4 Picker auto-selection (iPhone 17 Pro / iOS 26.3.1)

**Behavior:** the device picker reads the IPA's `metadata.supported_os` +
`metadata.form_factor` via `df.get_upload` and rejects incompatible devices
**before** `create_remote_access_session` is called — so an
`ArgumentException: invalid device or upload` from AWS can never cost you
billing minutes. Highest-OS HIGHLY_AVAILABLE iPhone wins. For the current
My-Project staging IPA, that is iPhone 17 Pro on iOS 26.3.1.

Shipped in
[PR #6171](https://github.com/your-org/my-project/pull/6171)
(merged 2026-05-29 17:34 UTC). No operator action required — just don't pass
`--device-arn` unless you need a specific model.

### 6.5 Session is metered — kill-9 recovery

**Cost:** ~$0.17 per device-minute on metered iPhones. A 50-step walkthrough
runs $1–3. The autonomous loop auto-stops in `finally` and on `SIGTERM`;
`tunnel.py:main._try_stop` is what guarantees that, and a non-zero exit code
(2) is raised if `stop_remote_access_session` failed so CI can alert on
billing leaks.

**A `kill -9` bypasses all of that.** If the tunnel process was force-killed
or the parent shell died, run the recovery one-liner **immediately**:

```bash
doppler run --project my-project --config dev_local -- \
  python3 scripts/devicefarm/stop-session.py --all-active
```

This stops every RUNNING / SCHEDULING session in the project. Confirm with
`python3 scripts/devicefarm/list-sessions.py`.

### 6.6 `NO_VIDEO` is the only Appium-driveable interaction mode

`INTERACTIVE` returns a WSS endpoint that is for humans (browser-rendered
video stream) and is incompatible with the urllib3-based Appium Python
client. `VIDEO_ONLY` is not useful for automation either. `tunnel.py`
hardcodes `interactionMode="NO_VIDEO"` — do not try to override it. The
quoted-verbatim code is in §2a.

### 6.7 FIFO writers must stay open

**Symptom:** the first JSON command works; every subsequent command produces
no output and the screenshot/tap hangs silently.

**Cause:** `printf '{...}\n' > fifo` opens, writes, and **closes** the FIFO.
The reader (`tunnel.py`) sees an EOF and the `for raw in sys.stdin:` loop in
`jsonrpc()` exits. The next write reopens the FIFO but tunnel.py has
already returned and nobody is reading.

**Workaround:** hold one writer open for the lifetime of the run, then
append each command into the same FIFO:

```bash
# 1. Make the FIFO and a holder that never closes it
mkfifo tmp/tunnel/in
( exec 9>tmp/tunnel/in; sleep 86400 ) &
HOLDER_PID=$!
echo "$HOLDER_PID" > tmp/tunnel/holder_pid

# 2. Run tunnel.py reading from the FIFO, mirror output to a log
cat tmp/tunnel/in | python3 scripts/devicefarm/tunnel.py --json \
  --app-arn "$APP_ARN" \
  > tmp/tunnel/out.log 2>&1 &
echo $! > tmp/tunnel/pid

# 3. Send commands by appending to the FIFO from a second writer
printf '{"cmd":"screenshot","path":"01.png"}\n' > tmp/tunnel/in
```

The `tx.sh` helper in §7 wraps this pattern.

### 6.8 `doppler run` wrapper breaks stdin to subprocesses

**Symptom:** `doppler run --project my-project --config dev_local -- bash -c '... python3 tunnel.py --json ...'` either never receives the first JSON command or drops stdin midway.

**Cause:** `doppler run`'s exec wrapper does not reliably forward stdin into a
nested `bash -c "... python3 ..."` invocation, especially when stdin is a
pipe / FIFO.

**Workaround:** materialize the secrets once, source them, and call
`tunnel.py` directly — no doppler wrapper in the hot path:

```bash
doppler secrets download \
  --project my-project --config dev_local \
  --no-file --format env > .env.iphonetest
set -a; source .env.iphonetest; set +a
# Now stdin works normally
python3 scripts/devicefarm/tunnel.py --json --app-arn "$APP_ARN"
```

Delete `.env.iphonetest` when you're done.

## 7. Suggested driving loop for a Claude operator

The pattern below is the one that actually works for a Claude session.
Everything lives under one tmpdir, the FIFO has a permanent holder, and
every command goes through a tiny `tx.sh` that reads the **next** line
written to `out.log` and surfaces it as the JSON response.

### 7.1 Bootstrap

```bash
TMP=$(mktemp -d -t tunnel.XXXXXX)
mkfifo "$TMP/in"
: > "$TMP/out.log"

# Hold the FIFO open so writers never EOF the reader
( exec 9>"$TMP/in"; sleep 86400 ) &
echo $! > "$TMP/holder_pid"

# tx.sh — send one JSON cmd, return the next response line
cat > "$TMP/tx.sh" <<'EOF'
#!/usr/bin/env bash
# Send one JSON cmd, return the next JSON response line from out.log.
# Usage: tx.sh '{"cmd":"screenshot","path":"x.png"}' [timeout_seconds]
set -euo pipefail
TMP="$(dirname "$0")"
CMD="${1:?usage: tx.sh JSON [timeout]}"
TIMEOUT="${2:-180}"
BEFORE=$(wc -l < "$TMP/out.log")
printf '%s\n' "$CMD" > "$TMP/in"
DEADLINE=$(( $(date +%s) + TIMEOUT ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  CUR=$(wc -l < "$TMP/out.log")
  if [ "$CUR" -gt "$BEFORE" ]; then
    sed -n "$((BEFORE+1))p" "$TMP/out.log"
    exit 0
  fi
  sleep 1
done
echo "{\"ok\":false,\"error\":\"tx.sh timeout after ${TIMEOUT}s\"}" >&2
exit 124
EOF
chmod +x "$TMP/tx.sh"

# Materialize secrets once — see gotcha §6.8
doppler secrets download \
  --project my-project --config dev_local \
  --no-file --format env > "$TMP/env"
set -a; source "$TMP/env"; set +a

# Launch the tunnel with /iphonetest (default mode = tunnel since PR #6172)
cat "$TMP/in" | \
  python3 ~/Projects/my-project-workspace/my-project/scripts/devicefarm/iphonetest.py \
    --mode tunnel --json \
  > "$TMP/out.log" 2>&1 &
echo $! > "$TMP/pid"
```

When tunnel.py is ready it writes one JSON line like
`{"ok":true,"event":"ready","session_arn":"...","device":"Apple iPhone 17 Pro","width":402,"height":874,"artifacts":"..."}`.
Read `out.log` until you see `"event":"ready"` before sending the first
command.

### 7.2 Drive

```bash
TX="$TMP/tx.sh"

# 1. `start` already ran when /iphonetest launched the tunnel — device
#    is reserved but sitting on Springboard.

# 2. Launch the app (canonical recovery, since my-project@22cf0cac).
#    Bundle id is optional — tunnel.py resolves it from IPA metadata
#    when omitted.
"$TX" '{"cmd":"launch_app","bundle_id":"com.staging.my-project"}'
# → expect {"ok":true,"bundle_id":"com.staging.my-project","method":"activateApp"}.

# 3. Take a baseline screenshot of the app's first screen
"$TX" '{"cmd":"wait","seconds":1}'
"$TX" '{"cmd":"screenshot","path":"'"$TMP"'/01.png"}'

# 4. Sign in
"$TX" '{"cmd":"tap_text","text":"Continue with Apple"}'
"$TX" '{"cmd":"wait","seconds":3}'
"$TX" '{"cmd":"screenshot","path":"'"$TMP"'/02.png"}'

# 5. Onwards — one screenshot per turn, one decision per turn

# 6. Always end with `quit`
"$TX" '{"cmd":"quit"}'
# → expect {"ok":true,"quit":true}. If "ok":false, run §6.5 recovery.
```

### 7.3 Teardown

```bash
kill "$(cat "$TMP/holder_pid")" 2>/dev/null || true
kill "$(cat "$TMP/pid")"        2>/dev/null || true
rm -f "$TMP/env"
```

After teardown, confirm no orphan sessions:

```bash
python3 ~/Projects/my-project-workspace/my-project/scripts/devicefarm/list-sessions.py
```

## 8. Cost model

| Item                                  | Cost                                    | Notes                                                                                                                                                                        |
| ------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Metered iPhone time                   | ~$0.17 / device-minute                  | Charged from RUNNING until `stop_remote_access_session` returns                                                                                                              |
| Typical tunnel session                | $1–3 per realistic walkthrough          | ~6–18 minutes including app launch + sign-in + few flows                                                                                                                     |
| `--print-only`                        | $0                                      | Resolves + uploads the IPA, never reserves a device                                                                                                                          |
| Idle session during operator thinking | Yes, metered                            | Plan your next move before sending — but don't paralysis-by-analysis past a couple of minutes                                                                                |
| Auto-stop guarantee                   | `finally` + `SIGTERM` + `quit` handler  | `tunnel.py:main._try_stop` returns False on stop failure, which raises the process exit code to 2 so CI / supervisors can alert. `kill -9` bypasses this — recover with §6.5 |
| Bedrock tokens                        | Only in `walkthrough` / `explore` modes | `tunnel` mode has no LLM-per-turn cost; the operating Claude is the brain                                                                                                    |

The fundamental rule: **a session that never reaches `stop_remote_access_session` keeps billing.** Always end with `quit`, never `kill -9`, and run §6.5 if anything goes sideways.

## 9. Followups to file

When you hit one of these in the field, file in the my-project repo and link
back to this guide. Do **not** patch them in the same PR that ships this
doc — keep the doc PR pure.

- **`mobile: keys` fallback for system text fields.** Either add a
  per-key tap-coords helper for the iOS on-screen keyboard, or document
  that My-Project tests should never depend on driving Spotlight / App-Library
  search. `launch_app` (shipped in my-project@`22cf0cac`) removed the most
  common reason an operator needed to drive system search at all, but
  Settings flows still hit it.
- **Document the bundled Appium driver version on Device Farm.** A
  `mobile: getEnv` probe at session-start would let `tunnel.py` log the
  WDA build version into `status` so future operators don't re-discover
  the upstream-vs-bundled drift from scratch.
- ~~**`launch_app` / `activate_app` JSON command in `tunnel.py`.**~~
  Shipped in my-project [PR #6174](https://github.com/your-org/my-project/pull/6174)
  (merged 2026-05-29, SHA `22cf0cac5d9b88d066b4badd94b59d480be5285e`). See
  §4 `launch_app` and §6.3.

Open these as my-project GitHub issues, link from
`my-project/.claude/commands/iphonetest.md`, and reference back here.

---

Last verified live: 2026-05-29 on iPhone 17 Pro / iOS 26.3.1 against
My-Project staging IPA, pinned to my-project@`22cf0cac5d9b88d066b4badd94b59d480be5285e`
(`scripts/devicefarm/tunnel.py`, my-project PR #6174). When anything in §4 / §5 /
§6 changes, update this file, re-pin the SHA, and update the upstream
slash-command in the same PR-pair.
