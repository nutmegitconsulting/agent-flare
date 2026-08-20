FROM docker.io/cloudflare/sandbox:0.7.0

# Install cloudflared and tools needed for state management
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    squashfs-tools \
    && curl -L --output /usr/local/bin/cloudflared \
       https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
    && chmod +x /usr/local/bin/cloudflared \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Entrypoint script handles cloudflared, hermes, background snapshots, SIGTERM
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 9119

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
