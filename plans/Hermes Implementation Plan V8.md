# Hermes V8 — Per-User AI Gateway Providers in config.yaml

Status: DRAFT for review (new session executes this)
Date: 2026-09-10
Depends on: V7 (SDK-native persistence, deployed as image v19) — the restore gate
(`/tmp/restore-done`) is the injection point this plan hooks into.

## 1. Goal

Inject a per-user `custom_providers:` section into each container's
`$HERMES_HOME/config.yaml` so the agent can call models through the user's
Cloudflare AI Gateway (custom header `cf-aig-gateway-id`, per-user account,
per-user model list). Multiple providers per user. Not every provider has a
custom header; not every user has one provider.

## 2. Verified facts (2026-09-10)

1. **PR 14314 is NOT needed.** It is **closed unmerged**, and its core
   capability already ships upstream: installed hermes v0.21.1
   (container image) has `custom_providers[].extra_headers` —
   `hermes_cli/config.py` exposes `get_custom_provider_extra_headers()` and
   `agent/agent_init.py` applies per-provider `extra_headers` to client
   kwargs last (most specific wins). Use `extra_headers`, do not vendor the PR.
2. **Custom-domain + Access = JWT auth works.**
   https://developers.cloudflare.com/ai-gateway/configuration/cloudflare-access/
   - Requires: gateway with a **custom domain** + Access enabled via the
     gateway's Access tab (Access app auto-created; non-browser clients send
     the Access JWT as bearer).
   - With a valid Access JWT, **no AI Gateway token is needed**; the gateway
     adds `cf.user_id` (JWT `sub`, not email) to request metadata for
     per-user log/spend filtering.
   - Cloudflare-only credentials (Access JWT, AI Gateway auth headers) are
     **stripped before forwarding** to the upstream provider.
   - Once Access is on the custom domain, token-only requests to that domain
     are blocked — JWT is the only credential on that path.
   - **JWT-as-API-key is the documented pattern for non-browser agents**
     (Claude Code / Codex "Use with Cloudflare Access" sections): the
     `Authorization: Bearer *** header IS the credential; Access verifies it
     at the edge. So hermes' standard openai-compatible
     `Authorization: Bearer <key_env>` path needs no custom header for the
     JWT — only the JWT's ~24h session lifetime needs handling.
   - **JWTs have a session duration (default 24h)** → long-lived containers
     need re-injection; the existing bootstrap-token-watcher pattern handles it.
3. **Account-scoped REST endpoint = API token only.**
   https://developers.cloudflare.com/ai-gateway/usage/rest-api/
   - `POST /client/v4/accounts/{acct}/ai/v1/...` requires `Authorization:
     Bearer <CF API token with Account > Workers AI > Read>`; an Access JWT or
     an AI-Gateway-permission-only token returns 401 (error 10000).
   - `@cf/` model calls through this endpoint require the
     `cf-aig-gateway-id` header (this is the header we inject).
   - This path is the **fallback** for gateways without a custom domain.
4. **Hermes config schema** (from PR 14314 diff + installed v0.21.1):
   custom-provider entries accept `name, base_url, api_key, key_env, api_mode,
   model, models {<id>: {context_length, max_length}}, discover_models,
   extra_body, extra_headers, ...`. Key from env via `key_env` — the client
   sends `Authorization: Bearer <value>`, which is exactly what Access
   accepts on the custom-domain path.

## 3. Target design

### 3.1 Auth model (two modes, per provider entry)

- **`jwt` (primary, user preference):** user's own Access JWT for the gateway's
  Access app. Per-user identity, `cf.user_id` attribution, no API key at all.
  - Prerequisite (one-time, per gateway): gateway has a custom domain + Access
    tab enabled with a policy allowing the user.
  - The client obtains the JWT: `cloudflared access login
    https://<gateway-custom-domain>` (second login, next to the existing
    worker-domain login in `setup-client.ps1`), then hands it to the worker.
  - **Mechanism (verified against CF coding-agent docs 2026-09-10):** the
    Access edge sits in front of the custom domain and accepts non-browser
    clients "by sending the Access token as a bearer token" — i.e.
    `Authorization: Bearer <JWT>` on every request. CF's own Claude Code and
    Codex integrations use exactly this: the Access JWT IS the API key
    ("Claude Code sends the token as the API key, and Access verifies it at
    the edge"; Codex's auth block output is sent as the API key). So:
    `key_env` → `.env` holds the JWT → the openai client sends
    `Authorization: Bearer <JWT>` per request automatically. No custom
    header for the JWT; no `cf-aig-authorization` (that header belongs to the
    gateway-token path on gateway.ai.cloudflare.com = fallback mode below).
  - `cf.user_id` is derived by the gateway from the JWT `sub` claim —
    never client-supplied (`cf.*` metadata keys are reserved/dropped).
  - `base_url` = `https://<gateway-custom-domain>/openai/v1` — **DECIDE AT
    IMPL: verify exact path (Access examples show `/openai/v1/...` and
    Codex uses base `/openai`) + model naming (with/without `@cf/` prefix)
    on the custom domain via curl before writing the merge**.
  - **Staleness:** JWTs are session-scoped (~24h). Claude Code/Codex re-fetch
    via helpers; hermes `custom_providers` has no re-fetch hook. Refresh
    depends on 3.3's `.env` watcher + step-2 verification (per-request
    `key_env` resolution vs cached-at-boot → watcher update vs re-wake).
