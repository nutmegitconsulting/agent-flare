# Agent Flare: webapp and state overhaul

Branch: `webapp-and-state`. Local only: no pushes or deploys until Chris says so.
Started 2026-11-04. Keep this file current; secrets never go in it.

## Goal

1. Replace Hermes Desktop, per-user cloudflared tunnels and PowerShell with the Hermes webapp, behind Cloudflare Access, routed by Access user ID.
2. Make state reliable: restores that complete, and snapshots that can't destroy good data.
3. Config templates assigned to users, so their files are filled in on first launch.
4. Eventually: deploy straight from GitHub, so people can clone and go.

## Decisions from Chris (2026-11-04)

- Local branch; no deploys tonight.
- Port 443 in the container. Plain HTTP on the internal Worker-to-container hop, no certificate (TLS ends at Cloudflare). To be revisited if Chris meant real TLS in the container.
- Hermes auth plugin trusting the Access identity is approved. None ships with Hermes (bundled: basic, drain, nous, self_hosted, session_token).
- All existing user state is disposable. No migration.
- Nobody uses Desktop. Remove tunnel code and PowerShell client scripts.
- Shared secrets move to Worker Secrets. Per-user secrets stay in KV, encrypted with a master key held in Secrets. Reason: Worker limit is 128 secrets + vars on paid (64 on free), per Worker, so per-user Secrets would cap at about 100 users.

## Design

See `README.md`. In short: Browser -> Access -> Worker -> per-user Sandbox -> Hermes webapp :443, keyed on the Access `sub`.

## Status (2026-11-05)

Built and tested locally, on this branch. Not pushed, not deployed.

- Worker unit tests: 28 pass (`npm test`)
- Container tests: 24 unit, 16 integration pass (`tests/container/run.sh`)
- End to end through `wrangler dev`: 61 pass (`node tests/e2e/run.mjs`; `E2E_BIG_MB=400` adds a large-state run)
- An independent review found 10 problems. All are fixed; see the "Fix problems from independent review" commit.

## Not proven locally

These go first at the first real deploy, with `ONBOARDING.md`:

1. Real Access login, and the JWKS fetch from a real team domain
2. `get-identity` for group assignment
3. Port 443 through production Containers: local dev allowed it; the SDK blocks ports below 1024 only in `wsConnect`
4. Restore memory behavior on production Durable Objects. Local workerd doesn't enforce the memory limit, so `SANDBOX_TRANSPORT=rpc` fixing the old size failures is reasoned from SDK code, not measured
5. Workers Builds building this Dockerfile from GitHub. Docs say Dockerfile builds work; the Deploy button's docs don't mention Containers, so no button yet
6. Transient-failure classification in `restoreNewest`: real failure messages may differ
7. `cf-aig-metadata` per-user tagging reaching AI Gateway

## Changes Chris should know about

- `jwt` provider mode is gone. It relied on the desktop client fetching a gateway JWT. `api_token` mode with `cf-aig-metadata` tagging replaces it, and `user_env` lets a user bring a key.
- An open browser tab keeps a container running, and so costs money.
- A sleeping container runs no Hermes cron jobs or messaging gateways.
- `max_instances` caps users awake at once. Default 10.
- `@cloudflare/sandbox` is 0.12.14; 1.0.3 is current. Not upgraded, to change one thing at a time.
- Cloudflare's own Container Snapshots aren't a replacement for R2: tied to one image version, 30-day expiry.
- Local image builds on this host need a base image trusting its TLS inspection CA. That's a local workaround, not in the repo.

## Open questions for Chris

- Which settings should templates pre-fill? `templates/example` is a placeholder until answered.
- Port 443 in the container is plain HTTP on the internal hop. Confirm that's what was meant.
- Admin emails, hostname and Access application for the first deploy.
