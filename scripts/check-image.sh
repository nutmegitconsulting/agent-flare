#!/usr/bin/env bash
# Guard: refuses an image that carries a build host's TLS inspection CA. Run before any push; a failure
# means don't push. Checks the image's env, its history, its base layers and every file on it.
#   scripts/check-image.sh <image>
# AF_FORBIDDEN_CA (optional): a PEM file whose certificates must appear nowhere in the image.
set -uo pipefail
cd "$(dirname "$0")/.."
IMAGE="${1:?usage: check-image.sh <image>}"
FORBIDDEN_CA="${AF_FORBIDDEN_CA:-}"
VARS='SSL_CERT_FILE|REQUESTS_CA_BUNDLE|NODE_EXTRA_CA_CERTS|UV_NATIVE_TLS|GIT_SSL_CAINFO|CURL_CA_BUNDLE'
failures=0
bad() { echo "FAIL - $1"; failures=$((failures + 1)); }
good() { echo "ok   - $1"; }

baked=$(docker image inspect "$IMAGE" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E "^($VARS)=" || true)
[ -z "$baked" ] && good "no CA variables in the image's env" || bad "CA variables in the image's env: $(echo "$baked" | cut -d= -f1 | xargs)"

history=$(docker history --no-trunc --format '{{.CreatedBy}}' "$IMAGE")
hits=$(echo "$history" | grep -E "$VARS|host-bundle|BEGIN CERTIFICATE|Gateway CA" | cut -c1-120 || true)
[ -z "$hits" ] && good "nothing about a CA in the image's history" || bad "CA traces in the image's history: $hits"

# The base layers must be upstream's, unchanged. A retag that only adds layers passes this and fails the checks around it.
BASE=$(sed -n 's/^ARG AF_BASE_IMAGE=//p' Dockerfile)
if docker pull -q "$BASE" >/dev/null; then
    upstream=$(docker image inspect "$BASE" --format '{{range .RootFS.Layers}}{{println .}}{{end}}')
    actual=$(docker image inspect "$IMAGE" --format '{{range .RootFS.Layers}}{{println .}}{{end}}' | head -n "$(echo "$upstream" | wc -l)")
    [ "$upstream" = "$actual" ] && good "base layers match the pinned upstream digest" || bad "base layers differ from $BASE"
else
    bad "could not pull $BASE to compare base layers"
fi

# Certificates by subject, then the forbidden CA's text anywhere, then any file setting the variables.
# shellcheck disable=SC2016
scan='
trap "exit 0" PIPE
for f in $(find / -xdev \( -path /proc -o -path /sys -o -path /forbidden.crt \) -prune -o -type f \( -name "*.crt" -o -name "*.pem" -o -name "cacert*" \) -print 2>/dev/null); do
  awk -v d=/tmp/af-c "/BEGIN CERT/{n++} n{print > (d n)}" "$f" 2>/dev/null
  for c in /tmp/af-c*; do
    [ -f "$c" ] || continue
    if openssl x509 -in "$c" -noout -subject 2>/dev/null | grep -qE "Gateway CA|Cloudflare for Teams"; then echo "CERT $f"; fi
    rm -f "$c"
  done
done
if [ -s /forbidden.crt ]; then
  grep -vE "^-----" /forbidden.crt | grep -E "^.{60,}" | head -6 > /tmp/af-needles
  grep -rlF -f /tmp/af-needles / --exclude-dir=proc --exclude-dir=sys --exclude=forbidden.crt --exclude=af-needles 2>/dev/null | sed "s/^/TEXT /"
fi
grep -rlE "^[[:space:]]*(export[[:space:]]+)?('"$VARS"')=" /etc /root /home/hermes /opt/hermes-install/.env 2>/dev/null | sed "s/^/VAR /"
exit 0
'
mount=()
[ -n "$FORBIDDEN_CA" ] && mount=(-v "$(realpath "$FORBIDDEN_CA"):/forbidden.crt:ro")
found=$(docker run --rm --network none --entrypoint /bin/bash "${mount[@]}" "$IMAGE" -c "$scan" | sort -u)
if [ -z "$found" ]; then
    good "no CA certificate or setting in any file"
else
    bad "CA traces on disk:"
    echo "$found" | head -20 | cut -c1-160
fi

if [ "$failures" -gt 0 ]; then
    echo "REFUSED: $IMAGE must not be pushed ($failures problem(s))"
    exit 1
fi
echo "PASS: $IMAGE is clean"
