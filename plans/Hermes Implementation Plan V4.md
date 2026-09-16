# **Hermes Cloudflare — Serverless Zero Trust Implementation Plan V4**

**Date:** 2026-07-31

**Architecture:** Cloudflare Pages (React UI) \+ Cloudflare Worker (API Gateway) \+ Cloudflare Containers (per-user agent) \+ R2 (persistence)

**Auth:** Cloudflare Access (SSO/WARP) — shared-secret gate removed

## **Overview**

Deploy a multi-tenant Hermes Agent serverlessly on Cloudflare. The React web UI is extracted from the open-source Hermes repo, compiled, and hosted on Cloudflare Pages behind Cloudflare Access. A separate Cloudflare Worker acts as the API gateway, validating Access JWTs and routing to per-user Container Sandboxes. A third lightweight Updater Worker checks GitHub releases daily and triggers Pages rebuilds when the upstream UI changes.

## **Architecture**

Browser (any device)  
    │ HTTPS  
    ▼  
hermes-cloudflare.pages.dev  (Cloudflare Pages \+ Access)  
    ├─ Static React assets (HTML/CSS/JS)  
    └─ /api/\* → \_worker.js proxies to API Worker  
        │  (JWT header forwarded)  
        ▼  
hermes-cloudflare.hermes-test-439.workers.dev  (API Worker)  
    ├─ Validate CF-Access-Jwt-Assertion (using Pages AUD tag)  
    ├─ Extract user\_email → user\_id  
    ├─ getSandbox(env.Agent, user\_id) → per-tenant Container  
    ├─ restoreBackup() on cold start (R2)  
    └─ proxy fetch() → Container port 8642  
            │  
            ▼  
Cloudflare Container (per user)  
    ├─ start-hermes.sh → writes config, starts gateway  
    ├─ hermes gateway run → port 8642  
    ├─ /opt/data \= sessions, memories, skills  
    └─ createBackup(/opt/data) → R2 users/\<email\>/

## **Phase 1: API Worker (\~/projects/hermes\_cloudflare/deploy/)**

### **1.1 Clean slate — overwrite existing files**

The existing src/index.ts has a shared-secret gate (403 on missing Bearer token). The new Worker:

* **Only validates CF-Access-Jwt-Assertion** (no shared-secret gate)  
* Extracts user email from JWT sub or email claim  
* Uses email as user\_id for sandbox \+ R2 prefix  
* Returns 401 if JWT is missing or invalid  
* Proxies to container via sandbox.fetch()

### **1.2 Worker files**

| File | Purpose |
| :---- | :---- |
| wrangler.jsonc | Worker config: name: "hermes-cloudflare", container basic (1GB), DO binding Agent, R2 BACKUP\_BUCKET, cron \*/5 \* \* \* \* |
| src/index.ts | Hono Worker: JWT validation (Requires ACCESS\_AUD\_TAG env var), user extraction, sandbox proxy, health endpoint |
| src/env.ts | Env interface: Agent: DurableObjectNamespace\<Sandbox\>, BACKUP\_BUCKET: R2Bucket, ACCESS\_AUD\_TAG: string |
| src/agent.ts | class Agent extends Sandbox — exported for DO binding |
| src/persistence.ts | R2 backup/restore: restoreIfNeeded(), createSnapshot(), ensureGatewayRunning() |
| Dockerfile | Extends nousresearch/hermes-agent:latest, injects start-hermes.sh |
| start-hermes.sh | Minimal entrypoint: writes config.yaml, exec hermes gateway run |

### **1.3 JWT validation logic**

// Pseudocode for src/index.ts  
app.use("\*", async (c, next) \=\> {  
  const jwt \= c.req.header("CF-Access-Jwt-Assertion");  
  if (\!jwt) return c.text("missing Access JWT", 401);  
    
  // MUST validate against the Audience (AUD) tag of the Cloudflare Pages Access App  
  const payload \= await validateJWT(jwt, CF\_ACCESS\_CERTS\_URL, c.env.ACCESS\_AUD\_TAG);  
  const userEmail \= payload.email || payload.sub;  
  c.set("userId", userEmail);  
  await next();  
});

app.all("/\*", async (c) \=\> {  
  const userId \= c.get("userId");  
  const sandbox \= await getSandbox(c.env.Agent, userId);  
  await ensureGatewayRunning(sandbox, c.env.BACKUP\_BUCKET, userId);  
  return sandbox.fetch(c.req.raw);  
});

**Note:** The CF-Access-Jwt-Assertion header is injected by Cloudflare Access at the edge. The Pages \_worker.js forwards it to the API Worker.

