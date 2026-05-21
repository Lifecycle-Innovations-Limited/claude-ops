# Cloudflared tunnel + watchdog

Optional units for exposing the pocket-ops-ui (or any local service) through
a Cloudflare named tunnel with Zero Trust Access in front. Skip these units
if you only access the pocket UI over Tailscale.

## What's here

| File | Purpose |
|---|---|
| `cloudflared.service` | Runs `cloudflared tunnel run --token …` with `Restart=always` so the daemon self-heals on crash or token reload. |
| `cloudflared-watchdog.sh` | Detects the boot-time race where cloudflared starts before its v2 dashboard config arrives and gets stuck serving 503s with empty ingress. Restarts cloudflared when the running process's journal shows `No ingress rules` AND the dashboard has at least one configured hostname. |
| `cloudflared-watchdog.service` | Oneshot wrapper that invokes the script. |
| `cloudflared-watchdog.timer` | Runs the oneshot every 5 minutes (first fire 2 min after boot). |

## Setup

1. **Create a named tunnel** in the Cloudflare Zero Trust dashboard
   (Networks → Tunnels → Create a tunnel → Cloudflared). Copy the token.

2. **Edit `/etc/systemd/system/cloudflared.service`** after install — replace
   the `${CLOUDFLARED_TUNNEL_TOKEN}` placeholder with the real token string.
   This file is installed verbatim by `install-systemd-units.sh` and the
   token MUST be substituted out-of-band; do not commit it to git.

3. **Create `/etc/cloudflared-watchdog.env`** with `chmod 600`:

   ```
   CLOUDFLARE_API_TOKEN=<token with Account:Tunnel:Read>
   ```

   Generate this in the Cloudflare dashboard under My Profile → API Tokens.
   Scope to `Account: Cloudflare Tunnel: Read` only — the watchdog only
   reads the v2 config, never mutates it.

4. **Add ingress rules** to the tunnel in the Cloudflare dashboard
   (Public Hostname tab). The watchdog only restarts cloudflared if the
   dashboard has at least one configured hostname.

5. **Reload + enable**:

   ```
   sudo systemctl daemon-reload
   sudo systemctl enable --now cloudflared.service
   sudo systemctl enable --now cloudflared-watchdog.timer
   ```

## Failure mode the watchdog catches

On cold boot, systemd can start `cloudflared` seconds before Cloudflare's
control plane has pushed the v2 dashboard config to the local agent. The
agent registers with the edge but loads no ingress rules — logs:

```
WRN No ingress rules were defined in provided config (if any) nor from the
    cli, cloudflared will return 503 for all incoming HTTP requests
```

systemd sees the process as healthy (it never crashes), so the existing
`Restart=on-failure` policy doesn't trigger. Users hit `503 currently
unable to handle this request` on every gated hostname until someone
SSH-restarts cloudflared.

The watchdog closes this gap:

1. Fetches the live tunnel config via the Cloudflare API.
2. Counts ingress entries that actually have a `hostname`.
3. If hostnames are configured upstream **but** the journal shows the
   `No ingress rules` warning anywhere after the cloudflared process's
   `ExecMainStartTimestamp`, restart cloudflared so it re-pulls the v2
   config from the edge.

The journal-window scoping prevents restart loops: once cloudflared has
been restarted cleanly and is serving traffic, the historical warning is
no longer "in the current run" and the watchdog goes quiet.
