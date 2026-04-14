# claude-ops — turnkey container image for Linux / CI / headless use.
#
# This image is an *alternative* host, not a replacement for v1.1.0's native
# cross-OS flow (lib/os-detect.sh + lib/credential-store.sh). Use it when you
# don't want to install Homebrew/CLIs on the host, or for CI and disposable dev
# environments. See docs/docker.md for the full rationale and limitations.
#
# Build:   docker build -t claude-ops:local .
# Run:     docker run --rm -it claude-ops:local
# Compose: docker compose up -d && docker compose exec claude-ops bash

# hadolint ignore=DL3007
FROM ubuntu:24.04

LABEL org.opencontainers.image.title="claude-ops" \
      org.opencontainers.image.description="Turnkey container for the claude-ops Claude Code plugin — Linux / CI / headless use." \
      org.opencontainers.image.source="https://github.com/Lifecycle-Innovations-Limited/claude-ops" \
      org.opencontainers.image.documentation="https://github.com/Lifecycle-Innovations-Limited/claude-ops/blob/main/claude-ops/docs/docker.md" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="Lifecycle Innovations Limited" \
      org.opencontainers.image.base.name="docker.io/library/ubuntu:24.04"

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    CLAUDE_PLUGIN_ROOT=/opt/claude-ops \
    PATH=/opt/claude-ops/bin:/usr/local/bin:/usr/bin:/bin

# --- Layer 1: base system + runtime deps ------------------------------------
# Kept together so cache invalidation is coarse-grained (one change ↔ one rebuild).
# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        expect \
        git \
        gnome-keyring \
        gnupg \
        jq \
        libsecret-tools \
        python3 \
        python3-pip \
        unzip \
    && rm -rf /var/lib/apt/lists/*

# --- Layer 2: Node 22 LTS (NodeSource apt repo) -----------------------------
# hadolint ignore=DL3008,DL4006
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && node --version \
    && npm --version

# --- Layer 3: GitHub CLI (gh) apt repo --------------------------------------
# hadolint ignore=DL3008,DL4006
RUN mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
         -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
         > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# --- Layer 4: AWS CLI v2 (official zip) -------------------------------------
# Defaults to "latest"; override for reproducible builds:
#   docker build --build-arg AWSCLI_URL=https://awscli.amazonaws.com/awscli-exe-linux-x86_64-2.17.0.zip .
ARG AWSCLI_URL=https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip
RUN curl -fsSL "$AWSCLI_URL" -o /tmp/awscliv2.zip \
    && unzip -q /tmp/awscliv2.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/aws /tmp/awscliv2.zip \
    && aws --version

# --- Layer 5: Doppler CLI (apt repo) ----------------------------------------
# hadolint ignore=DL3008,DL4006
RUN curl -fsSL https://packages.doppler.com/public.key \
      | gpg --dearmor -o /usr/share/keyrings/doppler-archive-keyring.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/doppler-archive-keyring.gpg] https://packages.doppler.com/public/cli/deb/debian any-version main" \
         > /etc/apt/sources.list.d/doppler-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends doppler \
    && rm -rf /var/lib/apt/lists/* \
    && doppler --version

# NOTE: gogcli is intentionally NOT installed here. It requires Linuxbrew (or a
# Go toolchain + manual build), which roughly doubles the image size for a tool
# that not every user needs. See docs/docker.md → "Adding gogcli" for opt-in
# instructions.

# --- Layer 6: plugin tree ---------------------------------------------------
# Create the non-root user first so COPY --chown lands with the right owner.
RUN groupadd --system --gid 1001 ops \
    && useradd  --system --uid 1001 --gid ops --create-home --home-dir /home/ops --shell /bin/bash ops

COPY --chown=ops:ops . /opt/claude-ops

# claude-ops/bin/* are shell scripts checked in without +x on some filesystems;
# make sure they execute inside the container.
RUN find /opt/claude-ops/bin -type f -exec chmod +x {} \; \
    && find /opt/claude-ops/scripts -type f -name '*.sh' -exec chmod +x {} \;

# --- Final setup ------------------------------------------------------------
WORKDIR /home/ops
USER ops

# Healthcheck: ops-status --json is the canonical light-weight probe. Treat the
# container as healthy when the JSON parses AND (a) the daemon is running OK,
# (b) the daemon isn't installed (valid for ephemeral dev/CI containers), or
# (c) ops-status itself returns non-JSON but the plugin manifest is on disk.
# The graceful cascade prevents transient failures from flapping the container.
HEALTHCHECK --interval=60s --timeout=15s --start-period=10s --retries=3 \
  CMD bash -c '\
    out=$(bash /opt/claude-ops/bin/ops-status --json 2>/dev/null || true); \
    if [ -n "$out" ] && echo "$out" | jq -e "(.daemon.state == \"ok\") or (.daemon.state == \"\") or (.daemon.state == null)" >/dev/null 2>&1; then \
      exit 0; \
    fi; \
    test -f /opt/claude-ops/.claude-plugin/plugin.json'

# Default entrypoint: interactive bash with env vars already wired up.
ENTRYPOINT ["/bin/bash"]
CMD ["-l"]