## **Phase 2: Pages UI (\~/projects/hermes\_cloudflare/pages/)**

### **2.1 Directory structure**

pages/  
├── build-ui.sh           \# Clone Hermes repo, build web/, copy to dist/  
├── \_worker.js            \# Pages Function: serve static, proxy /api/\* to Worker  
├── wrangler.toml         \# Pages project config  
└── dist/                 \# Build output (gitignored)

### **2.2 Build script (build-ui.sh)**

Executed inside the Cloudflare Pages build environment:

\#\!/usr/bin/env bash  
set \-euo pipefail

\# Clone Hermes repo (public)  
git clone \--depth 1 https://github.com/nousresearch/hermes-agent.git /tmp/hermes

cd /tmp/hermes/web

\# Install dependencies  
npm install

\# Build for production  
\# The web app uses relative /api/\* URLs in production (no HERMES\_DASHBOARD\_URL override needed)  
npm run build

\# Copy build output to explicit local Pages dist directory  
mkdir \-p "$PWD/../../dist"  
cp \-r /tmp/hermes/hermes\_cli/web\_dist/\* "$PWD/../../dist/"

### **2.3 Pages \_worker.js**

export default {  
  async fetch(request, env, ctx) {  
    const url \= new URL(request.url);  
      
    if (url.pathname.startsWith("/api/")) {  
      // Forward API requests to the Worker with all headers intact  
      // CF-Access-Jwt-Assertion is forwarded automatically  
      const apiUrl \= env.API\_WORKER\_URL \+ url.pathname \+ url.search;  
      return fetch(apiUrl, request);  
    }  
      
    // Serve static assets from Pages  
    return env.ASSETS.fetch(request);  
  }  
};

**Environment variable:** API\_WORKER\_URL \= https://hermes-cloudflare.hermes-test-439.workers.dev

### **2.4 Pages deployment**

npx wrangler pages project create hermes-cloudflare-pages  
npx wrangler pages deploy dist/ \--project-name=hermes-cloudflare-pages

## **Phase 3: Updater Worker (\~/projects/hermes\_cloudflare/updater/)**

### **3.1 Directory structure**

updater/  
├── src/  
│   └── index.ts          \# Cron-triggered: check GitHub releases, trigger Pages deploy  
├── wrangler.jsonc        \# Cron trigger daily, KV binding VERSION\_CACHE  
└── package.json

### **3.2 Cron logic**

export default {  
  async scheduled(controller, env, ctx) {  
    // 1\. Fetch latest GitHub release  
    const res \= await fetch("https://api.github.com/repos/nousresearch/hermes-agent/releases/latest", {  
      headers: { "User-Agent": "hermes-cloudflare-updater" }  
    });  
    const release \= await res.json();  
    const newVersion \= release.tag\_name;  
      
    // 2\. Read cached version from KV  
    const cachedVersion \= await env.VERSION\_CACHE.get("latest");  
      
    // 3\. Compare  
    if (cachedVersion \!== newVersion) {  
      // 4\. Trigger Pages deploy via webhook  
      const webhookRes \= await fetch(env.PAGES\_DEPLOY\_WEBHOOK, { method: "POST" });  
      if (webhookRes.ok) {  
        await env.VERSION\_CACHE.put("latest", newVersion);  
      }  
    }  
  }  
};

### **3.3 Wrangler config**

{  
  "name": "hermes-cloudflare-updater",  
  "main": "src/index.ts",  
  "compatibility\_date": "2026-07-01",  
  "triggers": { "crons": \["0 0 \* \* \*"\] },  
  "kv\_namespaces": \[  
    { "binding": "VERSION\_CACHE", "id": "..." }  
  \]  
}

**Secrets:** PAGES\_DEPLOY\_WEBHOOK (set via wrangler secret put)

## **Phase 4: Access Configuration**

### **4.1 Pages Access app**

1. Cloudflare Zero Trust Dashboard → Access → Applications  
2. Create Application:  
   * Type: Self-hosted  
   * Domain: hermes-cloudflare.pages.dev (or custom domain)  
   * Policy: Allow → Email → <your-email@example.com>  
   * Session: 24h  
3. Save and Deploy  
4. **Copy the Application Audience (AUD) Tag for the API Worker environment.**

### **4.2 API Worker Access app**

1. Create Application:  
   * Type: Self-hosted  
   * Domain: hermes-cloudflare.hermes-test-439.workers.dev  
   * Policy: Allow → Service Auth (to allow the Pages function to proxy if strictly routing edge-to-edge) OR bypass if relying entirely on internal Worker-to-Worker fetch.  
