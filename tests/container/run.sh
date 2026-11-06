#!/usr/bin/env bash
# Builds the image and tests everything that doesn't need Cloudflare:
#   1. af_state.py unit tests with the image's Python
#   2. The real webapp behind a simulated proxy: boot gate, port 9120, silent sign-in
#   3. A first launch with a template's provider: a real chat turn reaches the provider with its credential
#   4. Stage -> squashfs -> restore -> verify round trip, with real Hermes state
# Usage: tests/container/run.sh [image]   (skips the build when an image is given)
# Behind TLS inspection, set AF_BUILD_CA; see scripts/build-image.sh.
set -euo pipefail
cd "$(dirname "$0")/../.."
IMAGE="${1:-}"
if [ -z "$IMAGE" ]; then
    IMAGE=agent-flare:test
    scripts/build-image.sh "$IMAGE" >/dev/null
fi
NAME="af-test-$$"
PORT=9120
PY=/usr/local/bin/af-python
PYHOST=python3
HOME_DIR=/home/hermes/.hermes
HOST=agents.example.com
pass=0
ok() { echo "ok   - $1"; pass=$((pass + 1)); }
die() { echo "FAIL - $1"; docker logs --tail 40 "$NAME" 2>&1 | cut -c1-300; exit 1; }
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
start_hydrated() { # bundle JSON on stdin: what the Worker would send. Waits for the webapp.
    dx "cat > /run/agent-flare/bundle.json"
    dx "$PY /usr/local/lib/af_state.py apply $HOME_DIR /run/agent-flare/bundle.json && touch /run/agent-flare/ready"
    for i in $(seq 1 120); do
        dx "curl -s -m 2 -o /dev/null -w '%{http_code}' -H 'Host: $HOST' http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q 200 && return 0
        sleep 1
    done
    die "webapp never answered on $PORT"
}
new_container() {
    cleanup
    docker run -d --name "$NAME" -v "$PWD/tests/container:/t:ro" "$IMAGE" >/dev/null
    sleep 4
    dx "mkdir -p /run/agent-flare && cat > /run/agent-flare/auth.json" <<'J'
{"secret":"test-secret-test-secret-test-secret","sub":"user-1","email":"alice@example.com","name":"Alice","issuer":"https://t"}
J
}
PLATFORM='"webapp":{"enabled":true,"host":"0.0.0.0","port":9120,"public_url":"https://agents.example.com"},
 "dashboard":{"trusted_proxies":["10.0.0.0/8","172.16.0.0/12","192.168.0.0/16","100.64.0.0/10","127.0.0.1","::1","fc00::/7"]}'
PROVIDER='"custom_providers":[{"name":"team-gateway","base_url":"http://127.0.0.1:9555/v1","key_env":"TEAM_KEY","api_mode":"chat_completions",
 "discover_models":false,"extra_headers":{"cf-aig-gateway-id":"slug","cf-aig-metadata":"{\"user\":\"alice@example.com\"}"},"models":{"m1":{"context_length":64000},"..$⠀CF⠀Gemma⠀4⠀(64k)":{"context_length":64000},".$$⠀CF⠀Qwen⠀3⠀(64k)":{"context_length":64000},"$$$⠀CF⠀GLM⠀5⠀(64k)":{"context_length":64000},"*$$$⠀Claude⠀5⠀(64k)":{"context_length":64000}}}],
 "model_aliases":{"..$⠀CF⠀Gemma⠀4⠀(64k)":{"model":"@cf/google/gemma-4","provider":"team-gateway","base_url":"http://127.0.0.1:9555/v1"},
  ".$$⠀CF⠀Qwen⠀3⠀(64k)":{"model":"@cf/qwen/qwen-3","provider":"team-gateway","base_url":"http://127.0.0.1:9555/v1"},
  "$$$⠀CF⠀GLM⠀5⠀(64k)":{"model":"@cf/zai-org/glm-5","provider":"team-gateway","base_url":"http://127.0.0.1:9555/v1"},
  "*$$$⠀Claude⠀5⠀(64k)":{"model":"anthropic/claude-5","provider":"team-gateway","base_url":"http://127.0.0.1:9555/v1"}}'
CANDIDATES='"provider_candidates":[{"provider":"team-gateway","model":"m1","key_env":"TEAM_KEY"}]'

echo "== unit tests"
docker run --rm --entrypoint "$PY" -v "$PWD/tests/container:/t:ro" "$IMAGE" /t/test_af_state.py 2>&1 | tail -4

echo "== webapp"
dx() { docker exec -i "$NAME" bash -c "$1"; }
new_container
http() { dx "curl -s -H 'Host: $HOST' -H 'X-Forwarded-Proto: https' $1"; }

sleep 6
dx "pgrep -f '[r]unpy.*hermes' >/dev/null" && die "Hermes started before hydration" || ok "boot gate holds Hermes until hydrated"
dx "curl -s -m 2 http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && die "port $PORT open before hydration" || ok "nothing on $PORT before hydration"

docker exec -d "$NAME" "$PY" /t/stub_provider.py
report=$(start_hydrated <<J
{"config_managed":{$PLATFORM,$PROVIDER},"env":{"TEAM_KEY":"team-secret-value"},$CANDIDATES,
 "session_token":"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"}
J
)
ok "webapp answers on $PORT after hydration (${i:-?}s)"
echo "$report" | grep -q '"selected": "team-gateway"' && ok "first launch selects the template's provider" || die "selection: $report"
echo "$report" | grep -q team-secret-value && die "the report leaks a credential" || ok "the report names no credential"
dx "! grep -q team-secret-value $HOME_DIR/config.yaml" && ok "provider credential not in config.yaml" || die "credential in config.yaml"

