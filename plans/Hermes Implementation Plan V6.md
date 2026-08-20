# Hermes Implementation Plan V6 — Cloudflare Sandbox + Desktop GUI

## Goal
Replace the current SSH tunnel (`ssh -N -L 9119:127.0.0.1:9119 hers@host`) with a Cloudflare-backed equivalent. Hermes Desktop GUI connects to `localhost:9119` (hardcoded requirement). The backend runs in Cloudflare Sandbox/DO with ephemeral container lifecycle, 30-minute idle timeout, and R2-backed state hydration.

## Architecture

```
┌─────────────────────────────┐      ┌──────────────────────────────┐
│  Windows Desktop            │      │  Cloudflare Edge             │
│  Hermes Desktop GUI           │      │  Cloudflare Access           │
│  → http://localhost:9119      │◄────►│  → hermes-agent.yourdomain   │
└──────────────┬──────────────┘      └──────────────┬───────────────┘
               │                                    │
               │  cloudflared access tcp            │  Cloudflare Tunnel
               │  --hostname ... --url localhost:9119 │  (tcp://localhost:9119)
               │                                    │
               └────────────────────────────────────┘
                                      │
                         ┌────────────┴────────────┐
                         │  Cloudflare Sandbox     │
                         │  Durable Object         │
                         │  DO identity persists   │
                         │  Container ephemeral    │
                         │  cloudflared tunnel run │
                         │  Hermes serve (9119)    │
                         └────────────┬────────────┘
                                      │
                         ┌────────────┴────────────┐
                         │  R2 (state snapshots)   │
                         │  users/<id>/*.sqfs      │
                         │  users/<id>/cloudflared/│
                         └─────────────────────────┘
```

## Components

### 1. Windows Desktop — Local TCP Listener

PowerShell command run once per session:

```powershell
cloudflared access tcp --hostname hermes-agent.yourdomain.com --url localhost:9119
```

- Opens `127.0.0.1:9119` locally.
- Wraps TCP in WebSocket, authenticates via Cloudflare Access SSO.
- Desktop GUI configured to `http://localhost:9119` (satisfies hardcoded 127.0.0.0/24 requirement).

**Source:** `developers.cloudflare.com/cloudflare-one/access-controls/applications/non-http/cloudflared-authentication/arbitrary-tcp/`

### 2. Sandbox Container — Tunnel Origin

Inside the Sandbox container, `cloudflared` runs with a tunnel token hydrated from R2:

```bash
cloudflared tunnel run --token "$TUNNEL_TOKEN"
```

Tunnel ingress configuration (remotely managed via Cloudflare API):

```yaml
ingress:
  - hostname: hermes-agent.yourdomain.com
    service: tcp://localhost:9119
  - service: http_status:404
```

**Note:** `tcp://` origin is required for `cloudflared access tcp` client-side proxy. Raw TCP bytes pass through transparently; Hermes HTTP/WebSocket payload is unaffected.

**Source:** `developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/protocols/`

### 3. Sandbox Lifecycle

```typescript
const sandbox = getSandbox(env.Sandbox, userId, {
  sleepAfter: "30m",
});
```

- After 30 minutes of inactivity, container sleeps (processes die, filesystem reset).
- On next request, DO wakes, new container starts, state is restored from R2.
- `keepAlive: false` by default; `setKeepAlive(true)` only during active Desktop sessions if needed.

**Source:** `developers.cloudflare.com/sandbox/configuration/sandbox-options/`

### 4. Token Provisioning & Storage

**Onboarding (one-time per user):**

```bash
# Create tunnel via Cloudflare API
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/tunnels" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  --json "{\"name\":\"hermes-$USER_ID\",\"config_src\":\"cloudflare\"}"

# Extract tunnel token from response, store in R2:
# r2://$STATE_BUCKET/users/$USER_ID/cloudflared/token
```

**Sandbox boot sequence:**

1. DO wakes → container starts.
2. Container downloads `users/$USER_ID/cloudflared/token` from R2.
3. `cloudflared tunnel run --token <token>` starts.
4. `restoreBackup()` pulls squashfs state snapshot from R2 to `/home/hermes`.
5. `hermes serve` starts on port 9119.
6. Tunnel connects to Cloudflare edge; hostname becomes reachable.

### 5. State Persistence (hermes-flare pattern)

**R2-backed squashfs snapshots:**

- `/home/hermes/.hermes` (sessions, skills, config, logs) included in snapshots.
- `/opt/hermes-install` excluded (separate install path).
- Sentinel file `/home/hermes/.local/bin/hermes` guards integrity.
- Throttled: snapshots every 4 hours, 3-day retention.

**Worker methods:**

```typescript
await sandbox.restoreBackup({
  dir: "/home/hermes",
  bucketName: env.STATE_BUCKET,
  key: `users/${userId}/state.sqfs`
});

// Periodic background save
await sandbox.createBackup({
  dir: "/home/hermes",
  bucketName: env.STATE_BUCKET,
  key: `users/${userId}/state.sqfs`
});
```

**Source:** `carimura/hermes-flare` (R2 squashfs persistence pattern)

### 6. Worker Entry Point

