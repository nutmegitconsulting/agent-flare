#!/bin/bash
set -e

USER_ID="${HERMES_USER_ID}"
UPLOAD_URL="${SNAPSHOT_UPLOAD_URL}"
DOWNLOAD_URL="${SNAPSHOT_DOWNLOAD_URL}"
UPLOAD_TOKEN="${UPLOAD_TOKEN}"
TUNNEL_TOKEN="${CLOUFLARED_TOKEN}"

# ---------------------------------------------------------------------------
# First-boot: install missing tools if not present
# ---------------------------------------------------------------------------
install_tools() {
  if ! command -v mksquashfs &> /dev/null; then
    echo "Installing squashfs-tools..."
    apt-get update -qq && apt-get install -y --no-install-recommends squashfs-tools && rm -rf /var/lib/apt/lists/* || true
  fi

  if ! command -v cloudflared &> /dev/null; then
    echo "Installing cloudflared..."
    curl -sfL --output /usr/local/bin/cloudflared \
      https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
      && chmod +x /usr/local/bin/cloudflared || true
  fi
}
install_tools

# ---------------------------------------------------------------------------
# Background: hourly squashfs snapshot -> POST to Worker -> R2
# ---------------------------------------------------------------------------
snapshot_loop() {
  if [ -z "$UPLOAD_URL" ] || [ -z "$UPLOAD_TOKEN" ]; then
    echo "Snapshot upload not configured — skipping background snapshots"
    return
  fi

  while true; do
    sleep 3600
    if [ ! -s /home/hermes/.local/bin/hermes ]; then
      continue
    fi
    TIMESTAMP=$(date +%s)
    SNAP_PATH="/tmp/snap-${TIMESTAMP}.sqfs"
    if mksquashfs /home/hermes "$SNAP_PATH" -comp zstd -noappend 2>/dev/null; then
      curl -sf -X POST \
        -H "Authorization: Bearer ***" \
        -H "Content-Type: application/octet-stream" \
        -H "X-Snapshot-Type: hourly" \
        -H "X-User-Id: ${USER_ID}" \
        --data-binary "@${SNAP_PATH}" \
        "${UPLOAD_URL}" || true
      rm -f "$SNAP_PATH"
    fi
  done
}

# ---------------------------------------------------------------------------
# SIGTERM: final snapshot before sleep
# ---------------------------------------------------------------------------
terminate() {
  echo "SIGTERM received — creating final snapshot..."
  if [ -n "$UPLOAD_URL" ] && [ -n "$UPLOAD_TOKEN" ]; then
    TIMESTAMP=$(date +%s)
    SNAP_PATH="/tmp/final-${TIMESTAMP}.sqfs"
    if mksquashfs /home/hermes "$SNAP_PATH" -comp zstd -noappend 2>/dev/null; then
      curl -sf -X POST \
        -H "Authorization: Bearer ***" \
        -H "Content-Type: application/octet-stream" \
        -H "X-Snapshot-Type: final" \
        -H "X-User-Id: ${USER_ID}" \
        --data-binary "@${SNAP_PATH}" \
        "${UPLOAD_URL}" || true
      rm -f "$SNAP_PATH"
    fi
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
  if [ -n "$DOWNLOAD_URL" ] && [ -n "$UPLOAD_TOKEN" ]; then
    echo "No sentinel found — attempting state restore..."
    RESTORE_URL="${DOWNLOAD_URL}?userId=${USER_ID}"
    if curl -sf -o /tmp/restore.sqfs \
      -H "Authorization: Bearer ***" \
      "${RESTORE_URL}" 2>/dev/null; then
      if [ -s /tmp/restore.sqfs ]; then
        unsquashfs -f -d /home/hermes /tmp/restore.sqfs 2>/dev/null || true
        rm -f /tmp/restore.sqfs
      fi
    else
      echo "No snapshot found — starting with fresh state"
    fi
  else
    echo "Snapshot download not configured — starting with fresh state"
  fi
fi

# ---------------------------------------------------------------------------
# Start cloudflared tunnel
# ---------------------------------------------------------------------------
cloudflared tunnel run --no-autoupdate --token "${TUNNEL_TOKEN}" &
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
