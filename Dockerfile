FROM docker.io/cloudflare/sandbox:0.7.0

# Install cloudflared (lightweight, required for tunnel origin)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && curl -L --output /usr/local/bin/cloudflared \
       https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
    && chmod +x /usr/local/bin/cloudflared \
    && apt-get remove -y curl \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Install Hermes agent (latest from GitHub releases)
# TODO: replace with actual install method once Hermes releases are available
# For now, copy from a multi-stage build or mount at runtime
# COPY --from=ghcr.io/nousresearch/hermes-agent:latest /opt/hermes /opt/hermes-install
# RUN ln -s /opt/hermes-install/bin/hermes /usr/local/bin/hermes

# Expose Hermes default port
EXPOSE 9119

# Container starts with cloudflared + hermes managed by the Worker
