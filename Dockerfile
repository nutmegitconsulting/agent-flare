# =============================================================================
# Hermes Agent on Cloudflare Sandbox (V6)
# =============================================================================
# Base: cloudflare/sandbox:0.12.7-python (matches npm package version).
# Hermes install.sh handles its own Node/Python/uv prerequisites.
# When run as root it installs to /usr/local/lib/hermes-agent (FHS layout).
# We only install cloudflared + squashfs-tools as root.
# =============================================================================

FROM docker.io/cloudflare/sandbox:0.12.7-python

USER root

# --- System tools ---
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

# --- cloudflared ---
RUN curl -sfL --output /usr/local/bin/cloudflared \
        https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
    && chmod +x /usr/local/bin/cloudflared

# --- Hermes install (as root -> FHS layout) ---
# install.sh detects root and uses /usr/local/lib/hermes-agent
# HERMES_HOME controls where data (sessions, skills, config) lives
ENV HERMES_HOME=/home/hermes/.hermes
ENV UV_NO_CONFIG=1
RUN curl -fsSL https://hermes-agent.nousresearch.com/install.sh \
    | bash -s -- --skip-setup --non-interactive

# --- hermes user for runtime ---
# Create after install so install.sh runs as root (FHS layout)
RUN useradd --create-home --shell /bin/bash --uid 1000 hermes \
    && mkdir -p /home/hermes/.hermes \
    && chown -R hermes:hermes /home/hermes

# Snapshot-friendly perms
RUN chmod -R a+rX /home/hermes

# --- Startup ---
COPY --chown=root:root start-hermes.sh /usr/local/bin/start-hermes.sh
RUN chmod +x /usr/local/bin/start-hermes.sh

# sandbox binary is ENTRYPOINT; CMD is spawned as child
CMD ["/usr/local/bin/start-hermes.sh"]