2. Save and Deploy

## **Phase 5: Deploy Script**

### **5.1 deploy.sh (\~/projects/hermes\_cloudflare/deploy/scripts/)**

\#\!/usr/bin/env bash  
set \-euo pipefail

cd "$(dirname "$0")/.."

ACCOUNT\_ID="[REDACTED-CF-ACCOUNT-ID]"  
WORKER\_NAME="hermes-cloudflare"  
WORKERS\_URL="https://${WORKER\_NAME}.hermes-test-439.workers.dev"

echo "=== Hermes Cloudflare Deploy \==="

\# 1\. Deploy API Worker  
echo "\[1/3\] Deploying API Worker..."  
npx wrangler deploy \--containers-rollout=none

\# 2\. Set secrets  
echo "\[2/3\] Setting secrets..."  
\# No HERMES\_GATEWAY\_TOKEN needed — Access handles auth  
\# AI\_GATEWAY\_TOKEN is still used by the container for LLM calls  
read \-rp "AI\_GATEWAY\_TOKEN: " AI\_GATEWAY\_TOKEN  
echo "${AI\_GATEWAY\_TOKEN}" | npx wrangler secret put AI\_GATEWAY\_TOKEN

echo "=== Deploy Complete \==="  
echo "API Worker: ${WORKERS\_URL}"  
echo ""  
echo "Next steps:"  
echo "  1\. Add the Pages Access AUD tag to the API Worker via: npx wrangler secret put ACCESS\_AUD\_TAG"  
echo "  2\. cd \~/projects/hermes\_cloudflare/pages/ && bash deploy-pages.sh"  
echo "  3\. cd \~/projects/hermes\_cloudflare/updater/ && bash deploy-updater.sh"

### **5.2 deploy-pages.sh (\~/projects/hermes\_cloudflare/pages/)**

\#\!/usr/bin/env bash  
set \-euo pipefail

cd "$(dirname "$0")"

PAGES\_PROJECT="hermes-cloudflare-pages"

echo "=== Pages UI Deploy \==="

\# 1\. Build UI  
echo "\[1/2\] Building UI..."  
bash build-ui.sh

\# 2\. Deploy to Pages  
echo "\[2/2\] Deploying to Cloudflare Pages..."  
npx wrangler pages deploy dist/ \--project-name="${PAGES\_PROJECT}"

echo "=== Pages Deploy Complete \==="  
echo "URL: https://${PAGES\_PROJECT}.pages.dev"

### **5.3 deploy-updater.sh (\~/projects/hermes\_cloudflare/updater/)**

\#\!/usr/bin/env bash  
set \-euo pipefail

cd "$(dirname "$0")"

echo "=== Updater Worker Deploy \==="

\# 1\. Deploy Worker  
echo "\[1/2\] Deploying Updater Worker..."  
npx wrangler deploy

\# 2\. Set secrets  
echo "\[2/2\] Setting secrets..."  
read \-rp "Pages Deploy Webhook URL: " WEBHOOK\_URL  
echo "${WEBHOOK\_URL}" | npx wrangler secret put PAGES\_DEPLOY\_WEBHOOK

echo "=== Updater Deploy Complete \==="

## **Phase 6: Testing**

### **6.1 Verify Access flow**

1. WARP connected  
2. Browser → https://hermes-cloudflare.pages.dev  
3. Should redirect to Access login  
4. After login → loads React UI  
5. UI makes /api/chat → \_worker.js proxies → API Worker  
6. API Worker validates JWT against Pages AUD tag → gets sandbox → proxies to container  
7. Container responds → back through chain → UI displays response

### **6.2 Verify direct Workers access blocked**

\# Without Access JWT → 401  
curl https://hermes-cloudflare.hermes-test-439.workers.dev/health  
\# → "missing Access JWT"

## **Decisions**

| Decision | Choice | Rationale |
| :---- | :---- | :---- |
| Container size | basic (1GB) | User confirmed cost preference over standard-1. |
| Auth model | Access JWT only | Shared-secret removed; Desktop App no longer supported |
| Pages proxy | \_worker.js | User chose over absolute Worker URL |
| Build source | Clone public repo on each build | No fork/mirror needed |
| Output dir | dist/ | Hardcoded bash logic to prevent variable resolution failures. |
| Updater trigger | Cron daily at midnight | Checks GitHub releases, triggers Pages deploy webhook |
| API Worker domain | Keep existing hermes-test-439.workers.dev | Repurpose in-place |
| Pages domain | Default .pages.dev | Custom domains can be mapped later |

