# Agent Flare Onboarding Guide

End-to-end steps to get Hermes Desktop GUI talking to a Cloudflare Sandbox-backed agent.

This guide covers the **V9** architecture: install lives at `/opt/hermes-install` (outside the snapshot tree), mutable state at `/home/hermes` (including the tiny `hermes` wrapper sentinel), credentials in KV, and slot-filling retention pruning.

---

## Prerequisites

| Tool | Version / Note |
|---|---|
| Git | Any |
| Node.js | 22+ (for Wrangler) |
| npm | Comes with Node |
| Docker Desktop | Must be running during deploy (containers beta builds the image) |
| Cloudflared (Windows) | `winget install --id Cloudflare.cloudflared` |
| A Cloudflare account | With Workers, R2, KV, Tunnels, and Access enabled |

---

## Phase 1 — Clone & Install

```bash
git clone <repo-url>
cd hermes-cloudflare-v6
npm install
```

Authenticate Wrangler with your Cloudflare account:

```bash
npx wrangler login
```

---

## Phase 2 — Cloudflare Dashboard (One-Time Admin Setup)

### Step 1. Create the R2 Bucket

1. Go to **Cloudflare Dashboard → R2**
2. Click **Create bucket**
3. Name it `hermes-agent-state`
4. Region: default

This bucket stores squashfs backups (`backups/<id>/data.sqsh`), backup indexes (`users/<userId>/backups-index.json`), restore handles (`users/<userId>/backup-handle.json`), and provider configs (`users/<userId>/providers.json`).

### Step 2. Create the KV Namespace

1. Go to **Cloudflare Dashboard → Workers & Pages → KV**
2. Click **Create a namespace**
3. Name it `CREDENTIALS_KV`
4. Copy the **Namespace ID** — you will paste it into `wrangler.jsonc` in Step 5

This namespace stores **credentials only** (tunnel tokens, session tokens, gateway JWTs) so they never leak into third-party R2 backups.

### Step 3. Create a Cloudflare API Token

