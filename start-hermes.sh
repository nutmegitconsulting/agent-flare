#!/bin/bash
set -e

# =============================================================================
# Hermes boot (CMD child of the /sandbox ENTRYPOINT).
#
# This runs in a DIFFERENT process tree from the SDK defaultSession, so it
# NEVER sees setEnvVars values. All per-user values arrive via a file the
# Worker writes on /api/wake:
#   /run/hermes-bootstrap.json  - { userId, cloudflaredToken, dashboardSessionToken }
#   /tmp/restore-done           - marker: Worker finished restoreBackup (or there
#                                 was no backup). Written AFTER restoreBackup, or
#                                 immediately when no backup exists.
#
# Persistence is owned by the WORKER (createBackup/restoreBackup via the
# Sandbox SDK). This script performs NO snapshots and NO uploads — the SDK
# handles the container side of mksquashfs/unsquashfs. Our only coordination
# point is the restore gate below: wait for /tmp/restore-done so the first
# `hermes serve` reads the restored tree, not the empty image default.
# =============================================================================

LOG_FILE="/var/log/hermes-startup.log"
mkdir -p "$(dirname "$LOG_FILE")"

log() {
    echo "[$(date -Iseconds)] $1" | tee -a "$LOG_FILE"
}

export HERMES_HOME=/home/hermes/.hermes
export PATH="/home/hermes/.local/bin:/opt/hermes-install/node/bin:/usr/local/bin:$PATH"

mkdir -p "$HERMES_HOME"

# Wipe any stale status from previous boot
rm -f "$HERMES_HOME/.startup-status"
status() { echo "$1" > "$HERMES_HOME/.startup-status"; }
status "Container booting..."

# ---------------------------------------------------------------------------
# Ensure cloudflared is present (baked into the image; this is a safety net).
# ---------------------------------------------------------------------------
if ! command -v cloudflared &> /dev/null; then
    log "cloudflared missing; installing..."
    curl -sfL --output /usr/local/bin/cloudflared \
        https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
        && chmod +x /usr/local/bin/cloudflared || true
fi

# ---------------------------------------------------------------------------
# RESTORE GATE (the one coordination point with the Worker).
# The Worker restores the newest backup into /home/hermes via restoreBackup,
# then writes /tmp/restore-done. Poll for it so `hermes serve` does not start
# on the empty image tree before the restore lands. Order-independent: wake may
# arrive before or after this script starts; the poll covers both.
#
# If the marker never arrives within the cap (e.g. the container was started
# without a wake), the cap still releases and serve starts on whatever is on
# disk. A fresh user's wake writes the marker immediately (restored:false), so
# fresh boots do not wait out the full window.
# ---------------------------------------------------------------------------
RESTORE_MARKER="/tmp/restore-done"
RESTORE_WAITED=0
RESTORE_TIMEOUT=120
status "Waiting for restore marker from Worker..."
log "Waiting for restore marker from Worker..."
while [ ! -e "$RESTORE_MARKER" ]; do
    sleep 2
    RESTORE_WAITED=$((RESTORE_WAITED + 2))
    if [ $RESTORE_WAITED -ge $RESTORE_TIMEOUT ]; then
        break
    fi
done
if [ -e "$RESTORE_MARKER" ]; then
    log "Restore marker received ($(cat "$RESTORE_MARKER" 2>/dev/null || echo '?')) after ${RESTORE_WAITED}s."
    status "Restore marker received. Starting..."
else
    log "No restore marker within ${RESTORE_TIMEOUT}s (waited ${RESTORE_WAITED}s). Starting on current disk state."
    status "No restore marker. Starting on current state."
fi
rm -f "$RESTORE_MARKER"

# Snapshot-friendly perms for the (possibly just-restored) tree so the SDK's
# mksquashfs can read everything on the next createBackup.
chown -R hermes:hermes "$HERMES_HOME" 2>/dev/null || true
chmod -R a+rX "$HERMES_HOME" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Bootstrap file (written by the Worker on every /api/wake). Now only carries
# what the CMD genuinely needs: the cloudflared tunnel token and the dashboard
# session token. No upload token / Access JWT / URLs — the container performs
# no uploads (the SDK uploads backups through the bound R2). Re-read on every
# use so a rotated token from a later wake is picked up automatically.
#   /run/hermes-bootstrap.json: { userId, cloudflaredToken, dashboardSessionToken }
# ---------------------------------------------------------------------------
BOOTSTRAP_FILE="/run/hermes-bootstrap.json"
BT_CLOUDFLARED_TOKEN=""
BT_DASHBOARD_TOKEN=""
BT_USER_ID=""

load_bootstrap() {
    BT_CLOUDFLARED_TOKEN=""
    BT_DASHBOARD_TOKEN=""
    BT_USER_ID=""
    if [ -s "$BOOTSTRAP_FILE" ]; then
        # shellcheck disable=SC2046
        eval "$(python3 -c "
import json
try:
    d = json.load(open('$BOOTSTRAP_FILE'))
    def sh(s): return str(s).replace(chr(39), chr(39)+chr(92)+chr(39)+chr(39))
    print(\"BT_CLOUDFLARED_TOKEN='%s'\" % sh(d.get('cloudflaredToken', '')))
    print(\"BT_DASHBOARD_TOKEN='%s'\" % sh(d.get('dashboardSessionToken', '')))
    print(\"BT_USER_ID='%s'\" % sh(d.get('userId', '')))
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
# The token arrives via bootstrap AFTER boot, so a background watcher applies
# it the moment the file lands (and on every refresh after).
# ---------------------------------------------------------------------------
(
    while true; do
        sleep 5
        load_bootstrap
        [ -z "$BT_DASHBOARD_TOKEN" ] && continue
        if [ -s "$HERMES_HOME/.env" ] && grep -q "^HERMES_DASHBOARD_SESSION_TOKEN=" "$HERMES_HOME/.env" 2>/dev/null; then
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
# SIGTERM: cleanup only. The Worker takes the final backup before stop/destroy
# (see /api/admin/stop + /api/admin/destroy), so there is nothing to snapshot
# here — just tear down the background jobs.
# ---------------------------------------------------------------------------
_term() {
    echo "SIGTERM: cleaning up background jobs..."
    jobs -p 2>/dev/null | xargs -r kill 2>/dev/null || true
    rm -f /run/cloudflared.pid
    exit 0
}
trap _term SIGTERM

# ---------------------------------------------------------------------------
# Start Hermes (foreground - script blocks here; container sleeps after idle)
# ---------------------------------------------------------------------------
status "Starting hermes serve..."
log "hermes CLI: $(which hermes 2>/dev/null || echo 'NOT FOUND')"
exec hermes serve