```typescript
import { getSandbox } from "@cloudflare/sandbox";
export { Sandbox } from "@cloudflare/sandbox";

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    const userId = getUserIdFromJWT(request); // JWT from Access

    const sandbox = getSandbox(env.Sandbox, userId, {
      sleepAfter: "30m",
    });

    // Ensure tunnel is running (idempotent if already connected)
    await ensureTunnelRunning(sandbox, env, userId);

    // Ensure state is restored (idempotent if sentinel file exists)
    await ensureStateRestored(sandbox, env, userId);

    // Return status / tunnel readiness
    return new Response(JSON.stringify({
      status: "ready",
      tunnel: "hermes-agent.yourdomain.com",
    }), { headers: { "Content-Type": "application/json" } });
  },
};

async function ensureTunnelRunning(sandbox, env, userId) {
  // Check if cloudflared is already running
  const ps = await sandbox.exec("pgrep -f 'cloudflared tunnel'");
  if (ps.exitCode !== 0) {
    const token = await env.STATE_BUCKET.get(`users/${userId}/cloudflared/token`).text();
    await sandbox.exec(`cloudflared tunnel run --no-autoupdate --token ${token}`);
  }
}

async function ensureStateRestored(sandbox, env, userId) {
  const sentinel = await sandbox.exec("test -f /home/hermes/.local/bin/hermes");
  if (sentinel.exitCode !== 0) {
    await sandbox.restoreBackup({
      dir: "/home/hermes",
      bucketName: env.STATE_BUCKET,
      key: `users/${userId}/state.sqfs`
    });
  }
}
```

### 7. Wrangler Configuration

```jsonc
{
  "containers": [{
    "class_name": "Sandbox",
    "image": "./Dockerfile",
    "instance_type": "lite",
    "max_instances": 1
  }],
  "durable_objects": {
    "bindings": [{ "class_name": "Sandbox", "name": "Sandbox" }]
  },
  "migrations": [{ "new_sqlite_classes": ["Sandbox"], "tag": "v1" }],
  "r2_buckets": [{ "binding": "STATE_BUCKET", "bucket_name": "hermes-state" }]
}
```

### 8. Dockerfile (No Custom cloudflared Install)

Use the official base image. `cloudflared` is NOT baked in. It is downloaded at runtime via the Worker if missing, or installed via `apt-get` inside the container start script.

```dockerfile
FROM docker.io/cloudflare/sandbox:0.7.0

# Hermes agent setup (no cloudflared here)
COPY --from=ghcr.io/nousresearch/hermes-agent:latest /opt/hermes /opt/hermes-install
RUN ln -s /opt/hermes-install/bin/hermes /usr/local/bin/hermes

# cloudflared will be installed at runtime by the Worker if not present
# This keeps the image lean and avoids custom image maintenance
```

**Alternative:** If runtime install is too slow on cold start, extend with `cloudflared` deb package. Trade-off: image size vs. startup time.

## Deployment Flow

1. **Admin provisions Cloudflare Tunnel** per user via API.
2. **Tunnel token stored** in R2 at `users/<id>/cloudflared/token`.
3. **User runs `setup-client.ps1`** on Windows:
   - Installs `cloudflared` if missing.
   - Runs `cloudflared access tcp --hostname hermes-agent.yourdomain.com --url localhost:9119`.
   - Prompts user to authenticate via browser (Cloudflare Access SSO).
4. **User opens Hermes Desktop GUI** → connects to `http://localhost:9119`.
5. **Worker receives first request** → wakes DO → starts container.
6. **Container boot:**
   - Hydrate token from R2.
   - Start `cloudflared tunnel run`.
   - Restore state from R2 squashfs.
   - Start `hermes serve` on port 9119.
7. **Traffic flows** through tunnel to Hermes agent.
8. **After 30 min idle** → container sleeps → tunnel disconnects.
9. **Next GUI request** → Worker wakes DO → repeat step 6 (state already restored, sentinel file prevents re-restore).

## Security

- **Cloudflare Access** gates the tunnel hostname. SSO required.
- **Tunnel is outbound-only.** No open inbound ports on the Sandbox.
- **Token is scoped** to a single tunnel per user. No shared tokens.
- **R2 state encrypted at rest** by Cloudflare. No custom encryption needed.
- **Sentinel file** prevents restoring corrupted/incomplete snapshots.

## Cost Considerations

- **Sandbox containers:** Billed per duration. `sleepAfter: "30m"` vs `keepAlive: true`.
  - 30m idle = sleep after 30 min, cold start on next use.
  - keepAlive = 24/7 active, higher cost.
- **Cloudflare Tunnel:** Free.
- **R2:** Storage + egress for squashfs snapshots. Minimal for text/config state.
- **Recommended:** Start with `sleepAfter: "30m"`. Switch to `keepAlive: true` only if cold start latency (5-10s) is unacceptable for interactive use.

## Differences from V5

| Aspect | V5 | V6 |
|--------|-----|-----|
| Backend | `@cloudflare/computer` | Cloudflare Sandbox + DO |
| Desktop → Backend | SSH tunnel | `cloudflared access tcp` |
| Persistence | None | R2 squashfs (hermes-flare) |
| Idle behavior | N/A (VM) | Sleep after 30 min |
| State hydration | None | Automatic on container wake |

## Open Questions

1. Does `cloudflared` need to be in the Docker image, or is runtime install acceptable?
2. Should `setup-client.ps1` also auto-enroll the Windows machine in Cloudflare WARP as fallback?
3. What is the observed cold start latency for Sandbox + R2 restore? Measure before deciding on `keepAlive`.
