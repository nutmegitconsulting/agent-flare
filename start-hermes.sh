#!/bin/bash
set -e

# Runtime env vars injected by Worker via setEnvVars:
#   CLOUDFLARED_TOKEN   — cloudflared tunnel credential
#   UPLOAD_TOKEN        — R2 snapshot auth token
#   SNAPSHOT_UPLOAD_URL — Worker URL to POST snapshots
#   SNAPSHOT_DOWNLOAD_URL — Worker URL to GET latest snapshot
#   HERMES_USER_ID      — per-user path prefix in R2

export HERMES_HOME=/home/hermes/.hermes
export PATH="/usr/local/bin:$PATH"

mkdir -p "$HERMES_HOME"

# ---------------------------------------------------------------------------
# Pre-boot: restore latest snapshot from R2 (if any)
# ---------------------------------------------------------------------------
if [ -n "${UPLOAD_TOKEN:-}" ] && [ -n "${SNAPSHOT_DOWNLOAD_URL:-}" ] && [ -n "${HERMES_USER_ID:-}" ]; then
    echo "Checking for existing snapshot..."
    TMP_SNAP="/tmp/snapshot-download.$$.sqsh"
    HTTP_CODE=$(curl -fsSL -o "$TMP_SNAP" -w "%{http_code}" \
        -H "Authorization: Bearer ${UPLOAD_TOKEN}" \
        "${SNAPSHOT_DOWNLOAD_URL}?userId=${HERMES_USER_ID}" 2>/dev/null || true)
    if [ "${HTTP_CODE:-}" = "200" ] && [ -s "$TMP_SNAP" ]; then
        echo "Restoring snapshot..."
        rm -rf "$HERMES_HOME"/*
        unsquashfs -d "$HERMES_HOME" "$TMP_SNAP" >/dev/null 2>&1 || true
        echo "Snapshot restored."
    else
        echo "No snapshot found (HTTP ${HTTP_CODE:-error}). Starting fresh."
    fi
    rm -f "$TMP_SNAP"
fi

# Fix ownership
chown -R hermes:hermes "$HERMES_HOME" 2>/dev/null || true
chmod -R a+rX "$HERMES_HOME" 2>/dev/null || true

# Write dashboard session token to Hermes .env file (for Desktop GUI auth)
if [ -n "${HERMES_DASHBOARD_SESSION_TOKEN:-}" ]; then
    echo "HERMES_DASHBOARD_SESSION_TOKEN=${HERMES_DASHBOARD_SESSION_TOKEN}" >> "$HERMES_HOME/.env"
fi

# ---------------------------------------------------------------------------
# cloudflared tunnel (background)
# ---------------------------------------------------------------------------
if [ -n "${CLOUDFLARED_TOKEN:-}" ]; then
    cloudflared tunnel --no-autoupdate run --token "$CLOUDFLARED_TOKEN" &
fi

# ---------------------------------------------------------------------------
# Hourly squashfs snapshot loop (background)
# ---------------------------------------------------------------------------
(
    while true; do
        sleep 3600

        if [ -z "${UPLOAD_TOKEN:-}" ] || [ -z "${SNAPSHOT_UPLOAD_URL:-}" ] || [ -z "${HERMES_USER_ID:-}" ]; then
            continue
        fi

        TIMESTAMP=$(date +%s)
        SNAP="/tmp/snapshot-${TIMESTAMP}.sqsh"

        mksquashfs "$HERMES_HOME" "$SNAP" -comp xz -noappend > /dev/null 2>&1 || continue

        curl -fsSL -X POST \
            -H "Authorization: Bearer ${UPLOAD_TOKEN}" \
            -H "X-User-Id: ${HERMES_USER_ID}" \
            -H "X-Snapshot-Type: hourly" \
            --data-binary "@${SNAP}" \
            "${SNAPSHOT_UPLOAD_URL}" > /dev/null 2>&1 || true

        rm -f "$SNAP"
    done
) &

# ---------------------------------------------------------------------------
# SIGTERM: final snapshot before exit
# ---------------------------------------------------------------------------
_term() {
    echo "SIGTERM: flushing final snapshot..."

    if [ -n "${UPLOAD_TOKEN:-}" ] && [ -n "${SNAPSHOT_UPLOAD_URL:-}" ] && [ -n "${HERMES_USER_ID:-}" ]; then
        TIMESTAMP=$(date +%s)
        SNAP="/tmp/snapshot-final-${TIMESTAMP}.sqsh"
        mksquashfs "$HERMES_HOME" "$SNAP" -comp xz -noappend > /dev/null 2>&1 || true
        curl -fsSL -X POST \
            -H "Authorization: Bearer ${UPLOAD_TOKEN}" \
            -H "X-User-Id: ${HERMES_USER_ID}" \
            -H "X-Snapshot-Type: final" \
            --data-binary "@${SNAP}" \
            "${SNAPSHOT_UPLOAD_URL}" > /dev/null 2>&1 || true
        rm -f "$SNAP"
    fi

    # Kill background jobs
    kill %1 2>/dev/null || true
    exit 0
}
trap _term SIGTERM

# ---------------------------------------------------------------------------
# Start Hermes (foreground — script blocks here, but container still sleeps after idle timeout)
# ---------------------------------------------------------------------------
exec hermes serve
