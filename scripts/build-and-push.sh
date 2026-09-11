#!/usr/bin/env bash
# =============================================================================
# build-and-push.sh — rebuild the Hermes Sandbox image (no cache) and push it
# to the Cloudflare registry.
#
# WHY --no-cache: install.sh | bash is a RUN layer, and Docker's build cache
# reuses it silently — a plain rebuild after a Hermes release ships the OLD
# agent. This script forces a clean install layer, then VERIFIES the installed
# version inside the image BEFORE uploading ~1GB to the registry.
#
# Usage:
#   bash scripts/build-and-push.sh            # build + verify + push
#   bash scripts/build-and-push.sh --deploy   # also run `wrangler deploy`
#
# Prereqs: docker (daemon running), npx + wrangler (repo node_modules),
# wrangler authenticated (wrangler login).
# =============================================================================
set -euo pipefail

# --- Repo root (script lives in scripts/) ---
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

IMAGE_NAME="hermes-cloudflare-v6-hermessandbox"
IMAGE_TAG="worker"
IMAGE="${IMAGE_NAME}:${IMAGE_TAG}"
DEPLOY="${1:-}"

echo "==> Rebuilding ${IMAGE} with --no-cache (fresh Hermes install)..."
docker build --no-cache -f Dockerfile -t "$IMAGE" .

echo ""
echo "==> Verifying Hermes version inside the new image..."
VERSION_OUT="$(docker run --rm --entrypoint /bin/bash "$IMAGE" -c \
  'su hermes -c "HERMES_HOME=/home/hermes/.hermes /usr/local/bin/hermes --version" 2>&1')"
echo "$VERSION_OUT" | sed 's/^/    /'
# No freshness gate here: --no-cache is the freshness guarantee (the install
# layer re-runs every build). Hermes' "Up to date" line is unreliable inside
# the image (network update check as non-root can silently return nothing).

echo ""
echo "==> Pushing to Cloudflare registry..."
# Registry uploads are chunked and can fail transiently ("blob unknown to
# registry"); retry up to 3 times — already-uploaded layers are skipped.
for attempt in 1 2 3; do
    if npx wrangler containers push "$IMAGE" 2>&1 | tail -20; then
        break
    fi
    if [ "$attempt" -eq 3 ]; then
        echo "" >&2
        echo "ERROR: push failed after 3 attempts." >&2
        exit 1
    fi
    echo "==> Push attempt ${attempt} failed, retrying in 10s..."
    sleep 10
done

echo ""
echo "==> Push complete."
echo "    Image: ${IMAGE}"
docker images --format '{{.Repository}}:{{.Tag}}  {{.ID}}  {{.Size}}' | grep "^${IMAGE}" || true

if [ "$DEPLOY" = "--deploy" ]; then
    echo ""
    echo "==> Running wrangler deploy (activates the new image digest)..."
    npx wrangler deploy
    echo "==> Deploy complete."
else
    echo ""
    echo "NOTE: run 'npx wrangler deploy' (or re-run with --deploy) to point"
    echo "      the Worker at the new image digest."
fi
