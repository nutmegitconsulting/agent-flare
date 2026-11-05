# Agent Flare: webapp and state overhaul

Branch: `webapp-and-state`. Deployed from this machine 2026-11-05. Not pushed to GitHub: Chris hasn't asked for that yet.
Started 2026-11-04. Keep this file current; secrets, the account ID and the Access AUD never go in it.

## Goal

1. Replace Hermes Desktop, per-user cloudflared tunnels and PowerShell with the Hermes webapp, behind Cloudflare Access, routed by Access user ID.
2. Make state reliable: restores that complete, and snapshots that can't destroy good data.
3. Config templates assigned to users, whose real job is pre-filling inference providers.
4. Eventually: deploy straight from GitHub, so people can clone and go.

## Decisions from Chris

- **Port (changed 2026-11-05):** only the browser's endpoint needs 443. Hermes stays on its default port, 9120, in the container. This replaces the earlier "443 in the container" decision. TLS ends at Cloudflare; the internal hop is plain HTTP, and only the Worker can reach it.
- **Templates (2026-11-05):** pre-fill inference providers. Production uses the Cloudflare gateway from Chris's default Hermes profile, and only that one.
- **Clean image (2026-11-05):** this host inspects TLS. A CA reaches the build only as a BuildKit secret; the base is pinned by digest; `scripts/check-image.sh` must pass before any push.
- **First deploy approved 2026-11-05**, for this project's resources only. No GitHub push.
- Hermes auth plugin trusting the Access identity is approved. None ships with Hermes.
- All existing user state is disposable. No migration.
- Nobody uses Desktop. Tunnel code and PowerShell client scripts are gone.
- Shared secrets are Worker Secrets. Per-user secrets stay in KV, encrypted with a master key held in Secrets. Reason: Worker limit is 128 secrets + vars on paid (64 on free), per Worker, so per-user Secrets would cap at about 100 users.

## Design

See `README.md`. In short: Browser -> Access -> Worker -> per-user Sandbox -> Hermes webapp :9120, keyed on the Access `sub`.

## Live state (2026-11-05)

- Hostname `agents.shipleybuilds.ai`, Worker `agent-flare`, image tag `3400815`. Access app "agents" (Chris's) covers it.
- `workers_dev` and `preview_urls` are off. The Access app also lists a workers.dev name; nothing serves there.
- R2 `agent-flare-state`, KV `agent-flare-credentials`, secrets `MASTER_KEY` and `CLOUDFLARE_AI_API_TOKEN`, two crons, template `team` assigned as the default.
- Local, gitignored: `wrangler.prod.jsonc`, `templates/team/`, `templates/assignments.json`. `wrangler.jsonc` is the local test config, kept separate.
- A copy of `MASTER_KEY` is in `~/.config/agent-flare-master-key`, mode 600. Losing the key loses everything sealed in KV.

### Redeploying from this host

```bash
set -a; . ~/.config/cf-shipleybuilds.env; set +a; export CLOUDFLARE_ACCOUNT_ID=<account>
TAG=agent-flare:$(git rev-parse --short HEAD)
AF_NO_CACHE=1 AF_BUILD_CA=/etc/ssl/certs/ca-certificates.crt AF_FORBIDDEN_CA=/usr/local/share/ca-certificates/Cloudflare_CA.crt scripts/build-image.sh "$TAG"
npx wrangler containers push "$TAG"     # retry on a timeout: finished layers aren't re-sent
# Render with the AF_* values, AF_IMAGE=<pushed image> and AF_WRANGLER_OUT=wrangler.prod.jsonc, then:
npx wrangler deploy --config wrangler.prod.jsonc
```

Never `wrangler deploy` a config that builds `./Dockerfile` with `AF_BASE_IMAGE` set to the local base. That base carries this host's Gateway CA.

### Credentials

- `CLOUDFLARE_API_TOKEN` in `~/.config/cf-shipleybuilds.env` deployed this. It gained Containers on 2026-11-05. **It expires 2026-11-08 04:59 UTC.** It can't read AI Gateway or `/access/organizations`.
- wrangler's OAuth login also has Containers scope, but can't edit Access.
- This token overrides OAuth whenever it's loaded.

## Tests (2026-11-05, at the deployed code)

- Worker unit tests: 36 pass (`npm test`). `tsc` clean.
- Container tests: 36 unit, 28 integration pass (`tests/container/run.sh`), including a real chat turn to a stub provider. On this host, set `AF_BUILD_CA` when it has to build.
- End to end through `wrangler dev`: 77 pass (`node tests/e2e/run.mjs`), including 14 routes against 5 kinds of bad token.

## Found while deploying

- The old example template never worked: a provider that's only listed leaves Hermes reporting nothing connected. A selected provider with no key sends `no-key-required` and gets refused. The container now selects only a provider that has a credential.
- A snapshot taken as a container stopped could record 0 files, outrank every good backup and pass verification. It appeared once, under load, and it's fixed. It was older than this work.
- A single 4 GB layer timed out pushing. The image is now multi-stage, 1.85 GB compressed. Pushing through inspection can still time out on one layer; retrying finishes it.
- The first login landed on a workers.dev name instead of the app. That name was a second hostname on the Access app, and the request never reached the Worker. It stopped once Chris removed the hostname.
- The profile's default model, `glm-5.3-flash`, answered 429 "at capacity" (code 4006) on all 10 direct calls across about 3 hours, while `qwen3.8-27b` answered 200 on all 7 with the same credential. A wrong key gets 401, so the 429 isn't an auth problem. The `team` template now selects `@cf/qwen/qwen3.8-27b`; glm stays listed. An existing user keeps the model they have until they pick another: the picker lists all 8 models.

## First login, production (2026-11-05)

Proven with Chris's real login on the phone: Access, the Worker accepting a real JWT, container start, hydration, silent Hermes sign-in, the webapp, the template's provider selected, automatic snapshots, and a chat turn through the production gateway. Chris's `/__af/admin/users` showed state ready, template `team`, `cloudflare-gateway` selected, nothing missing, no warnings, no snapshot error, 2 backups.

## Not proven yet

1. Stop and restore in production. Chris plans to test from a desktop: `fetch('/__af/stop',{method:'POST'})` in the console, then reload. This also covers restore memory behavior on production Durable Objects (`SANDBOX_TRANSPORT=rpc`)
2. The container's proxy peer address being in `trusted_proxies`. In browser dev tools, the session cookies should start `__Host-` and be `Secure`. If they don't, sign-in still works but the cookies are weaker
3. `cf-aig-metadata` user tags showing in Gateway logs
4. Transient-failure classification in `restoreNewest`: real failure messages may differ
5. `get-identity` for group assignment (assignments don't use groups today)
6. Workers Builds building this Dockerfile from GitHub

## Changes Chris should know about

- `jwt` provider mode is gone. It relied on the desktop client fetching a gateway JWT. `api_token` mode with `cf-aig-metadata` tagging replaces it, and `user_env` lets a user bring a key.
- An open browser tab keeps a container running, and so costs money.
- A sleeping container runs no Hermes cron jobs or messaging gateways.
- `max_instances` caps users awake at once. Default 10.
- `@cloudflare/sandbox` is 0.12.14; 1.0.3 is current. Not upgraded, to change one thing at a time.
- Cloudflare's own Container Snapshots aren't a replacement for R2: tied to one image version, 30-day expiry.
- The whole shared gateway credential is in each user's `.env`, so each user's agent can read it. Keep its scope narrow.
