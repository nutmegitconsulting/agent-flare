#!/bin/bash
# =============================================================================
# Hermes boot (CMD child of the /sandbox ENTRYPOINT).
#
# Boot gate: Hermes must never start on a tree the Worker hasn't finished
# hydrating. The Worker restores the latest snapshot, applies config and secrets,
# then creates READY_FILE. Starting earlier is what used to leave Hermes running
# on an empty home while a restore landed underneath it.
#
# Persistence is owned by the Worker. This script takes no snapshots.
# =============================================================================
set -u

READY_FILE=/run/agent-flare/ready

mkdir -p /run/agent-flare
chmod 700 /run/agent-flare

echo "[agent-flare] waiting for hydration"
while [ ! -f "$READY_FILE" ]; do
    sleep 0.25
done

# Hermes expects a supervisor: it exits to restart itself, and can crash. The webapp must come back
# without the container having to restart, or every request fails until someone stops it.
child=""
trap 'stop=1; [ -n "$child" ] && kill -TERM "$child" 2>/dev/null' TERM INT
stop=0
while [ "$stop" = 0 ]; do
    echo "[agent-flare] hydrated; starting gateway"
    hermes gateway run &
    child=$!
    wait "$child"
    code=$?
    [ "$stop" = 0 ] && echo "[agent-flare] gateway exited ($code); restarting" && sleep 2
done
