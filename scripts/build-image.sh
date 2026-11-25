#!/usr/bin/env bash
# Builds the image by hand from the pinned base, then runs the guard. For a machine behind TLS inspection,
# give the proxy's CA as AF_BUILD_CA: it reaches the build only as a BuildKit secret, so no layer keeps it.
#   AF_BUILD_CA=/path/to/bundle.crt scripts/build-image.sh agent-flare:mytag
# AF_NO_CACHE=1 rebuilds every layer; do that for anything going to production.
# AF_APT_MIRROR=http://mirrors.edge.kernel.org/ubuntu uses another Ubuntu mirror when archive.ubuntu.com is unreachable.
set -euo pipefail
cd "$(dirname "$0")/.."
TAG="${1:?usage: build-image.sh <tag>}"
args=(--pull --load --platform linux/amd64 --provenance=false -t "$TAG")
[ -n "${AF_BUILD_CA:-}" ] && args+=(--secret "id=build_ca,src=$AF_BUILD_CA")
[ -n "${AF_NO_CACHE:-}" ] && args+=(--no-cache)
[ -n "${AF_APT_MIRROR:-}" ] && args+=(--build-arg "AF_APT_MIRROR=$AF_APT_MIRROR")
docker buildx build "${args[@]}" .
scripts/check-image.sh "$TAG"
