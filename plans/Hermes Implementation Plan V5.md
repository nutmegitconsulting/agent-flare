# Hermes Cloudflare — Implementation Plan V5
## @cloudflare/think + @cloudflare/computer Pivot

**Date:** 2026-08-19
**Architecture:** Cloudflare Worker (Think DO + Computer workspace) + Cloudflare Pages (React UI) + R2 (cold storage)
**Auth:** Cloudflare Access JWT (retained from V4)

---

## Overview

Replace the V4 Container Sandbox architecture (`@cloudflare/sandbox` + persistent Firecracker VM + R2 snapshot/restore) with the newly released `@cloudflare/think` Durable Object agent runtime and `@cloudflare/computer` execution environment.

**What changes:**
- **Remove:** Container DO, long-running container, Dockerfile, `start-hermes.sh`, snapshot/restore logic, `/api/*` dashboard proxy, HERMES_SESSION gating.
- **Add:** `HermesAgent` class extending `Think<Env>`, `@cloudflare/computer` workspace for isolate/container exec, WebSocket chat protocol, built-in DO SQLite state persistence.
- **Keep:** Access JWT validation, Pages UI host + proxy, Updater Worker, R2 bucket for archival.

---

## Architecture

```
Browser / Desktop Client (cloudflared tunnel)
    │ HTTPS / WSS
    ▼
hermes-cloudflare.pages.dev  (Pages + Access)
    ├─ Static React assets
    └─ /api/* ──► _worker.js proxies ──► API Worker
                    │
                    ▼
        [JWT validation]
                    │
        ├─ /api/client-init → provision DO, return secret
        ├─ /health → ok
        └─ /agents/HermesAgent/:id → routeAgentRequest()
                    │
                    ▼
        HermesAgent (Think subclass)
            ├─ SQLite-backed message history (auto-persist)
            ├─ @cloudflare/computer workspace
            │   ├─ V8 isolate exec (fast tasks)
            │   └─ Linux container exec (native binaries, npm)
            ├─ AI Gateway routing ( Workers AI )
            └─ R2 archive (cold storage of ~/.hermes)
```

---

## Phase 1: Dependencies & Wrangler Config

### 1.1 Install packages

```bash
cd ~/projects/hermes_cloudflare/deploy
npm install @cloudflare/think @cloudflare/computer agents ai @cloudflare/shell zod
```

`workers-ai-provider` is bundled with Think; no separate install needed.

### 1.2 `wrangler.jsonc`

Replace container definition with Think DO + SQLite migration. Add `ai` binding. Remove cron trigger (Think DO survives hibernation without keep-warm).

Key bindings:
- `HermesAgent` — Durable Object class (SQLite storage)
- `BACKUP_BUCKET` — R2 for archival snapshots
- `AI` — Workers AI inference binding
- `ACCESS_AUD_TAG` — secret, validated at runtime

### 1.3 `tsconfig.json`

No change required; existing strict config is compatible.

---

## Phase 2: Agent Durable Object

### 2.1 `src/agent.ts`

Create `HermesAgent` extending `Think<Env>`.

Responsibilities:
- `getModel()` — returns Workers AI model ID (e.g. `@cf/moonshotai/kimi-k2.6`) or AI Gateway slug.
- `getSystemPrompt()` — Hermes identity, security constraints, tool-use rules.
- `getTools()` — merge Think built-ins with `@cloudflare/computer` workspace tools (`exec`, `readFile`, `writeFile`).
- Constructor initializes `Computer` workspace backed by DO SQLite.
- `archiveToR2()` — optional: compress workspace state and write to R2 on schedule or before hibernation.

### 2.2 State persistence (built-in)

Think handles:
- Durable turns (survives DO eviction mid-turn)
- Recovery-aware delivery (snapshots reply status: accepted/streaming/completed)
- Context overflow guard (proactive compaction before each step)
- Message tree history with branching

No manual snapshot/restore code needed for hot state. R2 is used only for long-term cold storage or disaster recovery.

---

## Phase 3: Worker Ingress

### 3.1 `src/index.ts`

