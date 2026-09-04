#!/bin/bash
set -e

# IMPORTANT: this script runs as a child of the /sandbox ENTRYPOINT — a
# different process tree from the SDK defaultSession — so setEnvVars values
# NEVER reach it. All per-user values arrive via files written by the Worker
# on /api/wake:
#   /run/hermes-bootstrap.json  - userId, upload token, Access JWT,
#                                 upload URL, cloudflared tunnel token,
#                                 dashboard session token (Option B)
#   /tmp/restore.sqfs           - snapshot to restore (Option A)
#   /tmp/restore-none           - marker: no snapshot exists (Option A)

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
# Pre-boot: restore snapshot pushed by the Worker (Option A)
# The Worker reads R2 directly and writeFile's the newest snapshot to
# /tmp/restore.sqfs. Poll for it — order-independent (Worker may push
# before or after this script starts). No tokens, no HTTP, no race.
# ---------------------------------------------------------------------------
RESTORE_WAITED=0
RESTORE_TIMEOUT=120
RESTORE_SNAP="/tmp/restore.sqfs"
RESTORE_NONE="/tmp/restore-none"

# Note: no env-var gate here — the CMD process can never see setEnvVars
# values (different process tree). Presence of /tmp/restore.sqfs or
# /tmp/restore-none IS the signal; the poll window is the only wait.
status "Waiting for snapshot push from Worker..."
log "Waiting for snapshot push from Worker..."
while [ ! -s "$RESTORE_SNAP" ] && [ ! -e "$RESTORE_NONE" ]; do
    sleep 2
    RESTORE_WAITED=$((RESTORE_WAITED + 2))
    if [ $RESTORE_WAITED -ge $RESTORE_TIMEOUT ]; then
        break
    fi
done
rm -f "$RESTORE_NONE"

