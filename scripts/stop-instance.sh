#!/usr/bin/env bash
# Graceful stop sandbox by userId (SIGTERM → triggers onStop + squashfs backup)
# Usage: ./stop-instance.sh <userId>

set -euo pipefail

USER_ID="${1:-}"
WORKER_URL="${WORKER_URL:-https://hermes-agent.hermes-test.app}"

if [ -z "$USER_ID" ]; then
  echo "Usage: $0 <userId>"
  exit 1
fi

echo "Sending SIGTERM to sandbox for user: $USER_ID ..."

# Find cloudflared (WSL can see Windows binary)
CFD=""
for p in cloudflared /mnt/c/ProgramData/chocolatey/bin/cloudflared.exe \
         /mnt/c/Users/*/AppData/Local/cloudflared/cloudflared.exe \
         /mnt/c/Windows/System32/cloudflared.exe; do
  if command -v "$p" >/dev/null 2>&1; then
    CFD="$p"
    break
  fi
done

if [ -z "$CFD" ]; then
  echo "cloudflared not found."
  exit 1
fi

RESPONSE=$("$CFD" access curl -s -X POST "$WORKER_URL/api/admin/stop?userId=$USER_ID")
echo "Response: $RESPONSE"
