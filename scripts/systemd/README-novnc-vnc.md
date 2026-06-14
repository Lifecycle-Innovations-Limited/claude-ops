# Persistent browser-based desktop (noVNC over Tailscale)

Gives a headless box a GUI desktop you can reach from any browser on the tailnet —
no VNC client, no SSH tunnel — and survives reboots. Built for `dev-sandbox-fra`
but host-agnostic.

## Architecture

```
browser ──HTTPS (tailnet)──> tailscale serve ──> 127.0.0.1:6080
                                                    │  (novnc.service, --user)
                                                    ▼
                          websockify  ──WebSocket⇄VNC──>  localhost:5901
                                                    │
                                                    ▼
                              TigerVNC  Xvnc :1  (vncserver@:1.service)
                                                    │
                                                    ▼
                                      GNOME desktop on display :1
```

## Install

```bash
./setup-novnc-desktop.sh
```

Idempotent. It installs `websockify` (pip --user), clones `noVNC` to `~/noVNC`,
installs + enables the `novnc.service` user unit, enables linger, ensures
`vncserver@:1` is boot-enabled, fronts it with `tailscale serve`, and disables the
GNOME idle screen-lock.

## Boot persistence — the four things that must be true

| Layer                      | Unit / setting                                          | Why                                                |
| -------------------------- | ------------------------------------------------------- | -------------------------------------------------- |
| VNC server `:1`            | `vncserver@:1.service` (system, **enabled**)            | starts the X/GNOME desktop                         |
| noVNC proxy `:6080`        | `novnc.service` (**--user**, enabled, `Restart=always`) | bridges WS↔VNC + serves the web client             |
| user-service-without-login | `loginctl enable-linger $USER`                          | the `--user` unit starts at boot, no login needed  |
| HTTPS front                | `tailscale serve --bg 6080`                             | config persists in tailscaled state across reboots |

If any one is missing the desktop won't come back after reboot. Verify:

```bash
systemctl is-enabled vncserver@:1.service        # enabled
systemctl --user is-enabled novnc.service        # enabled
loginctl show-user "$USER" -p Linger             # Linger=yes
sudo tailscale serve status                      # shows / -> 127.0.0.1:6080
```

## Access

- Tailnet IP: `http://<tailscale-ip>:6080/vnc.html`
- MagicDNS: `https://<host>.<tailnet>.ts.net/vnc.html` (via `tailscale serve`)
- Connect, enter the **VNC password**.

The box has no public IP, so `0.0.0.0:6080` is effectively tailnet-only. Keep it
that way — do **not** `tailscale funnel` this (that would expose the desktop to the
public internet).

## Secrets (NOT in this repo)

- **VNC password** — `~/.vnc/passwd` (TigerVNC obfuscated, 8-char max). Reset:
  `printf '%s\n' '<pw>' | vncpasswd -f > ~/.vnc/passwd`
- **Desktop login password** — the Unix user password (`passwd` / `chpasswd`).
- **GNOME login keyring** — separate from the above; if its password is unknown,
  launch Chromium/Brave with `--password-store=basic` to avoid a keyring unlock hang
  (saved credentials won't decrypt, but the browser runs).

## Troubleshooting

- noVNC loads but won't connect → `systemctl --user restart novnc.service`; check
  `vncserver@:1` is active and `:5901` is listening.
- `tailscale serve` denied → run with `sudo`, or `sudo tailscale set --operator=$USER` once.
- Only one process should `LISTEN` on `:6080` — the service one. Kill strays by PID.