Fetch handler flow:
1. **Health** (`/health`) — no auth, returns `ok`.
2. **JWT validation** — read `CF-Access-Jwt-Assertion`, validate against `ACCESS_AUD_TAG` and Cloudflare Access certs. Extract `email` → `userId`.
3. **Client init** (`/api/client-init`) — get DO stub by `idFromName(userId)`, return `{ userId, sessionSecret }`. (Session secret retained for Desktop GUI compatibility; future iterations can remove if Access JWT is sufficient.)
4. **Agent routing** — pass request + env to `routeAgentRequest(request, env)` from `agents` package. This handles WebSocket upgrades, chat streams, and REST agent calls automatically.
5. If `routeAgentRequest` returns `null`, return 404.

### 3.2 Access JWT validation

Reused from V4 with one change: expected audience tag comes from `env.ACCESS_AUD_TAG` instead of hardcoding.

---

## Phase 4: Pages UI Proxy

### 4.1 `_worker.js`

Current proxy forwards `/api/*` to the API Worker. Keep this — it works for `/api/client-init` and `/api/health`.

If the Pages React UI is migrated to `@cloudflare/think/react` (WebSocket chat), ensure the WebSocket `Upgrade` header is forwarded. The existing `fetch(apiUrl, request)` already passes the original request object, so headers (including `Upgrade`) are preserved.

If `routeAgentRequest` uses `/agents/*` paths, add a second proxy rule:
```js
if (url.pathname.startsWith("/agents/")) {
  return fetch(env.API_WORKER_URL + url.pathname + url.search, request);
}
```

### 4.2 Build script

No change; `build-ui.sh` clones and builds the Hermes web assets as before.

---

## Phase 5: Updater Worker

No architectural change. It continues checking GitHub releases and triggering Pages rebuilds.

---

## Phase 6: Cleanup

Delete obsolete V4 files from `deploy/`:
- `Dockerfile`
- `start-hermes.sh`
- `src/persistence.ts` (R2 snapshot/restore replaced by Think SQLite + optional archive)

`scripts/deploy.sh` is rewritten to remove container-related Wrangler flags (`--containers-rollout=none`).

---

## Phase 7: Deployment

### 7.1 One-time setup

```bash
cd ~/projects/hermes_cloudflare/deploy
npx wrangler d1 migrations apply  # if using D1 for anything auxiliary
npx wrangler deploy
npx wrangler secret put ACCESS_AUD_TAG
npx wrangler secret put AI_GATEWAY_TOKEN   # if using gateway for upstream
```

### 7.2 Pages

```bash
cd ~/projects/hermes_cloudflare/pages
bash build-ui.sh
npx wrangler pages deploy dist/ --project-name=hermes-cloudflare-pages
```

### 7.3 Verify

1. Browser → Pages domain → Access login → UI loads.
2. `curl -H "CF-Access-Jwt-Assertion: $JWT" https://<worker>/api/client-init` → returns JSON with `userId`.
3. WebSocket connect to agent endpoint → chat turn persists after DO hibernation.
4. Run `exec` tool in chat → observe isolate/container routing via Computer backend.

---

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Agent base class | `Think` | Official Cloudflare primitive; handles loop, persistence, recovery, overflow. |
| Compute backend | `@cloudflare/computer` | Dynamic isolate/container routing; no persistent VM overhead. |
| Hot state | DO SQLite (Think) | Eliminates R2 snapshot latency on every cold boot. |
| Cold state | R2 archive | Periodic export of `~/.hermes` for disaster recovery; not on critical path. |
| Auth | Access JWT only | No shared-secret gate; Desktop GUI uses cloudflared + SSO. |
| Model | `@cf/moonshotai/kimi-k2.6` | Workers AI native; swap to gateway slug if needed. |
| Pages UI | Keep as static host | Minimal proxy changes; migrate to `useAgentChat` later if desired. |

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| `@cloudflare/computer` API surface unstable (experimental) | Pin versions; expect patches as Cloudflare iterates. |
| WebSocket through Pages Functions | Verify `Upgrade` header forwarding; fall back to direct Worker URL if Pages blocks WS. |
| Context overflow on long sessions | Handled automatically by Think (`contextOverflow.proactive`). |
| DO eviction during tool execution | Think durable turns survive eviction; Computer FUSE mount reattaches on resume. |
