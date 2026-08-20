#!/bin/bash
set -e

USER_ID="${HERMES_USER_ID}"
TUNNEL_TOKEN="${CLOU...KEN}"
R2_ENDPOINT="${R2_ENDPOINT}"
R2_BUCKET="${R2_BUCKET}"
R2_PREFIX="${R2_PREFIX}"
R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID}"
R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY}"

# ---------------------------------------------------------------------------
# Background: hourly squashfs snapshot to R2 (via S3-compatible API)
# ---------------------------------------------------------------------------
snapshot_loop() {
  while true; do
    sleep 3600
    if [ ! -s /home/hermes/.local/bin/hermes ]; then
      continue
    fi
    TIMESTAMP=$(date +%s)
    SNAP_PATH="/tmp/snap-${TIMESTAMP}.sqfs"
    if mksquashfs /home/hermes "$SNAP_PATH" -comp zstd -noappend 2>/dev/null; then
      # Upload via S3-compatible API
      FILE_NAME="hourly/${TIMESTAMP}.sqfs"
      RESOURCE="/${R2_BUCKET}/${R2_PREFIX}${FILE_NAME}"
      DATE=$(date -u +'%Y%m%dT%H%M%SZ')
      # Simple curl PUT to S3-compatible endpoint
      curl -sf -X PUT \
        -H "Date: $DATE" \
        -H "Content-Type: application/octet-stream" \
        -T "$SNAP_PATH" \
        "https://${R2_ENDPOINT}${RESOURCE}" \
        -u "${R2_ACCESS_KEY_ID}:${R2_SECRET_ACCESS_KEY}" 2>/dev/null || true

      # Register snapshot in DO (via outbound handler)
      curl -sf -X POST \
        -H "Content-Type: application/json" \
        -d "{\"id\":\"${TIMESTAMP}\",\"createdAt\":\"$(date -Iseconds)\",\"type\":\"hourly\"}" \
        "http://my.worker/internal/register-snapshot?userId=${USER_ID}" || true

      rm -f "$SNAP_PATH"
    fi
  done
}

# ---------------------------------------------------------------------------
# SIGTERM: final snapshot before sleep
# ---------------------------------------------------------------------------
terminate() {
  echo "SIGTERM received — creating final snapshot..."
  TIMESTAMP=$(date +%s)
  SNAP_PATH="/tmp/final-${TIMESTAMP}.sqfs"
  if mksquashfs /home/hermes "$SNAP_PATH" -comp zstd -noappend 2>/dev/null; then
    RESOURCE="/${R2_BUCKET}/${R2_PREFIX}final.sqfs"
    DATE=$(date -u +'%Y%m%dT%H%M%SZ')
    curl -sf -X PUT \
      -H "Date: $DATE" \
      -H "Content-Type: application/octet-stream" \
      -T "$SNAP_PATH" \
      "https://${R2_ENDPOINT}${RESOURCE}" \
      -u "${R2_ACCESS_KEY_ID}:${R2_SECRET_ACCESS_KEY}" 2>/dev/null || true
    rm -f "$SNAP_PATH"
  fi

  kill -TERM $HERMES_PID $CLOUDFLARED_PID 2>/dev/null || true
  wait
  exit 0
}
trap terminate TERM INT

# ---------------------------------------------------------------------------
# On boot: restore latest state if sentinel is missing
# ---------------------------------------------------------------------------
if [ ! -s /home/hermes/.local/bin/hermes ]; then
  echo "No sentinel found — attempting state restore..."
  # Try final first, then latest hourly
  for KEY in "${R2_PREFIX}final.sqfs" "${R2_PREFIX}hourly/"; do
    RESOURCE="/${R2_BUCKET}/${KEY}"
    if curl -sf -o /tmp/restore.sqfs \
      -u "${R2_ACCESS_KEY_ID}:${R2_SECRET_ACCESS_KEY}" \
      "https://${R2_ENDPOINT}${RESOURCE}" 2>/dev/null; then
      if [ -s /tmp/restore.sqfs ]; then
        unsquashfs -f -d /home/hermes /tmp/restore.sqfs 2>/dev/null || true
        rm -f /tmp/restore.sqfs
        break
      fi
    fi
  done
fi

# ---------------------------------------------------------------------------
# Start cloudflared tunnel
# ---------------------------------------------------------------------------
cloudflared tunnel run --no-autoupdate --token "$TUNNEL_TOKEN" &
CLOUDFLARED_PID=$!

# ---------------------------------------------------------------------------
# Start Hermes agent
# ---------------------------------------------------------------------------
hermes serve &
HERMES_PID=$!

# ---------------------------------------------------------------------------
# Start background snapshot loop
# ---------------------------------------------------------------------------
snapshot_loop &
SNAPSHOT_PID=$!

# Wait for any child to exit, then terminate gracefully
wait -n
terminate