if [ -s "$RESTORE_SNAP" ]; then
    # Validate file is actually a squashfs archive (guard against partial writes)
    FILE_TYPE=$(file "$RESTORE_SNAP" 2>/dev/null || echo "unknown")
    if echo "$FILE_TYPE" | grep -qi "squashfs"; then
        SNAP_SIZE=$(du -sh "$RESTORE_SNAP" 2>/dev/null | cut -f1)
        status "Found snapshot. Extracting ${SNAP_SIZE} archive..."
        log "Snapshot pushed (${FILE_TYPE}, ${SNAP_SIZE}). Extracting..."
        log "Clearing existing HERMES_HOME..."
        rm -rf "$HERMES_HOME"/*
        log "Extracting snapshot to $HERMES_HOME..."
        status "Extracting snapshot..."
        if unsquashfs -f -d "$HERMES_HOME" "$RESTORE_SNAP" > /dev/null 2>&1; then
            FILE_COUNT=$(find "$HERMES_HOME" -type f 2>/dev/null | wc -l)
            DIR_COUNT=$(find "$HERMES_HOME" -type d 2>/dev/null | wc -l)
            log "Snapshot restored successfully. Files: $FILE_COUNT, Dirs: $DIR_COUNT"
            status "Restored ${FILE_COUNT} files from snapshot."
        else
            log "ERROR: unsquashfs failed (exit code: $?)."
            status "ERROR: extraction failed."
        fi
    else
        log "ERROR: Restore file is not a valid squashfs archive. File type: $FILE_TYPE"
        status "ERROR: restore file is not a valid snapshot (${FILE_TYPE})."
    fi
    rm -f "$RESTORE_SNAP"
else
    log "No snapshot received within ${RESTORE_TIMEOUT}s (waited ${RESTORE_WAITED}s). Starting fresh."
    status "No snapshot received. Starting fresh."
fi

# Fix ownership
chown -R hermes:hermes "$HERMES_HOME" 2>/dev/null || true
chmod -R a+rX "$HERMES_HOME" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Option B: bootstrap file written by the Worker on every /api/wake.
# The CMD boot process is a DIFFERENT process tree from the SDK
# defaultSession, so it can never see setEnvVars values. All per-user
# values (upload token, Access JWT, tunnel token, dashboard token)
# therefore arrive via this file. Re-read on every use so a rotated
# token or refreshed JWT from a later wake is picked up automatically.
#   /run/hermes-bootstrap.json:
#     { userId, uploadToken, accessJwt, snapshotUploadUrl,
#       cloudflaredToken, dashboardSessionToken }
# ---------------------------------------------------------------------------
BOOTSTRAP_FILE="/run/hermes-bootstrap.json"

load_bootstrap() {
    BT_UPLOAD_TOKEN=""
    BT_ACCESS_JWT=""
    BT_USER_ID=""
    BT_UPLOAD_URL=""
    BT_CLOUDFLARED_TOKEN=""
    BT_DASHBOARD_TOKEN=""
    if [ -s "$BOOTSTRAP_FILE" ]; then
        # shellcheck disable=SC2046
        eval "$(python3 -c "
import json
try:
    d = json.load(open('$BOOTSTRAP_FILE'))
    def sh(s): return s.replace(chr(39), chr(39)+chr(92)+chr(39)+chr(39))
    print(\"BT_UPLOAD_TOKEN='%s'\" % sh(d.get('uploadToken', '')))
    print(\"BT_ACCESS_JWT='%s'\" % sh(d.get('accessJwt', '')))
    print(\"BT_USER_ID='%s'\" % sh(d.get('userId', '')))
    print(\"BT_UPLOAD_URL='%s'\" % sh(d.get('snapshotUploadUrl', '')))
    print(\"BT_CLOUDFLARED_TOKEN='%s'\" % sh(d.get('cloudflaredToken', '')))
    print(\"BT_DASHBOARD_TOKEN='%s'\" % sh(d.get('dashboardSessionToken', '')))
except Exception:
    pass
" 2>/dev/null)"
    fi
}

# ---------------------------------------------------------------------------
# Start SSH daemon (for Cloudflare Containers debug access)
# ---------------------------------------------------------------------------
mkdir -p /run/sshd
/usr/sbin/sshd -D &

# ---------------------------------------------------------------------------
# Dashboard session token -> Hermes .env (for Desktop GUI auth).
# The token arrives via bootstrap AFTER boot, so a background watcher
# applies it the moment the file lands (and on every refresh after).
# ---------------------------------------------------------------------------
(
    while true; do
        sleep 5
        load_bootstrap
        [ -z "$BT_DASHBOARD_TOKEN" ] && continue
        if [ -s "$HERMES_HOME/.env" ] && grep -q "^HERMES_DASHBOARD_SESSION_TOKEN=" "$HERMES_HOME/.env" 2>/dev/null; then
            # Token already present: update it only if it changed
            CURRENT=$(grep "^HERMES_DASHBOARD_SESSION_TOKEN=" "$HERMES_HOME/.env" | head -1 | cut -d= -f2-)
            [ "$CURRENT" = "$BT_DASHBOARD_TOKEN" ] && continue
            sed -i "s|^HERMES_DASHBOARD_SESSION_TOKEN=.*|HERMES_DASHBOARD_SESSION_TOKEN=${BT_DASHBOARD_TOKEN}|" "$HERMES_HOME/.env"
        else
            echo "HERMES_DASHBOARD_SESSION_TOKEN=${BT_DASHBOARD_TOKEN}" >> "$HERMES_HOME/.env"
        fi
        chown hermes:hermes "$HERMES_HOME/.env" 2>/dev/null || true
    done
) &

# ---------------------------------------------------------------------------
# cloudflared tunnel (background, token from bootstrap, pidfile-guarded)
# ---------------------------------------------------------------------------
(
    while true; do
        sleep 5
        CF_PID_FILE="/run/cloudflared.pid"
        if [ -s "$CF_PID_FILE" ] && kill -0 "$(cat "$CF_PID_FILE")" 2>/dev/null; then
            continue
        fi
        load_bootstrap
        if [ -n "$BT_CLOUDFLARED_TOKEN" ]; then
            cloudflared tunnel --no-autoupdate run --token "$BT_CLOUDFLARED_TOKEN" &
            echo $! > "$CF_PID_FILE"
        fi
    done
) &

# ---------------------------------------------------------------------------
# Hourly squashfs snapshot loop (background)
# ---------------------------------------------------------------------------
(
    while true; do
        sleep 3600

        load_bootstrap
        if [ -z "$BT_UPLOAD_TOKEN" ] || [ -z "$BT_UPLOAD_URL" ] || [ -z "$BT_USER_ID" ]; then
            continue
        fi

        TIMESTAMP=$(date +%s)
        SNAP="/tmp/snapshot-${TIMESTAMP}.sqsh"

        (cd "$HERMES_HOME" && mksquashfs . "$SNAP" -comp xz -noappend > /dev/null 2>&1) || continue

        curl -sSL -X POST \
            -H "Authorization: Bearer ${BT_UPLOAD_TOKEN}" \
            -H "CF-Access-Jwt-Assertion: ${BT_ACCESS_JWT}" \
            -H "X-User-Id: ${BT_USER_ID}" \
            -H "X-Snapshot-Type: hourly" \
            --data-binary "@${SNAP}" \
            "${BT_UPLOAD_URL}" > /dev/null 2>&1 || true

        rm -f "$SNAP"
    done
) &

# ---------------------------------------------------------------------------
# SIGTERM: final snapshot before exit
# ---------------------------------------------------------------------------
_term() {
    echo "SIGTERM: flushing final snapshot..."

    load_bootstrap
    if [ -n "$BT_UPLOAD_TOKEN" ] && [ -n "$BT_UPLOAD_URL" ] && [ -n "$BT_USER_ID" ]; then
        TIMESTAMP=$(date +%s)
        SNAP="/tmp/snapshot-final-${TIMESTAMP}.sqsh"
        (cd "$HERMES_HOME" && mksquashfs . "$SNAP" -comp xz -noappend > /dev/null 2>&1) || true
        curl -sSL -X POST \
            -H "Authorization: Bearer ${BT_UPLOAD_TOKEN}" \
            -H "CF-Access-Jwt-Assertion: ${BT_ACCESS_JWT}" \
            -H "X-User-Id: ${BT_USER_ID}" \
            -H "X-Snapshot-Type: final" \
            --data-binary "@${SNAP}" \
            "${BT_UPLOAD_URL}" > /dev/null 2>&1 || true
        rm -f "$SNAP"
    fi

    # Kill all background jobs (sshd, watchers, snapshot loop, cloudflared)
    jobs -p 2>/dev/null | xargs -r kill 2>/dev/null || true
    rm -f /run/cloudflared.pid
    exit 0
}
trap _term SIGTERM

# ---------------------------------------------------------------------------
# Start Hermes (foreground - script blocks here, but container still sleeps after idle timeout)
# ---------------------------------------------------------------------------
status "Startup complete."
exec hermes serve
