# =============================================================================
# Hermes Agent on Cloudflare Sandbox (V9 — hermes-flare install/profile split)
# =============================================================================
# Base: cloudflare/sandbox:0.12.7-python (matches @cloudflare/sandbox version).
#
# LAYOUT (install vs. user-state separated so snapshots stay small):
#   /opt/hermes-install           code + venv + Node bundle + managed uv (~1.5-2 GB)
#   /opt/uv                       uv-managed CPython
#   /home/hermes/.hermes          runtime user data (HERMES_HOME; ships EMPTY)
#   /home/hermes/.local/bin/hermes  tiny `hermes` wrapper (points at /opt) = SENTINEL
#
# The SDK snapshots BACKUP_DIR=/home/hermes — small (~50-150 MB) and carries no
# install artifacts. The container ends as root so the SDK can run mksquashfs.
# =============================================================================

FROM docker.io/cloudflare/sandbox:0.12.7-python

USER root

# --- System tools ---
# build-essential is required by install.sh's node-pty native build.
# squashfs-tools: createBackup/restoreBackup run mksquashfs/unsquashfs in-container.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
         curl ca-certificates git squashfs-tools build-essential openssh-server \
    && rm -rf /var/lib/apt/lists/*

# --- SSH setup for Cloudflare Containers debug access ---
RUN mkdir -p /run/sshd \
    && echo 'root:*:19694:0:99999:7:::' > /etc/shadow \
    && sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin yes/' /etc/ssh/sshd_config \
    && sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config \
    && sed -i 's/#PubkeyAuthentication yes/PubkeyAuthentication yes/' /etc/ssh/sshd_config \
    && ssh-keygen -A

# --- cloudflared (tunnel for Desktop App access) ---
RUN curl -sfL --output /usr/local/bin/cloudflared \
        https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
    && chmod +x /usr/local/bin/cloudflared

# --- hermes user (install + runtime data owner) ---
RUN useradd --create-home --shell /bin/bash --uid 1000 hermes

# Runtime data dir. SHIPS EMPTY — snapshot tree must not carry build-time state
# (a baked config.yaml makes a failed restore look like a healthy boot).
ENV HERMES_HOME=/home/hermes/.hermes
ENV UV_NO_CONFIG=1

# Install to /opt/hermes-install (OUTSIDE the snapshot tree) as the hermes user:
# install.sh resolves INSTALL_DIR=$HERMES_HOME/hermes-agent, the Node bundle lands
# at $HERMES_HOME/node, managed uv at $HERMES_HOME/bin/uv, and the `hermes` wrapper
# in $HOME/.local/bin — so everything heavy lives under /opt and only the tiny
# wrapper sits in /home/hermes. UV_PYTHON_INSTALL_DIR/BIN_DIR keep uv's CPython in
# /opt too.
RUN mkdir -p /opt/hermes-install /opt/uv /home/hermes/.hermes \
    && chown -R hermes:hermes /opt/hermes-install /opt/uv /home/hermes

USER hermes
WORKDIR /home/hermes
ENV HOME=/home/hermes
RUN UV_PYTHON_INSTALL_DIR=/opt/uv/python \
    UV_PYTHON_BIN_DIR=/opt/uv/bin \
    curl -fsSL https://hermes-agent.nousresearch.com/install.sh \
      | bash -s -- --skip-setup --non-interactive --hermes-home /opt/hermes-install \
    && test -x /opt/hermes-install/bin/uv \
    && ls -la /opt/hermes-install/hermes-agent \
    # Strip install-time caches — uv wheels/npm cache land in $HOME and are
    # hundreds of MB we don't need at runtime.
    && rm -rf /home/hermes/.cache /home/hermes/.npm \
    && chown -R hermes:hermes /opt/uv /home/hermes

# `hermes` CLI lives in ~/.local/bin; managed Node (if any) in /opt/hermes-install/node/bin.
ENV PATH=/home/hermes/.local/bin:/opt/hermes-install/node/bin:/usr/local/bin:$PATH

# Snapshot-friendly perms: createBackup's mksquashfs needs everything readable.
RUN chmod -R a+rX /home/hermes

# Container runs as root at runtime so the Sandbox SDK can run mksquashfs.
USER root

# --- Startup ---
COPY --chown=root:root start-hermes.sh /usr/local/bin/start-hermes.sh
RUN chmod +x /usr/local/bin/start-hermes.sh

# sandbox binary is ENTRYPOINT; CMD is spawned as child.
CMD ["/usr/local/bin/start-hermes.sh"]