1. Go to **Cloudflare Dashboard → My Profile → API Tokens**
2. Click **Create Token**
3. Use **Custom token** with these minimum permissions:
   - **Account:Cloudflare Tunnel:Edit**
   - **Zone:DNS:Edit** (for the domain you'll use for tunnel hostnames)
   - **Account:Workers Scripts:Edit** (if not using wrangler login)
   - **Account:Workers AI:Read** (only if you plan to use AI Gateway `api_token` mode)
4. Account Resources: include your account
5. Zone Resources: include the zone you'll use for tunnel hostnames
6. Save the token value — this is `CF_API_TOKEN`

### Step 4. Note Account & Zone IDs

1. In the Cloudflare dashboard right sidebar, copy **Account ID** — this is `CF_ACCOUNT_ID`
2. On your zone's overview page, copy **Zone ID** — this is `CF_ZONE_ID`

### Step 5. Set Up Cloudflare Access

1. Go to **Cloudflare Zero Trust → Access → Applications**
2. Click **Add an application → Self-hosted**
3. Configure:
   - **Application name:** `hermes-agent` (or your preference)
   - **Session duration:** 24 hours
   - **Subdomain / Domain:** pick the same domain the Worker will use, e.g. `hermes-agent.hermes-test.app`
   - **Identity providers:** select your IdP(s)
   - **Policies:** add a rule allowing your email domain or specific users
4. Save
5. Copy the **Audience (AUD) Tag** from the application settings page — this is `ACCESS_AUD_TAG`

**Important:** The Worker's JWT validation checks this AUD tag. If you configure the wrong tag, every API call returns 401.

---

## Phase 3 — Repo Configuration

### Step 6. Configure wrangler.jsonc

The repo ships `wrangler.example.jsonc` as a sanitized template. Copy it and fill in your values:

```bash
cp wrangler.example.jsonc wrangler.jsonc
```

Edit `wrangler.jsonc`:

1. **KV namespace ID**: replace `YOUR_KV_NAMESPACE_ID` with the ID from Step 2
2. **Custom domain**: update the `routes` pattern to your domain (must match the Access app domain from Step 5)
3. **SSH authorized_keys** (optional, debugging only):
   - Uncomment the `authorized_keys` block
   - Replace with your own `ssh-ed25519` public key
   - Leave `ssh.enabled: true` for troubleshooting, or set `false` to disable

`wrangler.jsonc` is **gitignored** — never commit it.

### Step 7. Set Worker Secrets & Variables

Set secrets via Wrangler CLI (never commit these):

```bash
# Secret: the API token from Step 3
npx wrangler secret put CF_API_TOKEN

# Secret (optional): AI Gateway api_token mode credential
npx wrangler secret put CLOUDFLARE_AI_API_TOKEN
```

Set plain text variables via the **Cloudflare dashboard** (recommended — keeps them out of the repo):

1. Go to **Cloudflare Dashboard → Workers & Pages** → select your Worker
2. Select **Settings → Variables and Secrets**
3. Click **Add**
4. Select type **Text**, then enter each variable:
   - `ACCESS_AUD_TAG` = AUD tag from Step 5
   - `CF_ACCOUNT_ID` = Account ID from Step 4
   - `CF_ZONE_ID` = Zone ID from Step 4
   - `SNAPSHOT_INTERVAL_MINUTES` = `10` (snapshot cadence in minutes; prune runs every 2h via cron)
5. Click **Deploy**

Alternatively, you can pass plain text variables at deploy time with the `--var` flag:

```bash
npx wrangler deploy --var ACCESS_AUD_TAG:<your-aud> --var CF_ACCOUNT_ID:<your-account> --var CF_ZONE_ID:<your-zone> --var SNAPSHOT_INTERVAL_MINUTES:5
```

**Note:** `CF_API_TOKEN` must be a secret (encrypted). `ACCESS_AUD_TAG`, `CF_ACCOUNT_ID`, `CF_ZONE_ID`, and `SNAPSHOT_INTERVAL_MINUTES` are plain text variables — they should not be committed to the repo, but they do not require encryption.

**Deploy-order warning:** `npx wrangler deploy` deletes dashboard-set plain-text variables that are not in `wrangler.jsonc`. The configs in this repo set `keep_vars: true` to preserve dashboard-set vars across deploys — do not remove it. If your `wrangler.jsonc` lacks that flag, either add it or pass the variables at deploy time with `--var` (as above) *on every deploy*.

### Step 8. First Deploy

```bash
npx wrangler deploy
```

This builds the Docker image (V9 flare split), pushes it to Cloudflare's registry, and deploys the Worker. First deploy takes 5–10 minutes.

**For subsequent updates** (to force a fresh Hermes install rather than a cached Docker layer):

```bash
bash scripts/build-and-push.sh --deploy
```

The `--deploy` flag pushes the image and runs `wrangler deploy`.

---

## Phase 4 — Windows Client (Per-User Setup)

### Step 9. Install cloudflared on Windows

```powershell
winget install --id Cloudflare.cloudflared
```

Verify:

```powershell
cloudflared --version
```

### Step 10. Authenticate with Cloudflare Access

Open a browser and visit your Access application URL:

```
https://hermes-agent.yourdomain.com
```

Sign in via your identity provider. This establishes the Access session.

### Step 11. Run the Client Setup Script

From the repo directory on Windows (or copy `scripts/hermes-client.ps1` to the client machine):

```powershell
.\scripts\hermes-client.ps1
```

This script:
1. Authenticates with Cloudflare Access (opens browser if needed)
2. Calls `/api/client-init` to provision your tunnel + hostname
3. Calls `/api/wake` to start your sandbox container
4. Starts the local `cloudflared access tcp` proxy on `localhost:9119`

Expected output after init:

```json
{ "userId": "you@domain.com", "hostname": "hermes-you.hermes-test.app", "existing": false }
```

If `existing: true`, your tunnel was already provisioned.

### Step 12. Launch Hermes Desktop GUI

1. Open the Hermes Desktop App
2. Settings → Remote Gateway → set endpoint to `http://localhost:9119`
3. Connect

You should see the agent status as connected.

---

## Phase 5 — Daily Use

After the initial setup, the daily flow is:

```powershell
# Start the local proxy (if not already running)
cloudflared access tcp --hostname hermes-you.hermes-test.app --url localhost:9119

# Launch Hermes Desktop GUI
# It connects to localhost:9119 automatically
```

If the sandbox is sleeping (after 30 min idle), the first request will wake it automatically. Expect 5–10s cold start.

For a one-command start, run `hermes-client.ps1` again — it reuses existing credentials and only re-wakes if needed.

---

## Phase 6 — AI Gateway Custom Providers (Optional)

Route the agent's model calls through your Cloudflare AI Gateway. The Worker injects a `custom_providers:` section into the container's `config.yaml` on every wake (worker-owned, bannered — do not hand-edit it in the container; it is re-rendered from R2 every wake).

### One-time: Gateway Setup (Cloudflare Dashboard)

1. **AI → AI Gateway** → select/create your gateway.
2. **Custom domains** tab: assign a custom domain (e.g. `aigw.yourdomain.com`).
3. **Access** tab: enable Cloudflare Access for the gateway (auto-creates the Access app) and add an email policy for the user.

### Per-user: Deliver the Provider Config

1. Edit `scripts/reference-providers.json` for your gateway:
   - **`mode: "jwt"`** (custom domain + Access, per-user identity, `cf.user_id` attribution): set `base_url` to `https://<gateway-custom-domain>/openai/v1`. No `gateway_id`, no `extra_headers` — the Access JWT *is* the credential (`Authorization: Bearer *** verified at the Access edge) and the gateway selects itself via the domain.
   - **`mode: "api_token"`** (account-scoped endpoint, shared token): set `base_url` to `https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1`, set `gateway_id` to the gateway slug (the worker adds the `cf-aig-gateway-id` header automatically). The worker secret `CLOUDFLARE_AI_API_TOKEN` (a CF API token with **Workers AI:Read**) supplies the credential — set it with `npx wrangler secret put CLOUDFLARE_AI_API_TOKEN`.

2. Run the client with the gateway domain:

   ```powershell
   .\scripts\setup-client.ps1 -GatewayDomain https://aigw.yourdomain.com
   ```

   First run opens a second browser login (the gateway's Access app). The script stores the providers JSON + your gateway Access JWT in the worker (KV for JWT, R2 for provider config) and the following wake injects them. Re-run the script any time to refresh the JWT (session-scoped; containers don't outlive a session, so no refresh machinery is needed).

### Verify Providers Are Injected

```powershell
# Check providers stored in R2
cloudflared access curl "https://hermes-agent.yourdomain.com/api/admin/providers?userId=<you>" -s

# Wake and check the rendered count
cloudflared access curl "https://hermes-agent.yourdomain.com/api/wake" -s -X POST
# Look for "providersWritten" in the JSON response

# Inspect the rendered config.yaml inside the container
cloudflared access curl "https://hermes-agent.yourdomain.com/api/debug/exec?userId=<you>&cmd=cat%20/home/hermes/.hermes/config.yaml" -s
```

In the GUI, switch models to one of the injected IDs (e.g. `@cf/openai/gpt-oss-20b`). In the gateway dashboard, the request should show `cf.user_id` = your Access subject (JWT mode).

---

## Phase 7 — Architecture Notes (V9)

### Container Layout

| Path | Contents | In Snapshot? |
|---|---|---|
| `/opt/hermes-install` | Hermes code, venv, Node bundle, managed uv (~1.5–2 GB) | **No** |
| `/opt/uv` | uv-managed CPython | **No** |
| `/home/hermes/.hermes` | Runtime config, sessions, skills, caches (HERMES_HOME) | **Yes** |
| `/home/hermes/.local/bin/hermes` | Tiny launcher wrapper (sentinel file) | **Yes** |

The snapshot tree is `/home/hermes` — only mutable user state. The install is baked into the image at `/opt` and never backed up.

### Credentials

| Credential | Storage | Key |
|---|---|---|
| Tunnel token | KV | `cred:tunnel:<userId>` |
| Dashboard session token | KV | `cred:session:<userId>` |
| Gateway JWT | KV | `cred:gwjwt:<userId>` |
| Provider config (no secrets) | R2 | `users/<userId>/providers.json` |

### Persistence

- **Restore:** `/api/wake` calls `restoreLatest()` (extracts the newest handle into `/home/hermes`) and writes `/tmp/restore-done` to unblock the boot script.
- **Snapshots:** Worker cron fires every 10 minutes (`*/10 * * * *`); for each running user whose container is healthy, a snapshot is taken if the newest backup is older than `SNAPSHOT_INTERVAL_MINUTES`. The code default is 60 (hourly); this repo sets it to `10` via the `vars` block in `wrangler.jsonc`.
- **Pruning:** Worker cron fires every 2 hours (`0 */2 * * *`); slot-filling retention, newest-first: one backup per 5-minute slot for backups younger than 2h, one per hourly slot for backups younger than 24h, then the newest 5 distinct calendar-day slots and newest 5 distinct ISO-week slots (regardless of age), plus a safety rule that the absolute newest backup is never deleted; everything else is deleted.
- **Final snapshots:** `/api/admin/stop` and `/api/admin/destroy` take a best-effort final backup before stopping/destroying.
- **Integrity:** every snapshot and restore checks the sentinel file (`/home/hermes/.local/bin/hermes`) to detect partial extractions.

---

## Phase 8 — SSH Debugging (Troubleshooting Only)

Sandboxes ship with `ssh.enabled: true` so a running container can be reached with:

```bash
npx wrangler containers list                       # → application ID
npx wrangler containers instances <APP_ID>         # → instance IDs
npx wrangler containers ssh <INSTANCE_ID>
```

Requirements:
1. **sshd runs inside the container** — the image installs `openssh-server` and `start-hermes.sh` launches it.
2. **Your public key is in `authorized_keys`** — only `ssh-ed25519` keys are supported. Add yours to `wrangler.jsonc`.

The tunnel is authenticated by your Cloudflare account — no public port is exposed.

To disable SSH, set `ssh.enabled: false` in `wrangler.jsonc`.

---

## Troubleshooting

| Symptom | Cause & Fix |
|---|---|
| `missing Access JWT` or `invalid Access JWT` | Re-authenticate with Access in browser; get fresh JWT via `cloudflared access token -app=...` |
| `Tunnel not provisioned` | Run `client-init` first (or re-run `hermes-client.ps1`) |
| `cloudflared access tcp` hangs | Check that tunnel exists in Cloudflare dashboard → Tunnels; verify hostname matches |
| Hermes GUI can't connect | Verify `netstat -an` shows `127.0.0.1:9119` listening |
| Cold start > 10s | Normal for first wake after sleep; subsequent requests are fast |
| Container sleeps mid-session | Internal bash loop may not count as activity. Call `/api/wake` from a background script or accept the cold start. |
| Wake shows `restoreError` | Restore failed but container still boots. Check `wrangler tail` logs. |
| Wake shows `providersError` | Provider injection failed — container boots without custom providers. Check `wrangler tail`, fix `reference-providers.json`, re-run `setup-client.ps1`. |
| Provider entry skipped (`no Access JWT on file`) | Gateway JWT wasn't delivered. Finish the gateway Access browser login and re-run `setup-client.ps1 -GatewayDomain ...`. |
| Model calls 401/403 via gateway (JWT mode) | Gateway JWT expired or Access policy doesn't allow the user. Re-run the client script; check the gateway Access tab policies. |
| Model calls 401 (api_token mode) | `CLOUDFLARE_AI_API_TOKEN` secret missing or lacks Workers AI:Read permission. |
| Sentinel check fails after restore | `/home/hermes/.local/bin/hermes` is missing or 0 bytes. This means the backup is corrupt or from a V8-era handle. Delete `users/<userId>/backup-handle.json` from R2 and wake fresh. |

---

## Required Cloudflare Products Summary

| Product | Purpose | Free Tier |
|---|---|---|
| Cloudflare Workers + Sandbox | Backend runtime | 100,000 requests/day, 10 ms CPU/invocation |
| R2 | State snapshots | 10 GB storage, 1M Class A ops, 10M Class B ops |
| KV | Credentials storage | 100,000 reads/day, 1,000 writes/day, 1 GB storage |
| Cloudflare Tunnel | Secure connectivity | Unlimited |
| Cloudflare Access | SSO authentication | Up to 50 users (then $7/user/month) |

**Plan note:** Containers require the **Workers Paid plan ($5/month)** — the Workers Free plan does not support them (Containers pricing lists Free as N/A; billed usage applies for vCPU, memory, and disk on top of the plan). Workers, R2, KV, Tunnels, and Access are usable on the free tier within the limits shown above.

---

## Files Reference

| File | Purpose |
|---|---|
| `wrangler.jsonc` | Worker config (containers, DOs, R2 bucket, KV namespace, cron). **Gitignored** — copy from `wrangler.example.jsonc`. |
| `wrangler.example.jsonc` | Sanitized template for `wrangler.jsonc` |
| `src/index.ts` | Worker routes (`/api/client-init`, `/api/wake`, `/api/admin/*`, etc.) |
| `src/persistence.ts` | SDK-native state persistence (`createBackup` / `restoreBackup` to R2) |
| `src/prune.ts` | Slot-filling retention pruning (5-min → hourly → daily → weekly) |
| `src/credentials.ts` | KV credential access (tunnel, session, gateway JWT) |
| `src/providers.ts` | Per-user AI Gateway custom providers (R2 config → config.yaml/.env injection on wake) |
| `src/env.ts` | Worker environment type definitions |
| `scripts/hermes-client.ps1` | Main Windows client script (Access auth → init → wake → proxy) |
| `scripts/setup-client.ps1` | Gateway provider setup script (delivers `reference-providers.json` + JWT) |
| `scripts/reference-providers.json` | Reference provider config (edit per gateway, then delivered by `setup-client.ps1`) |
| `scripts/build-and-push.sh` | Force-rebuild the container image with `--no-cache` and deploy |
| `start-hermes.sh` | Container boot script (restore gate, starts cloudflared + hermes + sshd) |
| `Dockerfile` | V9 container image (flare split: `/opt/hermes-install` + `/home/hermes` snapshot tree) |