- **`api_token` (fallback):** account-scoped endpoint
  `https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1` +
  `extra_headers: { cf-aig-gateway-id: <gateway-id> }` + `key_env` holding a
  CF API token with Workers AI:Read. Token is an **account-level Worker
  secret** (`CLOUDFLARE_AI_API_TOKEN`), shared across users (it grants model
  inference only — least-privilege, and per-user attribution still works via
  the gateway header).

### 3.2 Per-user data — R2, NOT D1

One file per user in the existing `BACKUP_BUCKET`:
`users/<userId>/providers.json` — a list; D1 buys nothing (no queries).

```json
[
  {
    "name": "Gateway.ai.cloudflare.com",
    "mode": "jwt",
    "base_url": "https://ai-gw.example.com/openai/v1",
    "key_env": "CLOUDFLARE_GATEWAY_AI_API_KEY",
    "extra_headers": {},
    "models": {
      "@cf/qwen/qwen3-30b-a3b-fp8":  { "context_length": 32768,  "max_length": 2048 },
      "@cf/openai/gpt-oss-20b":      { "context_length": 128000, "max_length": 4096 },
      "@cf/meta/llama-4-scout-17b-16e-instruct": { "context_length": 131000, "max_length": 4096 },
      "@cf/meta/llama-3.2-1b-instruct":          { "context_length": 60000,  "max_length": 4096 },
      "@cf/meta/llama-3.1-8b-instruct-fp8":      { "context_length": 32000,  "max_length": 2048 }
    },
    "model": "@cf/openai/gpt-oss-20b"
  },
  {
    "name": "Legacy-gateway",
    "mode": "api_token",
    "gateway_id": "hermes-ai-gateway",
    "key_env": "CLOUDFLARE_GATEWAY_AI_API_KEY",
    "extra_headers": { "cf-aig-gateway-id": "hermes-ai-gateway" },
    "models": { "openai/gpt-4.1": { "context_length": 1047576, "max_length": 16384 } }
  }
]
```

Notes:
- `base_url` is stored verbatim for `jwt` mode; for `api_token` mode the
  worker renders it from `CLOUDFLARE_ACCOUNT_ID` (worker var) + the
  account-scoped template (the account ID is fixed for our account — not
  per-user data).
- Multiple providers → distinct `key_env` per entry (JWTs differ per user's
  Access app; api_token entries share the worker secret value).
- **Secrets handling:** the JWT is a *session credential* (24h), not a durable
  secret — it lives in `providers.json` only transiently OR (preferred, DECIDE
  AT IMPL) in a separate short-lived object `users/<userId>/gateway-jwt.json`
  with TTL semantics, never in the long-lived providers file. The api_token
  value never touches R2 at all — only the `key_env` name is stored; the value
  comes from the worker env secret at injection time.

### 3.3 Injection — worker, on `/api/wake`, inside the existing restore gate

Order in the wake handler (after `restoreLatest`, **before** writing
`/tmp/restore-done` — `hermes serve` therefore never starts without it):

1. Read `users/<userId>/providers.json`; if absent → skip (no providers,
   current behavior).
2. For each entry, merge into container `config.yaml`:
   - Read current `config.yaml` (restored tree or fresh), replace/append the
     `custom_providers:` section (idempotent — this section is entirely
     worker-owned; user-edited entries in a snapshot are overwritten by
     design and the section is marked with a comment banner).
   - `jwt` mode: resolve the JWT (gateway-jwt object, or the JWT the client
     just POSTed on this wake); `api_token` mode: value =
     `env.CLOUDFLARE_AI_API_TOKEN`.
3. Write the key(s) into `$HERMES_HOME/.env` (`key_env=<value>` per entry) —
   same sed/append watcher mechanics the dashboard-token path already uses.
4. Bootstrap file gains nothing new; the restore-done marker flow is
   unchanged.

**JWT refresh:** JWTs expire (~24h session duration). The existing
`load_bootstrap`-style watchers re-read their source every 5s. Extend the
wake-time `.env` writer into a background watcher (or have the worker's
`*/5` cron re-push `gateway-jwt.json` → `.env` for running containers) so a
re-logged-in JWT lands without a restart. `hermes` re-reads `.env` per
request via `key_env` — **VERIFY AT IMPL: confirm the openai client resolves
`key_env` fresh per request, not cached at boot; if cached, the watcher must
restart serve (SIGTERM the CMD child → s6/container re-exec) or accept
re-wake as the refresh path.**

### 3.4 Client changes (`setup-client.ps1`)

