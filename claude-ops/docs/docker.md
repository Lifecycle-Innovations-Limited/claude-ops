# Docker

> **TL;DR.** `docker compose up -d && docker compose exec claude-ops bash` drops you into an Ubuntu 24.04 shell with `claude-ops`, Node 22, `gh`, `aws`, `doppler`, `jq`, `expect`, `git`, `libsecret-tools` and `gnome-keyring` pre-installed. Your host's `~/.claude`, `~/.aws` and `~/.config/gh` are mounted so credentials and plugin state persist.

This path is an **addition** to the v1.1.0 cross-OS flow (`lib/os-detect.sh` + `lib/credential-store.sh` + `lib/opener.sh`). It does **not** replace native macOS/Linux/Windows installs — use whichever works best for your workflow. See [`os-compatibility.md`](./os-compatibility.md) for the full matrix.

## Why Docker

| Scenario | Native | Docker |
|---|---|---|
| macOS workstation, brew OK | Native wins — Keychain integration is free | Docker works but loses Keychain |
| Ubuntu desktop with `gnome-keyring` | Native wins — libsecret integration is free | Equivalent; pick whichever you prefer |
| Linux server, no Homebrew, no desktop | Works but manual CLI installs | **Docker wins** — one image, all CLIs baked in |
| CI runner (ephemeral, no state) | Works but cold-starts on every run | **Docker wins** — `docker run` caches layers |
| Disposable dev env, try-before-buy | Leaves files on your host | **Docker wins** — `docker rm` wipes it |
| Windows without WSL2 | Not supported (natively) | **Docker wins** — inherits Linux path |

If none of those rows apply to you, stick with the native install — it's faster, has better credential-store integration, and can launch browser-based auth flows (Slack autolink, OAuth) without any extra wiring.

## Quick start

```bash
# From the plugin root (where the Dockerfile sits):
cd claude-ops

# Optional: seed an empty registry if you don't have one yet.
[ -f registry.json ] || echo '{"projects":[]}' > registry.json

# Build + run detached.
docker compose up -d

# Attach an interactive shell.
docker compose exec claude-ops bash

# Inside the container:
ops-status          # pretty status panel
ops-status --json   # machine-readable JSON
ops-doctor          # deeper health report
ls "$CLAUDE_PLUGIN_ROOT"
gh auth status      # reads ~/.config/gh mounted from host
aws sts get-caller-identity   # reads ~/.aws mounted from host
```

Tear it down with `docker compose down`. Your `~/.claude` state and `registry.json` persist on the host.

## `docker build` vs `docker compose`

- **`docker build`** is the low-ceremony path. It bakes a plain image and doesn't wire up any volumes or env vars — good for CI, production runs, or one-off smoke tests.
  ```bash
  docker build -t claude-ops:local .
  docker run --rm -it \
    -e GITHUB_TOKEN \
    -v "$HOME/.claude:/home/ops/.claude" \
    claude-ops:local
  ```
- **`docker compose`** wires up the full persona: host mounts for `~/.claude`, `~/.aws`, `~/.config/gh`, registry, and every environment variable the plugin knows about. Use this for daily dev.

The compose file sets `restart: "no"` on purpose — this is a CLI container, not a long-running service.

## Mounting your registry

`scripts/registry.json` is gitignored and user-specific. The compose file maps `./registry.json` on the host into `/opt/claude-ops/scripts/registry.json` inside the container:

```yaml
volumes:
  - "./registry.json:/opt/claude-ops/scripts/registry.json:rw"
```

If you keep your registry elsewhere, override with a compose override file:

```yaml
# docker-compose.override.yml
services:
  claude-ops:
    volumes:
      - "/path/to/your/registry.json:/opt/claude-ops/scripts/registry.json:rw"
```

## Passing credentials

**Env vars (preferred for ephemeral / CI).** Every key listed in `docker-compose.yml` uses the `${VAR:-}` form so unset vars are simply empty; the plugin's credential cascade falls through to other backends.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export GITHUB_TOKEN=ghp_...
docker compose up -d
```

Put them in a `.env` file in the same directory as `docker-compose.yml` and they'll be picked up automatically — just don't commit it.

**Host mounts (preferred for dev).** `~/.aws` and `~/.config/gh` are mounted read-only so the containerised `aws`/`gh` CLIs see your host credentials without the container being able to clobber them.

**Doppler.** Set `DOPPLER_TOKEN` as an env var and the in-container `doppler` CLI will pick it up. Service tokens work great for this; user tokens require an interactive `doppler login` per-container (not recommended).

**OS keyring.** The container can write to libsecret via `secret-tool` if you run `gnome-keyring-daemon --components=secrets --daemonize --unlock` inside it, but the keyring is ephemeral — it dies with the container. For persistent secrets, set `CLAUDE_OPS_CRED_BACKEND=enc-json` and supply `CLAUDE_OPS_MASTER_KEY` so the encrypted-JSON backend survives container rebuilds (see [`os-compatibility.md`](./os-compatibility.md#credential-storage)).

## Adding `gogcli`

`gogcli` is not baked into the image — it requires Linuxbrew or a Go toolchain, which would roughly double the image size. If you need it, extend the image:

```dockerfile
FROM claude-ops:local
USER root
RUN apt-get update && apt-get install -y --no-install-recommends golang \
    && git clone https://github.com/steipete/gogcli.git /tmp/gogcli \
    && cd /tmp/gogcli && make && cp gogcli /usr/local/bin/ \
    && rm -rf /tmp/gogcli \
    && apt-get purge -y golang && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*
