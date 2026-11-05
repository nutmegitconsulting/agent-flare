#!/usr/bin/env bash
# Builds the image and tests everything that doesn't need Cloudflare:
#   1. af_state.py unit tests with the image's Python
#   2. The real webapp behind a simulated proxy: boot gate, port 443, silent sign-in
#   3. Stage -> squashfs -> restore -> verify round trip, with real Hermes state
# Usage: tests/container/run.sh [image]   (skips the build when an image is given)
set -euo pipefail
cd "$(dirname "$0")/../.."
IMAGE="${1:-}"
if [ -z "$IMAGE" ]; then
    IMAGE=agent-flare:test
    docker build -q -t "$IMAGE" . >/dev/null
fi
NAME="af-test-$$"
PY=/usr/local/bin/af-python
PYHOST=python3
HOME_DIR=/home/hermes/.hermes
HOST=agents.example.com
pass=0
ok() { echo "ok   - $1"; pass=$((pass + 1)); }
die() { echo "FAIL - $1"; docker logs --tail 40 "$NAME" 2>&1 | cut -c1-300; exit 1; }
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== unit tests"
docker run --rm --entrypoint "$PY" -v "$PWD/tests/container:/t:ro" "$IMAGE" /t/test_af_state.py 2>&1 | tail -4

echo "== webapp"
docker run -d --name "$NAME" -v "$PWD/tests/container:/t:ro" "$IMAGE" >/dev/null
sleep 4
dx() { docker exec -i "$NAME" bash -c "$1"; }
http() { dx "curl -s -H 'Host: $HOST' -H 'X-Forwarded-Proto: https' $1"; }

sleep 6
dx "pgrep -f '[h]ermes gateway' >/dev/null" && die "Hermes started before hydration" || ok "boot gate holds Hermes until hydrated"
dx "curl -s -m 2 http://127.0.0.1:443/api/health" >/dev/null 2>&1 && die "port 443 open before hydration" || ok "nothing on 443 before hydration"

dx "mkdir -p /run/agent-flare && cat > /run/agent-flare/auth.json" <<'J'
{"secret":"test-secret-test-secret-test-secret","sub":"user-1","email":"alice@example.com","name":"Alice","issuer":"https://t"}
J
dx "cat > /run/agent-flare/bundle.json" <<J
{"config_managed":{"webapp":{"enabled":true,"host":"0.0.0.0","port":443,"public_url":"https://$HOST"},
 "dashboard":{"trusted_proxies":["10.0.0.0/8","172.16.0.0/12","192.168.0.0/16","127.0.0.1"]}},
 "session_token":"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"}
J
dx "$PY /usr/local/lib/af_state.py apply $HOME_DIR /run/agent-flare/bundle.json && touch /run/agent-flare/ready" >/dev/null

for i in $(seq 1 120); do
    dx "curl -s -m 2 -o /dev/null -w '%{http_code}' -H 'Host: $HOST' http://127.0.0.1:443/api/health" 2>/dev/null | grep -q 200 && break
    [ "$i" = 120 ] && die "webapp never answered on 443"
    sleep 1
done
ok "webapp answers on 443 after hydration (${i}s)"

[ "$(http "-o /dev/null -w '%{http_code}' http://127.0.0.1:443/api/auth/me")" = 401 ] && ok "API refuses a request with no session" || die "API open without a session"

# A first-time browser: one page load, redirects followed, no credentials offered.
sim=$(dx "$PY /t/browser_sim.py $HOST")
echo "     $sim" | cut -c1-500
field() { echo "$sim" | "$PYHOST" -c "import json,sys;print(eval(sys.argv[1],json.load(sys.stdin)))" "$1"; }
[ "$(field 'final_status')" = 200 ] && ok "first page load ends at 200 with no login shown" || die "first load: $sim"
[ "$(field 'html')" = True ] && ok "webapp page served after sign-in" || die "no html"
[ "$(field '[h for h in hops if "/login" == h[1]]')" = "[]" ] && ok "login page never shown" || die "login page shown: $sim"
[ "$(field 'me["email"]')" = alice@example.com ] && ok "session identifies the Access user" || die "auth/me: $sim"
[ "$(field 'all(secure[c] for c in cookies)')" = True ] && ok "session cookies are Secure" || die "cookies not Secure: $sim"
[ "$(field 'ticket')" = True ] && ok "websocket ticket issued" || die "ws-ticket: $sim"
ws=$(dx "$PY /t/ws_sim.py $HOST" 2>&1 | tail -1)
echo "     $ws" | cut -c1-200
echo "$ws" | grep -q connected && ok "websocket connects through the public origin" || die "websocket: $ws"

echo "== state round trip"
dx "ls -la $HOME_DIR; du -sh $HOME_DIR" | cut -c1-100
dx "$PY - <<'P'
import sqlite3
c = sqlite3.connect('$HOME_DIR/state.db')
c.execute('CREATE TABLE IF NOT EXISTS af_roundtrip (v TEXT)')
c.execute(\"INSERT INTO af_roundtrip VALUES ('survived')\")
c.commit()
P"
dx "echo SECRET_KEY=hunter2 >> $HOME_DIR/.env"
dx "$PY /usr/local/lib/af_state.py stage $HOME_DIR /home/.agent-flare-stage" | cut -c1-400
dx "! grep -rl hunter2 /home/.agent-flare-stage" && ok "secrets absent from the staged tree" || die "secret leaked into stage"
dx "! test -e /home/.agent-flare-stage/webapp" && ok "webapp credential absent from the staged tree" || die "webapp dir staged"
dx "mksquashfs /home/.agent-flare-stage /tmp/s.sqsh -noappend -no-progress >/dev/null && ls -la /tmp/s.sqsh" | cut -c1-100
dx "rm -rf /tmp/restored && unsquashfs -f -q -d /tmp/restored /tmp/s.sqsh >/dev/null"
dx "$PY /usr/local/lib/af_state.py verify /tmp/restored" && ok "restored tree verifies" || die "restored tree failed verify"
v=$(dx "$PY -c \"import sqlite3;print(sqlite3.connect('/tmp/restored/state.db').execute('select v from af_roundtrip').fetchone()[0])\"")
[ "$v" = survived ] && ok "database row survived the round trip" || die "row lost: $v"

echo "PASS: $pass checks"
