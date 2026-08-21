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

# Set secrets
npx wrangler secret put CF_API_TOKEN
# Paste the token from Step 2

npx wrangler secret put UPLOAD_TOKEN
# Generate one: openssl rand -hex 32

# Add values to wrangler.jsonc (or use vars)
# ACCESS_AUD_TAG, CF_ACCOUNT_ID are public — add them as plain vars:
#   npx wrangler secret put ACCESS_AUD_TAG  (or use vars in dashboard)
```

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

Save as `hermes-connect.ps1`:

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
.\hermes-connect.ps1
```

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

- `wrangler.jsonc` — Worker config (containers, DOs, R2 bucket)
- `src/index.ts` — Worker routes (`/api/client-init`, `/api/wake`, `/internal/upload-snapshot`, etc.)
- `entrypoint.sh` — Container boot script (restores state, starts cloudflared + hermes, hourly snapshots)
- `Dockerfile` — Container image (cloudflared + squashfs-tools + hermes)
