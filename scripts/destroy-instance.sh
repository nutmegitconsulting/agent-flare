#!/usr/bin/env bash
# Hermes V6 Admin: Destroy Sandbox Instance by Container ID
# Run from WSL where Wrangler is authenticated.
# Usage: ./scripts/destroy-instance.sh <hex-instance-id>

set -euo pipefail

INSTANCE_ID="${1:-}"
if [ -z "$INSTANCE_ID" ]; then
    echo "Usage: $0 <instance-id>"
    echo ""
    echo "Destroy a running sandbox container by its instance ID."
    echo "Get IDs from: npx wrangler containers instances <app-id> --json"
    exit 1
fi

APP_NAME="hermes-cloudflare-v6-hermessandbox"
WORKER_URL="https://hermes-agent.hermes-test.app"

# ---------------------------------------------------------------------------
# 1. Find container application ID
# ---------------------------------------------------------------------------
echo "Finding container application '$APP_NAME'..."
APP_JSON=$(cd /home/user/projects/hermes-cloudflare-v6 && npx wrangler containers list --json 2>/dev/null)
APP_ID=$(echo "$APP_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(next(x['id'] for x in d if x['name']=='$APP_NAME'))" 2>/dev/null || true)

if [ -z "$APP_ID" ]; then
    echo "ERROR: Could not find container application '$APP_NAME'."
    exit 1
fi
echo "Found app ID: $APP_ID"

# ---------------------------------------------------------------------------
# 2. Resolve instance ID to userId (name)
# ---------------------------------------------------------------------------
echo "Resolving instance '$INSTANCE_ID'..."
INSTANCES_JSON=$(cd /home/user/projects/hermes-cloudflare-v6 && npx wrangler containers instances "$APP_ID" --json 2>/dev/null)
USER_ID=$(echo "$INSTANCES_JSON" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for inst in data:
    if inst['id'] == '$INSTANCE_ID':
        print(inst['name'])
        break
" 2>/dev/null || true)

if [ -z "$USER_ID" ]; then
    echo "ERROR: Instance '$INSTANCE_ID' not found."
    echo ""
    echo "Available instances:"
    echo "$INSTANCES_JSON" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for inst in data:
    print(f\"  ID: {inst['id']}  Name: {inst['name']}  State: {inst['state']}\")
" 2>/dev/null || true
    exit 1
fi

echo "Resolved to userId: $USER_ID"

# ---------------------------------------------------------------------------
# 3. Call admin destroy endpoint via cloudflared access curl (Windows cloudflared from WSL)
# ---------------------------------------------------------------------------
echo "Destroying sandbox for userId: $USER_ID ..."

# Use Windows cloudflared.exe from WSL
# Try common install locations first
CLOUDFLARED=""
for path in \
    "/mnt/c/Program Files/Cloudflare/cloudflared.exe" \
    "/mnt/c/Users/$(cmd.exe /c 'echo %USERNAME%' 2>/dev/null | tr -d '\r')/AppData/Local/cloudflared/cloudflared.exe" \
    "/mnt/c/ProgramData/chocolatey/bin/cloudflared.exe" ; do
    [ -f "$path" ] && { CLOUDFLARED="$path"; break; }
done

# Fallback: search Users profile directories only
if [ -z "$CLOUDFLARED" ]; then
    CLOUDFLARED=$(find /mnt/c/Users -maxdepth 4 -name "cloudflared.exe" -type f 2>/dev/null | head -1 || true)
fi

if [ -z "$CLOUDFLARED" ] || [ ! -f "$CLOUDFLARED" ]; then
    echo "ERROR: cloudflared.exe not found on Windows. Install via: winget install --id Cloudflare.cloudflared"
    exit 1
fi

RESP=$("$CLOUDFLARED" access curl "$WORKER_URL/api/admin/destroy?userId=$USER_ID" -s -X POST 2>&1 || true)

if echo "$RESP" | grep -q '"status":"destroyed"'; then
    echo "Success: instance destroyed."
    echo "$RESP"
else
    echo "Destroy call returned:"
    echo "$RESP"
fi
