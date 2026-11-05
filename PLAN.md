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

## Target design

```
Browser (HTTPS 443) -> Cloudflare Access -> Worker -> per-user Sandbox -> Hermes webapp :443
```

- One hostname. Worker verifies the Access JWT signature, `aud`, `iss` and `exp`; container key = Access `sub`, never the email local part.
- Any request can wake a container, so the Worker ensures hydration before proxying HTTP and WebSockets.
- Hermes sign-in: auth plugin that verifies the forwarded Access identity. Fallback: Access for SaaS as the OIDC provider (self_hosted plugin needs a public PKCE client).

## Findings in the current code (from reading; not yet reproduced)

State:
- [ ] `/api/wake` restores unconditionally, including over a running container, which can roll back live work (`src/index.ts`).
- [ ] `start-hermes.sh` sleeps a fixed 15s and starts `hermes serve` whether or not the restore finished.
- [ ] A failed restore boots empty, and the next cron snapshot can become the newest backup. Guards are weak: injected `config.yaml` counts as real content, and `MIN_VALID_BACKUP_BYTES` is 8KB.
- [ ] Non-rpc restore loads the whole archive into Durable Object memory as base64 (SDK `doRestoreBackupLocal`). Check the size limit; `SANDBOX_TRANSPORT=rpc` streams it.
- [ ] `localBucket: true` is documented in the SDK as the local-dev flow. Decide whether to keep it or use the production presigned flow.
- [ ] No `excludes` passed to `createBackup`.
- [ ] Live SQLite snapshotted with no checkpoint.
- [ ] `unsquashfs -f` merges into the target rather than replacing it, so stale files survive.
- [ ] No final snapshot on idle sleep; `/api/admin/stop` and `destroy` are the only final snapshots.
- [ ] Cron snapshot `exec` may renew the activity timer and keep containers awake. Verify.
- [ ] `active-users.json` is an unlocked read-modify-write and is never cleared on idle sleep.
- [ ] `chmod -R a+rX` makes `.env` world-readable, and `.env` goes into R2 snapshots.

Security:
- [ ] JWT signature is never verified: the cert is looked up but not checked. Opaque tokens are trusted outright.
- [ ] User ID is the email local part, so different domains collide into one container.
- [ ] Any Access user can act on another user via `?userId=` on admin routes, and `/api/debug/exec` runs commands.
- [ ] Dockerfile enables `PermitRootLogin` and sshd; review for production.

## Work order

1. [ ] Spike in Docker: run the webapp in the image on 443 behind a simulated proxy. Confirm config keys, bind address (0.0.0.0 vs loopback), Host/Origin handling and WebSocket paths.
2. [ ] Spike the Hermes auth plugin. Confirm one login, cookies, `/api/ws` tickets.
3. [ ] Access JWT verification and `sub` routing, with tests.
4. [ ] Worker proxy for HTTP and WebSockets; hydrate-before-proxy.
5. [ ] State rewrite: single hydration per container generation, boot gate, consistent SQLite capture, excludes, secrets out of snapshots, snapshot guard tied to confirmed hydration, final snapshot on idle.
6. [ ] Config templates and assignments.
7. [ ] Secrets: encrypted per-user KV; shared values in Worker Secrets.
8. [ ] Remove tunnels, cloudflared, PowerShell; lock down admin routes.
9. [ ] Local round-trip test: write state, snapshot, kill, restore, compare.
10. [ ] Clone-and-go: check that GitHub-based deploy handles containers; provide config template and setup docs.
11. [ ] Rewrite README and ONBOARDING; deploy checklist for the morning.

## Can't be proven locally

Real Access login, production R2, real container sleep and wake timing. Goes on the deploy checklist.

## Open questions for Chris

- Which settings should templates pre-fill? Placeholders until answered.
