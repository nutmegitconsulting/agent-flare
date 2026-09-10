# =============================================================================
# Hermes Agent on Cloudflare Sandbox — VANILLA layout
# =============================================================================
# Base: cloudflare/sandbox:0.12.7-python (must match @cloudflare/sandbox version).
#
# LAYOUT (vanilla root FHS install — no /opt split):
#   /usr/local/lib/hermes-agent        code + venv (baked, outside snapshot)
#   /usr/local/bin/hermes              self-contained launcher shim (outside)
#   /usr/local/share/uv/{python,bin}   uv-managed CPython (world-readable)
#   /home/hermes/.hermes               ALL mutable state (HERMES_HOME) = snapshot
#                                       + baked runtime bits: bin/uv, node/, skills/
#
# The SDK snapshots dir=/home/hermes/.hermes via createBackup (mksquashfs in
# container, uploaded through the bound BACKUP_BUCKET R2). Restores are
# `unsquashfs -f -d /home/hermes/.hermes` — force-overwrite ONTO the baked
# install, so the /usr/local code is never disturbed.
#
# The container ends as root so the Sandbox SDK can run mksquashfs.
# =============================================================================

FROM docker.io/cloudflare/sandbox:0.12.7-python

USER root

# --- System tools ---
# build-essential: required by install.sh's node-pty native build.
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

# --- hermes user (owns the runtime data dir; install runs as root below) ---
RUN useradd --create-home --shell /bin/bash --uid 1000 hermes

# HERMES_HOME: the ONE snapshot tree. Everything mutable lives here.
ENV HERMES_HOME=/home/hermes/.hermes
ENV UV_NO_CONFIG=1
ENV PATH=/usr/local/bin:$PATH

# --- Vanilla install as ROOT -> FHS layout (code/venv/shim under /usr/local) ---
# uv-managed CPython lands world-readable at /usr/local/share/uv (install.sh does
# this automatically for root Linux FHS installs). Managed uv binary and the
# managed Node bundle (if needed) land inside $HERMES_HOME (bin/uv, node/) —
# inside the snapshot tree on purpose: a restore re-materializes them, and a
# fresh user gets them baked in.
RUN curl -fsSL https://hermes-agent.nousresearch.com/install.sh \
      | bash -s -- --skip-setup --non-interactive \
    && test -x /usr/local/bin/hermes \
    && test -x /usr/local/lib/hermes-agent/venv/bin/python \
    && ls -la /usr/local/lib/hermes-agent \
    && chown -R hermes:hermes /home/hermes

# --- Wipe build-time user state (Pitfall 12) ---------------------------------
# install.sh's copy_config_templates seeded $HERMES_HOME at build time with
# template config.yaml / .env / SOUL.md, install_id, bundled skills, empty data
# dirs, etc. Ship the home WITHOUT that state so (a) a failed restore shows an
# obviously-empty home instead of fake-healthy build state, and (b) the snapshot
# stays small. KEEP the baked runtime bits that live inside the tree:
#   bin/  (managed uv binary), node/ (managed Node), skills/ (bundled skills).
RUN rm -rf /home/hermes/.hermes/config.yaml \
         /home/hermes/.hermes/.env \
         /home/hermes/.hermes/SOUL.md \
         /home/hermes/.hermes/install_id \
         /home/hermes/.hermes/state.db \
         /home/hermes/.hermes/state.db-wal \
         /home/hermes/.hermes/state.db-shm \
         /home/hermes/.hermes/.startup-status \
    && find /home/hermes/.hermes -mindepth 1 -maxdepth 1 \
         ! -name bin ! -name node ! -name skills -exec rm -rf {} + \
    && chown -R hermes:hermes /home/hermes \
    && chmod -R a+rX /home/hermes/.hermes

# --- Startup ---
COPY --chown=root:root start-hermes.sh /usr/local/bin/start-hermes.sh
RUN chmod +x /usr/local/bin/start-hermes.sh

# sandbox binary is ENTRYPOINT; CMD is spawned as its child.
USER root
CMD ["/usr/local/bin/start-hermes.sh"]