USER ops
```

Or mount a host-installed binary: `-v /usr/local/bin/gogcli:/usr/local/bin/gogcli:ro`.

## Limitations

1. **No `launchd` / `systemd`.** The container doesn't run an init system. If you need the daemon (`scripts/ops-daemon.sh`), either:
   - Run it in the **foreground inside the container** during your session (`bash /opt/claude-ops/scripts/ops-daemon.sh --run-once` in a loop), or
   - Run `systemd --user` on the **host** and let it invoke the daemon outside Docker, or
   - Use a cron-job sidecar if you're in Kubernetes.
2. **No browser automation by default.** Slack autolink, OAuth flows, and anything else that launches Playwright headed Chromium need a display. The container doesn't ship with one. To enable it, mount your X11 socket and set `DISPLAY`:
   ```bash
   docker run --rm -it \
     -e DISPLAY="$DISPLAY" \
     -v /tmp/.X11-unix:/tmp/.X11-unix:ro \
     -v "$HOME/.Xauthority:/home/ops/.Xauthority:ro" \
     claude-ops:local
   ```
   On macOS (`XQuartz`) and Windows (`VcXsrv`/WSLg) the setup is similar but with extra `xhost` dance. Headless CI runners simply can't do this; run `/ops:setup slack` on a workstation and paste the tokens into the container via env vars.
3. **macOS Keychain reads don't work inside a Linux container.** The plugin's credential cascade (see [`os-compatibility.md`](./os-compatibility.md#credential-storage)) falls through: `security` (N/A on Linux) → `secret-tool` (needs unlocked keyring, ephemeral) → `keytar` (works) → encrypted JSON (works; portable — recommended inside containers).
4. **`gogcli` is opt-in.** See "Adding `gogcli`" above.
5. **Networking.** The container uses Docker's default bridge network. `localhost` inside the container is the container, not the host. To reach a host-running service (e.g. a local Shopify dev server on `:3000`), use `host.docker.internal` (macOS/Windows) or add `--add-host=host.docker.internal:host-gateway` (Linux).
6. **Image size.** The current image is ~1.2 GB (Ubuntu base + Node 22 + AWS CLI v2 + gh + doppler + GUI bits for keyring). Trimming further would mean dropping GUI deps and losing keyring support entirely.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `registry.json: permission denied` | Host file owned by your UID (≠1001); container runs as UID 1001 | `chown 1001:1001 registry.json` or mount with `:Z` on SELinux |
| `secret-tool: cannot communicate with gnome-keyring` | No unlocked keyring in the container | Set `CLAUDE_OPS_CRED_BACKEND=enc-json` or start `gnome-keyring-daemon --unlock` manually |
| `gh: the authenticated user has no access` | `~/.config/gh` mounted but the token file is missing a newline at EOF | `gh auth login` once on the host, then restart the container |
| `aws: Unable to locate credentials` | `~/.aws` mounted ro but empty | `aws configure` once on the host |
| Playwright fails to launch Chromium | No display | Mount X11 socket as shown above, or skip browser steps and paste tokens |

## CI use

The repo ships `.github/workflows/docker-build.yml` which builds the image on `push`-to-`main`, on `v*` tags, and via `workflow_dispatch`. It smoke-tests the image (`ops-status --json` must parse) but **does not publish** — pushing to a registry is a separate opt-in workflow.

To adopt the image in your own CI:

```yaml
- name: claude-ops step
  run: |
    docker run --rm \
      -e GITHUB_TOKEN=${{ secrets.GITHUB_TOKEN }} \
      -v "${{ github.workspace }}:/workspace" \
      -w /workspace \
      ghcr.io/lifecycle-innovations-limited/claude-ops:latest \
      bash -c 'ops-status --json | jq . && bash bin/ops-setup-detect'
```

(Replace the image reference with wherever the publish workflow lands.)

## See also

- [`os-compatibility.md`](./os-compatibility.md) — the cross-OS support matrix.
- [`daemon-guide.md`](./daemon-guide.md) — how the background daemon is expected to run.
- Issue [#17](https://github.com/Lifecycle-Innovations-Limited/claude-ops/issues/17) — the design discussion that led to this path.