- New param `-GatewayDomain <https://ai-gw.example.com>` (optional).
- When set: second `cloudflared access login <GatewayDomain>` (separate token
  entry in the local cloudflared store), then `cloudflared access token` to
  read it and include it in the `/api/wake` POST body (or a follow-up
  `POST /api/admin/gateway-jwt`). Worker stores it in the short-lived R2
  object (3.2) and injects per 3.3.
- Re-running the client daily = JWT refresh; no new UX beyond one optional
  flag.

### 3.5 Management endpoint

`PUT /api/admin/providers?userId=<id>` — JWT-authed (Access, like the rest of
the worker), body = providers array (no secrets) → validates schema
(mirrors hermes' `_VALID_CUSTOM_PROVIDER_FIELDS`), writes
`users/<userId>/providers.json`. Response includes the rendered
`custom_providers` YAML for eyeballing. `GET` returns the current file.
(If the user wants self-service later, the same endpoint is what the desktop
GUI would call — shape it for that now.)

## 4. What does NOT change

- V7 restore gate, SDK persistence, bootstrap file shape, tunnel model.
- `start-hermes.sh` — no edits expected (the `.env` watcher already exists for
  the dashboard token; 3.3.3 piggybacks on it). Verify before concluding.
- No D1. No new R2 bucket. No new bindings. Image rebuild only if 3.3's
  `key_env` freshness check (3.3) fails and needs container-side help.

## 5. Implementation steps (gate each)

1. **Spike (curl, no code):** confirm against the real gateway —
   (a) custom-domain path + model naming for `@cf/` models with a user JWT
   (expect `200` + `cf.user_id` in gateway logs); (b) `cf-aig-gateway-id`
   header necessity on the custom domain vs the account endpoint;
   (c) exact `chat_completions` base_url for each mode. Record results in
   this file. **Nothing downstream is built on unverified paths.**
2. **Hermes freshness check:** in a scratch hermes home, set a `key_env`
   value, boot `hermes serve`, rotate the `.env` value, confirm the next
   request uses the new value (no restart). Result decides the 3.3 refresh
   path.
3. **Worker: `src/providers.ts` (new)** — schema types, `mergeCustomProviders`
   (YAML section replace with banner comment), env-key writer, JWT object
   get/set. Unit-testable pure functions; YAML via the dep already in the
   worker or a minimal hand-rolled emitter for this fixed shape (DECIDE AT
   IMPL — prefer an emitter: the section shape is worker-owned).
4. **Worker: wake handler** — 3.3 order; failure policy = log + continue
   (a bad providers file must not break wake; surface `providersError` in the
   wake JSON, mirroring `restoreError`).
5. **Worker: admin endpoints** — 3.5 + `POST /api/admin/gateway-jwt`.
6. **`setup-client.ps1`** — 3.4.
7. **Verify end-to-end:**
   - `PUT` providers → wake → SSH in → `config.yaml` shows the section with
     banner; `.env` has the key(s).
   - In-container: `hermes` turn against `@cf/openai/gpt-oss-20b` → 200;
     gateway log shows the request **and** `cf.user_id` = the user's sub.
   - JWT expiry: wait/shorten session → next request 401 → re-run client →
     watcher updates `.env` → request 200 (no container restart, per step 2's
     finding).
   - api_token fallback: second entry with `cf-aig-gateway-id` works.
   - Regression: user with NO providers.json boots exactly as today.

## 6. Open decisions (resolve at session start)

1. JWT storage split (transient `gateway-jwt.json` vs inline in
   providers.json) — leaning transient (3.2).
2. `key_env` freshness result (step 2) → watcher vs re-wake refresh.
3. Custom-domain base_url path + model prefix (step 1 spike).
4. Session duration of the gateway's Access app (24h default vs longer) —
   dashboard setting, not code.
5. Do we need `api_mode: chat_completions` explicit for the custom domain, or
   does `determine_api_mode` infer it from the base_url? (Check at impl.)

## 7. Reference pointers

- AI Gateway + Access: developers.cloudflare.com/ai-gateway/configuration/cloudflare-access/
- JWT-as-API-key evidence: developers.cloudflare.com/ai-gateway/integrations/coding-agents/claude-code/
  ("Use with Cloudflare Access" — Access token sent as the API key) and
  .../openai-codex/ (auth block fetching the token, custom-domain base_url)
- AI Gateway REST API (account-scoped, API-token auth, `cf-aig-gateway-id`):
  developers.cloudflare.com/ai-gateway/usage/rest-api/
- Custom-provider schema + `extra_headers`: installed
  `~/.hermes/hermes-agent/hermes_cli/config.py`
  (`_normalize_custom_provider_entry`, `_VALID_CUSTOM_PROVIDER_FIELDS`) and
  `agent/agent_init.py` (per-provider extra_headers applied last).
- PR 14314 (closed unmerged; read for schema only, do NOT vendor):
  github.com/NousResearch/hermes-agent/pull/14314
- V7 plan (restore gate, bootstrap, wake flow):
  `plans/Hermes Implementation Plan V7.md`
- Wake handler + restore marker: `src/index.ts` (~line 338), `src/persistence.ts`