[ "$(http "-o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/api/auth/me")" = 401 ] && ok "API refuses a request with no session" || die "API open without a session"

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

echo "== inference on first launch"
info=$(http "http://127.0.0.1:$PORT/api/model/info")
echo "$info" | "$PYHOST" -c 'import json,sys;d=json.load(sys.stdin);sys.exit(0 if (d["provider"],d["model"])==("team-gateway","m1") else 1)' && ok "Hermes reports the provider and model selected" || die "model info: $info"
dx "$PY /t/browser_sim.py $HOST" >/dev/null
chat=$(dx "$PY /t/chat_sim.py $HOST 2>/dev/null" | tail -1)
reply=$(echo "$chat" | "$PYHOST" -c 'import json,sys;print(json.load(sys.stdin).get("reply",""))')
[ "$reply" = stub-reply ] && ok "a real chat turn gets the provider's answer, with no setup" || die "chat: $(echo "$chat" | cut -c1-600)"
sent=$(dx "head -1 /tmp/stub.log")
echo "$sent" | grep -q '"auth": "Bearer team-secret-value"' && ok "the request carries the credential from .env" || die "auth sent: $(echo "$sent" | cut -c1-120)"
echo "$sent" | grep -q '"gw": "slug"' && echo "$sent" | grep -q 'alice@example.com' && ok "the request carries gateway and user tags" || die "headers: $sent"

echo "== tier marks in model names"
for pair in '..$⠀CF⠀Gemma⠀4⠀(64k)|@cf/google/gemma-4' '.$$⠀CF⠀Qwen⠀3⠀(64k)|@cf/qwen/qwen-3' '$$$⠀CF⠀GLM⠀5⠀(64k)|@cf/zai-org/glm-5' '*$$$⠀Claude⠀5⠀(64k)|anthropic/claude-5'; do
    want="${pair##*|}"; label="${pair%|*}"
    dx "$PY /t/browser_sim.py $HOST" >/dev/null
    dx ": > /tmp/stub.log"
    set_model=$(dx "curl -s -m 30 -X POST -H 'Host: $HOST' -H 'X-Forwarded-Proto: https' -H 'Origin: https://$HOST' -H 'Sec-Fetch-Site: same-origin' -H 'Content-Type: application/json' -H \"Cookie: \$(cat /tmp/cookie-header)\" -d '{\"scope\":\"main\",\"provider\":\"custom:team-gateway\",\"model\":\"$label\"}' http://127.0.0.1:$PORT/api/model/set")
    echo "     $set_model" | cut -c1-160
    chat=$(dx "$PY /t/chat_sim.py $HOST 2>/dev/null" | tail -1)
    [ "$(echo "$chat" | "$PYHOST" -c 'import json,sys;print(json.load(sys.stdin).get("reply",""))')" = stub-reply ] || die "pick '$label': $(echo "$chat" | cut -c1-500)"
    dx "grep -q '\"model\": \"$want\"' /tmp/stub.log" && ok "picking '$label' sends $want upstream" || die "pick '$label' sent: $(dx 'cat /tmp/stub.log' | cut -c1-300)"
    dx "! grep -qE '\"model\": \"[.\$*]' /tmp/stub.log" && ok "the name with its mark never goes upstream" || die "label went upstream"
    dx "! grep -q 'default: [\x27\"]*[.\$*]' $HOME_DIR/config.yaml" && ok "the saved model is the real ID" || die "label saved as the model"
done

echo "== supervision"
gateway_pid() { dx "$PY -c \"import json;print(json.load(open('$HOME_DIR/gateway.pid'))['pid'])\""; }
before=$(gateway_pid)
dx "kill -9 $before"
sleep 3
for i in $(seq 1 90); do
    [ "$(http "-m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/api/health" || true)" = 200 ] && break
    [ "$i" = 90 ] && die "webapp did not come back after the gateway died"
    sleep 1
done
after=$(gateway_pid)
[ -n "$before" ] && [ -n "$after" ] && [ "$before" != "$after" ] && ok "webapp comes back after the gateway dies (${i}s)" || die "gateway process did not change: $before $after"

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

echo "== first launch with the provider's secret missing"
new_container
docker exec -d "$NAME" "$PY" /t/stub_provider.py
report=$(start_hydrated <<J
{"config_managed":{$PLATFORM},$CANDIDATES,"session_token":"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"}
J
)
ok "the container still starts"
echo "$report" | grep -q '"selected": null' && echo "$report" | grep -q '"missing": \["TEAM_KEY"\]' && ok "the report says what's missing, by name" || die "report: $report"
dx "! grep -qE '^model:' $HOME_DIR/config.yaml" && ok "nothing is selected that can't answer" || die "a provider with no credential was selected"
dx "$PY /t/browser_sim.py $HOST" >/dev/null
chat=$(dx "$PY /t/chat_sim.py $HOST 2>/dev/null" | tail -1)
echo "     $(echo "$chat" | "$PYHOST" -c 'import json,sys;d=json.load(sys.stdin);print(d.get("setup.status"),d.get("error"),d.get("reply"))' | cut -c1-300)"
echo "$chat" | "$PYHOST" -c 'import json,sys;sys.exit(0 if json.load(sys.stdin)["setup.status"].get("provider_configured") is False else 1)' && ok "Hermes shows setup instead of failing silently" || die "setup status: $(echo "$chat" | cut -c1-400)"
dx "! test -s /tmp/stub.log" && ok "no request went out with a placeholder credential" || die "a request went out: $(dx 'cat /tmp/stub.log' | cut -c1-200)"

echo "PASS: $pass checks"
