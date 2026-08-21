#!/bin/bash
set -e

# Runtime env vars injected by Worker via setEnvVars:
#   TUNNEL_TOKEN      — cloudflared tunnel credential
#   UPLOAD_TOKEN      — R2 snapshot upload auth
#   SNAPSHOT_ENDPOINT — Worker URL to POST snapshots (e.g. http://.../internal/upload-snapshot)
#   USER_ID           — per-user path prefix in R2

export HERMES_HOME=/home/hermes/.hermes
export PATH="/usr/local/bin:$PATH"

mkdir -p "$HERMES_HOME"

# Fix ownership if running as root (sandbox spawns CMD as root by default)
if [ "$(id -u)" = "0" ]; then
    chown -R hermes:hermes "$HERMES_HOME" 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# cloudflared tunnel (background)
# ---------------------------------------------------------------------------
if [ -n "${TUNNEL_TOKEN:-}" ]; then
    cloudflared access tcp --token "$TUNNEL_TOKEN" &
fi

# ---------------------------------------------------------------------------
# Hourly squashfs snapshot loop (background)
# ---------------------------------------------------------------------------
(
    while true; do
        sleep 3600

        if [ -z "${UPLOAD_TOKEN:-}" ] || [ -z "${SNAPSHOT_ENDPOINT:-}" ]; then
            continue
        fi

        TIMESTAMP=$(date +%s)
        SNAP="/tmp/snapshot-${TIMESTAMP}.sqsh"

        mksquashfs "$HERMES_HOME" "$SNAP" -comp xz -noappend > /dev/null 2>&1 || continue

        curl -fsSL -X POST \
            -H "Authorization: Bearer ${UPLOAD_TOKEN}" \
            -F "user_id=${USER_ID:-default}" \
            -F "file=@${SNAP}" \
            "${SNAPSHOT_ENDPOINT}" > /dev/null 2>&1 || true

        rm -f "$SNAP"
    done
) &

# ---------------------------------------------------------------------------
# SIGTERM: final snapshot before exit
# ---------------------------------------------------------------------------
_term() {
    echo "SIGTERM: flushing final snapshot..."

    if [ -n "${UPLOAD_TOKEN:-}" ] && [ -n "${SNAPSHOT_ENDPOINT:-}" ]; then
        TIMESTAMP=$(date +%s)
        SNAP="/tmp/snapshot-final-${TIMESTAMP}.sqsh"
        mksquashfs "$HERMES_HOME" "$SNAP" -comp xz -noappend >/dev/null 2&1 || true
        curl -fsSL -X POST \
            -H "Authorization: Bearer ${UPLOAD_TOKEN}" \
            -F "user_id=${USER_ID:-default}" \
            -F "file=@${SNAP}" \
            "${SNAPSHOT_ENDPOINT}" > /dev/null 2>&1 || true
        rm -f "$SNAP"
    fi

    # Kill background jobs
    kill %1 %2 2>/dev/null || true
    exit 0
}
trap _term SIGTERM

# ---------------------------------------------------------------------------
# Start Hermes (foreground — keeps container alive)
# ---------------------------------------------------------------------------
exec hermes serve
