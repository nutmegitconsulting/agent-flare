# =============================================================================
# Hermes Agent on Cloudflare Sandbox (V9 — hermes-flare install/profile split)
# =============================================================================
# Base: cloudflare/sandbox:0.12.14-python (matches @cloudflare/sandbox version).
# Serves the Hermes webapp on port 443 once the Worker has hydrated the home.
#
# LAYOUT (install vs. user-state separated so snapshots stay small):
#   /opt/hermes-install           code + venv + Node bundle + managed uv (~1.5-2 GB)
#   /opt/uv                       uv-managed CPython
#   /home/hermes/.hermes          runtime user data (HERMES_HOME; ships EMPTY)
#   /home/hermes/.local/bin/hermes  tiny `hermes` wrapper (points at /opt) = SENTINEL
#
# Snapshots come from a staged copy of .hermes (container/af_state.py), minus
# caches, logs and secrets. The container ends as root so the SDK can run mksquashfs.
# =============================================================================

FROM docker.io/cloudflare/sandbox:0.12.14-python

USER root

# Without pipefail a failed `curl | bash` builds an image with no Hermes in it.
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

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
# Tested Hermes commit. The webapp and its auth internals move fast, so bump this
# deliberately and re-run tests/container/run.sh.
ARG HERMES_COMMIT=ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df
RUN UV_PYTHON_INSTALL_DIR=/opt/uv/python \
    UV_PYTHON_BIN_DIR=/opt/uv/bin \
    curl -fsSL https://hermes-agent.nousresearch.com/install.sh \
      | bash -s -- --skip-setup --non-interactive --skip-browser --commit "$HERMES_COMMIT" --hermes-home /opt/hermes-install \
    && rm -rf /home/hermes/.cache /home/hermes/.npm \
    && chown -R hermes:hermes /opt/uv /home/hermes

# `hermes` CLI lives in ~/.local/bin; managed Node (if any) in /opt/hermes-install/node/bin.
ENV PATH=/home/hermes/.local/bin:/opt/hermes-install/node/bin:/usr/local/bin:$PATH

# Build the webapp bundle into the image; users must not wait for it at boot.
RUN HERMES_HOME=/opt/hermes-install hermes webapp --build-only \
    && test -f /opt/hermes-install/hermes-agent/apps/desktop/dist-webapp/index.html

# The container runs as root at runtime so the Sandbox SDK can run mksquashfs,
# but hermes refuses to update a checkout owned by a different uid than the
# running one — serve exited 1 on every boot with "refusing to update
# /opt/hermes-install/hermes-agent: owned by uid 1000, not the current uid 0".
# The install tree (and uv-managed python) must be root-owned; /home/hermes
# stays hermes-owned (runtime data, re-chowned at boot).
USER root
RUN chown -R root:root /opt/hermes-install /opt/uv

# --- Agent Flare additions ---
# Bundled plugin location: discovered like Hermes' own dashboard auth providers.
COPY --chown=root:root container/plugins/cloudflare_access /opt/hermes-install/hermes-agent/plugins/dashboard_auth/cloudflare_access
COPY --chown=root:root container/af_state.py /usr/local/lib/af_state.py
COPY --chown=root:root start-hermes.sh /usr/local/bin/start-hermes.sh
# af-python: Hermes' own venv, which provides ruamel.yaml for af_state.py.
RUN chmod +x /usr/local/bin/start-hermes.sh \
    && printf '#!/bin/sh\nexec %s "$@"\n' "$(ls -d /opt/hermes-install/installs/*/environments/*/venv/bin/python | head -1)" > /usr/local/bin/af-python \
    && chmod +x /usr/local/bin/af-python \
    && af-python -c "import ruamel.yaml" \
    && HERMES_HOME=/opt/hermes-install hermes --version

# The Worker reaches this through the sandbox, so wrangler must see the port.
EXPOSE 443

# sandbox binary is ENTRYPOINT; CMD is spawned as child.
CMD ["/usr/local/bin/start-hermes.sh"]
