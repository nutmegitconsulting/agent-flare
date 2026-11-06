#!/usr/bin/env bash
# Builds the image by hand from the pinned base, then runs the guard. For a machine behind TLS inspection,
# give the proxy's CA as AF_BUILD_CA: it reaches the build only as a BuildKit secret, so no layer keeps it.
#   AF_BUILD_CA=/path/to/bundle.crt scripts/build-image.sh agent-flare:mytag
# AF_NO_CACHE=1 rebuilds every layer; do that for anything going to production.
set -euo pipefail
cd "$(dirname "$0")/.."
TAG="${1:?usage: build-image.sh <tag>}"
args=(--pull --load --platform linux/amd64 --provenance=false -t "$TAG")
[ -n "${AF_BUILD_CA:-}" ] && args+=(--secret "id=build_ca,src=$AF_BUILD_CA")
[ -n "${AF_NO_CACHE:-}" ] && args+=(--no-cache)
docker buildx build "${args[@]}" .
scripts/check-image.sh "$TAG"
