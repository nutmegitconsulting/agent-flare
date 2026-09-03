#!/bin/bash
set -e

# Runtime env vars injected by Worker via setEnvVars:
#   CLOUDFLARED_TOKEN   - cloudflared tunnel credential
#   UPLOAD_TOKEN        - R2 snapshot auth token
#   SNAPSHOT_UPLOAD_URL - Worker URL to POST snapshots
#   SNAPSHOT_DOWNLOAD_URL - Worker URL to GET latest snapshot
#   HERMES_USER_ID      - per-user path prefix in R2

LOG_FILE="/var/log/hermes-startup.log"
mkdir -p "$(dirname "$LOG_FILE")"

log() {
    echo "[$(date -Iseconds)] $1" | tee -a "$LOG_FILE"
}

# Write a plain-text status file for external polling
status() {
    echo "$1" > "$HERMES_HOME/.startup-status"
}

export HERMES_HOME=/home/hermes/.hermes
export PATH="/usr/local/bin:$PATH"

mkdir -p "$HERMES_HOME"

# Wipe any stale status from previous boot
rm -f "$HERMES_HOME/.startup-status"
status "Container booting..."

# ---------------------------------------------------------------------------
# Ensure required tools are present
# ---------------------------------------------------------------------------
install_tools() {
    if ! command -v mksquashfs &> /dev/null; then
        log "Installing squashfs-tools..."
        apt-get update -qq && apt-get install -y --no-install-recommends squashfs-tools && rm -rf /var/lib/apt/lists/* || true
    fi
    if ! command -v cloudflared &> /dev/null; then
        log "Installing cloudflared..."
        curl -sfL --output /usr/local/bin/cloudflared \
            https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
            && chmod +x /usr/local/bin/cloudflared || true
    fi
}
install_tools

# ---------------------------------------------------------------------------
# Pre-boot: restore latest snapshot from R2 (if any)
# ---------------------------------------------------------------------------
if [ -n "${UPLOAD_TOKEN:-}" ] && [ -n "${SNAPSHOT_DOWNLOAD_URL:-}" ] && [ -n "${HERMES_USER_ID:-}" ]; then
    status "Checking for existing snapshot..."
    log "Checking for existing snapshot..."
    TMP_SNAP="/tmp/snapshot-download.$$.sqsh"
    HTTP_CODE=$(curl -sSL -o "$TMP_SNAP" -w "%{http_code}" \
        -H "Authorization: Bearer ${UPLOAD_TOKEN}" \
        -H "CF-Access-Jwt-Assertion: ${CF_ACCESS_JWT:-}" \
        "${SNAPSHOT_DOWNLOAD_URL}?userId=${HERMES_USER_ID}" 2>/dev/null || true)
    log "Download HTTP_CODE=$HTTP_CODE"
    if [ "${HTTP_CODE:-}" = "200" ] && [ -s "$TMP_SNAP" ]; then
        # Validate file is actually a squashfs archive, not HTML
        FILE_TYPE=$(file "$TMP_SNAP" 2>/dev/null || echo "unknown")
        if echo "$FILE_TYPE" | grep -qi "squashfs"; then
            SNAP_SIZE=$(du -sh "$TMP_SNAP" 2>/dev/null | cut -f1)
            status "Found snapshot. Extracting ${SNAP_SIZE} archive..."
            log "Downloaded valid squashfs archive (${FILE_TYPE}, ${SNAP_SIZE})"
            log "Clearing existing HERMES_HOME..."
            rm -rf "$HERMES_HOME"/*
            log "Extracting snapshot to $HERMES_HOME..."
            status "Extracting snapshot..."
            if unsquashfs -f -d "$HERMES_HOME" "$TMP_SNAP" > /dev/null 2>&1; then
                FILE_COUNT=$(find "$HERMES_HOME" -type f 2>/dev/null | wc -l)
                DIR_COUNT=$(find "$HERMES_HOME" -type d 2>/dev/null | wc -l)
                log "Snapshot restored successfully. Files: $FILE_COUNT, Dirs: $DIR_COUNT"
                status "Restored ${FILE_COUNT} files from snapshot."
            else
                log "ERROR: unsquashfs failed (exit code: $?)."
                status "ERROR: extraction failed."
            fi
        else
            log "ERROR: Downloaded file is not a valid squashfs archive. File type: $FILE_TYPE"
            status "ERROR: downloaded file is not a valid snapshot (${FILE_TYPE})."
        fi
    else
        log "No snapshot found (HTTP ${HTTP_CODE:-error}). Starting fresh."
        status "No snapshot found. Starting fresh."
    fi
    rm -f "$TMP_SNAP"
else
    log "Snapshot restore not configured — missing env vars. Starting fresh."
    status "Snapshot restore not configured. Starting fresh."
fi

# Fix ownership
chown -R hermes:hermes "$HERMES_HOME" 2>/dev/null || true
chmod -R a+rX "$HERMES_HOME" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Start SSH daemon (for Cloudflare Containers debug access)
# ---------------------------------------------------------------------------
mkdir -p /run/sshd
/usr/sbin/sshd -D &

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

        (cd "$HERMES_HOME" && mksquashfs . "$SNAP" -comp xz -noappend > /dev/null 2>&1) || continue

        curl -sSL -X POST \
            -H "Authorization: Bearer ${UPLOAD_TOKEN}" \
            -H "CF-Access-Jwt-Assertion: ${CF_ACCESS_JWT:-}" \
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
        (cd "$HERMES_HOME" && mksquashfs . "$SNAP" -comp xz -noappend > /dev/null 2>&1) || true
        curl -sSL -X POST \
            -H "Authorization: Bearer ${UPLOAD_TOKEN}" \
            -H "CF-Access-Jwt-Assertion: ${CF_ACCESS_JWT:-}" \
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
# Start Hermes (foreground - script blocks here, but container still sleeps after idle timeout)
# ---------------------------------------------------------------------------
status "Startup complete."
exec hermes serve
