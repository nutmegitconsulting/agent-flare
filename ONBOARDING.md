# Hermes V6 Onboarding Guide

End-to-end steps to get Hermes Desktop GUI talking to a Cloudflare Sandbox-backed agent.

---

## Phase 1 — Cloudflare (One-Time Admin Setup)

### Step 1. Create R2 Bucket

1. Go to **Cloudflare Dashboard → R2**
2. Click **Create bucket**
3. Name it `hermes-agent-state`
4. Region: default

### Step 2. Create Cloudflare API Token

1. Go to **Cloudflare Dashboard → My Profile → API Tokens**
2. Click **Create Token**
3. Use **Custom token** with these permissions:
   - **Account:Cloudflare Tunnel:Edit**
   - **Zone:DNS:Edit** (for the domain you'll use for tunnel hostnames)
   - **Account:R2:Read & Write**
4. Account Resources: include your account
5. Save the token value — this is `CF_API_TOKEN`
6. [REDACTED - ROTATED]

### Step 3. Note Your Account ID

1. In the Cloudflare dashboard right sidebar, copy **Account ID**
2. This is `CF_ACCOUNT_ID`
3. [REDACTED-CF-ACCOUNT-ID]

### Step 4. Set Up Cloudflare Access Application

1. Go to **Cloudflare Zero Trust → Access → Applications**
2. Click **Add an application**
3. Select **Self-hosted**
4. Configure:
   - **Application name:** `hermes-agent`
   - **Session duration:** 24 hours
   - **Subdomain / Domain:** pick any domain in your account, e.g. `hermes-agent.yourdomain.com`
   - **Identity providers:** select your IdP(s) (e.g., Google, Okta, Azure AD)
   - **Policies:** add a rule allowing your email domain or specific users
5. Save
6. Copy the **Audience (AUD) Tag** from the application settings page — this is `ACCESS_AUD_TAG`
7. [REDACTED-CF-ACCESS-AUD]

### Step 5. Deploy the Worker

From the repo directory:

```bash
cd /home/user/projects/hermes-cloudflare-v6

# Set Worker-level secrets
npx wrangler secret put CF_API_TOKEN
# Paste the token from Step 2
```

**Set public vars via the Cloudflare dashboard** (not in the repo):

1. In the Cloudflare dashboard, go to **Workers & Pages** → select your Worker
2. Select **Settings**
3. Under **Variables and Secrets**, select **Add**
4. Select type **Text**, input the variable name, and input its value:
   - `ACCESS_AUD_TAG` = your AUD tag from Step 4
   - `CF_ACCOUNT_ID` = your account ID from Step 3
5. Select **Deploy** to implement your changes

These are stored in Cloudflare's platform, not your repo.

**Important:** Do not put `ACCESS_AUD_TAG` or `CF_ACCOUNT_ID` in `wrangler.jsonc` if you plan to publish the repo — they would be exposed.

Deploy:

```bash
npx wrangler deploy
```

Note the deployed Worker URL: `https://hermes-cloudflare-v6.your-account.workers.dev`

---

## Phase 2 — Windows Client (Per-User Setup)

### Step 6. Install cloudflared on Windows

```powershell
winget install --id Cloudflare.cloudflared
```

Or download directly from https://github.com/cloudflare/cloudflared/releases/latest

Verify:

```powershell
cloudflared --version
```

### Step 7. Authenticate with Cloudflare Access

Open browser and visit your Access application URL:

```
https://hermes-agent.yourdomain.com
```

Sign in via your identity provider. This establishes the Access session cookie in your browser.

### Step 8. Get Your Cloudflare Access JWT Token

The Worker API requires a valid Access JWT. To get one for API calls:

**Option A — Browser DevTools (quick):**
1. Open `https://hermes-agent.yourdomain.com` in browser (already signed in)
2. Open DevTools → Network tab
3. Reload page
4. Click any request → Headers → find `CF-Access-Jwt-Assertion`
5. Copy the value — this is your `$JWT_TOKEN`

**Option B — cloudflared token command:**

```powershell
cloudflared access token -app=https://hermes-agent.yourdomain.com
```

This prints a JWT if you're already authenticated.

### Step 9. Provision Your Tunnel (One-Time Per User)

```powershell
$WORKER_URL = "https://hermes-cloudflare-v6.your-account.workers.dev"
$JWT_TOKEN = "paste-your-jwt-here"

# Init tunnel
Invoke-RestMethod -Uri "$WORKER_URL/api/client-init" `
  -Method POST `
  -Headers @{ "CF-Access-Jwt-Assertion" = $JWT_TOKEN } `
  -ContentType "application/json"
```

Expected response:

```json
{ "userId": "you@domain.com", "hostname": "hermes-you@domain.com.yourdomain.com", "existing": false }
```

If `existing: true`, your tunnel was already provisioned.

### Step 10. Wake the Sandbox

```powershell
Invoke-RestMethod -Uri "$WORKER_URL/api/wake" `
  -Method POST `
  -Headers @{ "CF-Access-Jwt-Assertion" = $JWT_TOKEN } `
  -ContentType "application/json"
```

This creates/reuses your sandbox container and injects the tunnel token.

### Step 11. Start Local TCP Proxy

```powershell
$HOSTNAME = "hermes-you@domain.com.yourdomain.com"
cloudflared access tcp --hostname $HOSTNAME --url localhost:9119
```

Leave this running in a PowerShell window. It opens `127.0.0.1:9119` locally.

**Verify it's listening:**

```powershell
netstat -an | Select-String "9119"
```

You should see `TCP    127.0.0.1:9119    0.0.0.0:0    LISTENING`.

### Step 12. Launch Hermes Desktop GUI

1. Open Hermes Desktop App
2. Settings → Remote Gateway → set endpoint to `http://localhost:9119`
3. Connect

You should see the agent status as connected.

---

## Phase 3 — Daily Use (After First Setup)

After the initial setup, the daily flow is:

```powershell
# 1. Start the local proxy (if not already running)
cloudflared access tcp --hostname hermes-you@domain.com.yourdomain.com --url localhost:9119

# 2. Launch Hermes Desktop GUI
# It connects to localhost:9119 automatically
```

If the sandbox is sleeping (after 30 min idle), the first request will wake it automatically. Expect 5–10s cold start.

---

## Phase 4 — Full Automation Script

Save as `scripts/hermes-connect.ps1`:

```powershell
param(
  [string]$WorkerUrl = "https://hermes-cloudflare-v6.your-account.workers.dev",
  [string]$Hostname = "hermes-you@domain.com.yourdomain.com"
)

# Step 1: Get Access JWT (requires browser auth first time)
$jwt = cloudflared access token -app="https://hermes-agent.yourdomain.com" 2> $null
if (-not $jwt) {
  Write-Host "Not authenticated with Cloudflare Access. Opening browser..."
  Start-Process "https://hermes-agent.yourdomain.com"
  Read-Host "Sign in, then press Enter to continue"
  $jwt = cloudflared access token -app="https://hermes-agent.yourdomain.com"
}

# Step 2: Wake sandbox
Write-Host "Waking sandbox..."
Invoke-RestMethod -Uri "$WorkerUrl/api/wake" -Method POST `
  -Headers @{ "CF-Access-Jwt-Assertion" = $jwt } | Out-Null

# Step 3: Start TCP proxy
Write-Host "Starting local proxy on localhost:9119..."
cloudflared access tcp --hostname $Hostname --url localhost:9119
```

Run:

```powershell
.\scripts\hermes-connect.ps1
```

---

## Phase 5 — AI Gateway Custom Providers (Optional, V8)

Route the agent's model calls through your Cloudflare AI Gateway. The
worker injects a `custom_providers:` section into the container's
`config.yaml` on wake (worker-owned, bannered — do not hand-edit it in the
container; it is re-rendered from R2 every wake).

### One-time: gateway setup (Cloudflare dashboard)

1. AI > AI Gateway → select/create your gateway.
2. **Custom domains** tab: assign a custom domain (e.g. `ai-gw.yourdomain.com`).
3. **Access** tab: enable Cloudflare Access for the gateway (auto-creates the
   Access app) and add an email policy for the user.

### Per-user: deliver the provider config

1. Edit `scripts/reference-providers.json` for your gateway:
   - **`mode: "jwt"`** (custom domain + Access, per-user identity,
     `cf.user_id` attribution): set `base_url` to
     `https://<gateway-custom-domain>/openai/v1`. No `gateway_id`, no
     `extra_headers` — the Access JWT *is* the credential
     (`Authorization: Bearer <JWT>`, verified at the Access edge) and the
     gateway selects itself via the domain.
   - **`mode: "api_token"`** (account-scoped endpoint, shared token): set
     `base_url` to
     `https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1`,
     set `gateway_id` to the gateway slug (the worker adds the
     `cf-aig-gateway-id` header automatically). The worker secret
     `CLOUDFLARE_AI_API_TOKEN` (a CF API token with **Workers AI:Read**)
     supplies the credential — set it with
     `echo <token> | npx wrangler secret put CLOUDFLARE_AI_API_TOKEN`.
2. Run the client with the gateway domain:

   ```powershell
   .\scripts\setup-client.ps1 -GatewayDomain https://ai-gw.yourdomain.com
   ```

   First run opens a second browser login (the gateway's Access app). The
   script stores the providers JSON + your gateway Access JWT in the worker
   (R2, per-user) and the following wake injects them. Re-run the script any
   time to refresh the JWT (session-scoped; this project's containers don't
   outlive a session, so no refresh machinery is needed).

### Verify

```powershell
# providers stored?
cloudflared access curl "$WorkerUrl/api/admin/providers?userId=<you>" -s
# wake, then check the rendered section
cloudflared access curl "$WorkerUrl/api/wake" -s -X POST   # look for providersWritten: 1
cloudflared access curl "$WorkerUrl/api/debug/exec?userId=<you>&cmd=cat%20/home/hermes/.hermes/config.yaml" -s
```

In the GUI, switch models to one of the injected ids (e.g.
`@cf/openai/gpt-oss-20b`). In the gateway dashboard, the request should show
`cf.user_id` = your Access subject (jwt mode).

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `missing Access JWT` | Re-authenticate with Access in browser; get fresh JWT |
| `Tunnel not provisioned` | Run `/api/client-init` first |
| `cloudflared access tcp` hangs | Check that tunnel exists in Cloudflare dashboard → Tunnels |
| Hermes GUI can't connect | Verify `netstat` shows `127.0.0.1:9119` listening |
| Cold start > 10s | Normal for first wake after sleep; subsequent requests are fast |
| Container sleeps mid-session | Internal bash loop may not count as activity. If this happens, call `/api/wake` from a background script or accept the cold start. |
| Wake shows `providersError` | Provider injection failed — the container still boots (no custom providers). Check `wrangler tail` logs, fix `reference-providers.json`, re-run the client. |
| Provider entry skipped (`no Access JWT on file`) | The gateway JWT wasn't delivered. Finish the gateway Access browser login and re-run `setup-client.ps1 -GatewayDomain ...`. |
| Model calls 401/403 via gateway (jwt mode) | Gateway JWT expired or Access policy doesn't allow the user. Re-run the client script; check the gateway Access tab policies. |
| Model calls 401 (api_token mode) | `CLOUDFLARE_AI_API_TOKEN` secret missing or lacks Workers AI:Read permission. |

---

## Required Cloudflare Products Summary

| Product | Purpose | Cost |
|---------|---------|------|
| Cloudflare Workers + Sandbox | Backend runtime | Free tier: 100k req/day |
| R2 | State snapshots | Free tier: 10GB storage |
| Cloudflare Tunnel | Secure connectivity | Free |
| Cloudflare Access | SSO authentication | Free (up to 50 users) |

---

## Files Reference

- `wrangler.jsonc` — Worker config (containers, DOs, R2 bucket, cron)
- `src/index.ts` — Worker routes (`/api/client-init`, `/api/wake`, `/api/admin/*`, etc.)
- `src/persistence.ts` — SDK-native state persistence (`createBackup` / `restoreBackup` to R2)
- `src/providers.ts` — V8 per-user AI Gateway custom providers (R2 → config.yaml/.env injection on wake)
- `scripts/reference-providers.json` — V8 reference provider config (edit per gateway, then delivered by the client)
- `start-hermes.sh` — Container boot script (restore gate, starts cloudflared + hermes)
- `Dockerfile` — Container image (cloudflared + squashfs-tools + hermes)
