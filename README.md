# Agent Flare

**Agent Flare** — Hermes Agent deployed on Cloudflare Sandbox with Hermes Desktop GUI connectivity via Cloudflare Tunnel.

## Architecture at a glance

**Agent Flare** runs the Hermes AI agent in a custom Python container on Cloudflare, driven from a desktop UI on your laptop — with the container's state snapshotted to R2 as squashfs so it survives the ephemeral container lifecycle.

```
┌─────────────────────┐  cloudflared access tcp    ┌──────────────────────────────┐
│  Laptop             │  (outbound-only tunnel)    │  Cloudflare Edge             │
│  Hermes Desktop UI  │───────────────────────────▶│  Access (JWT auth)           │
│  localhost:9119     │  no inbound ports anywhere │  Hono Worker (provisioning,  │
└─────────────────────┘                            │  wake/stop, snapshot APIs)   │
                                                   └───────────────┬──────────────┘
                                                                   │ per-user Tunnel
                                                   ┌───────────────▼──────────────┐
                                                   │  Python container            │
                                                   │  (cloudflare/sandbox-python) │
                                                   │  Hermes agent + cloudflared  │
                                                   │  mksquashfs ────▶ R2 snapshots
                                                   └──────────────────────────────┘
```

The five moves:

1. **Desktop UI runs locally.** The Hermes Desktop GUI lives on your laptop and connects to `localhost:9119` — it is never hosted in the cloud.
2. **Cloudflared bridges laptop → cloud.** The desktop client runs `cloudflared access tcp`, which dials an outbound-only connection through Cloudflare Access to the user's tunnel. No inbound ports are open on the laptop, and the container is never directly exposed.
3. **Per-user Python containers on Cloudflare.** Each user's agent runs in its own container (base image `cloudflare/sandbox:0.12.7-python`) alongside a Hono Worker that provisions the tunnel, wakes and stops containers, and exposes snapshot/admin APIs.
4. **Squashfs state backups to R2 — every 5 minutes and at shutdown.** The container filesystem is ephemeral: the container's live state (`/home/hermes/.hermes`) is archived with `mksquashfs` on a 5-minute cadence (Worker cron; `SNAPSHOT_INTERVAL_MINUTES`), the SDK uploads the archive through the bound R2 bucket (no presigned URLs, no credentials in the container), and one last snapshot is taken just before the container is stopped (`SIGTERM`) or destroyed. On the next boot the newest archive is `unsquashfs`-extracted back in, so the agent resumes exactly where it left off. Slot-filling retention pruning keeps the snapshot history small.
5. **Cloudflare Access in front of everything.** All public hostnames sit behind Cloudflare Access (JWT verification on every request); `workers.dev` exposure is disabled. The only authenticated way in is through Access, and tunnel credentials for each user live in a dedicated KV namespace rather than in the R2 backup bucket.

## Overview

This project deploys the Hermes AI Agent inside Cloudflare Sandbox containers, using Cloudflare Tunnel for secure connectivity from a local Hermes Desktop GUI. A serverless Worker (Hono) provisions Cloudflare Tunnels per user and manages container wake/stop; user state persists in R2 as squashfs backups written by the Sandbox SDK.

## Architecture

- **Frontend:** Hermes Desktop GUI (Windows) connects to `localhost:9119`
- **Transport:** `cloudflared access tcp` proxies local TCP to Cloudflare Tunnel
- **Edge:** Cloudflare Access authenticates and routes to the Worker (`hermes-agent.hermes-test.app`)
- **Backend:** Cloudflare Sandbox + Durable Object runs Hermes Agent; Hono Worker handles the API
- **Persistence:** R2-backed squashfs backups via the Sandbox SDK's `createBackup()` / `restoreBackup()`

### Persistence

State lives in the container at `/home/hermes/.hermes` (HERMES_HOME); the snapshot tree is `/home/hermes`, which also carries the tiny `hermes` wrapper. The install (code, venv, Node, uv) lives at `/opt/hermes-install` (+ `/opt/uv`), outside the snapshot tree. Backups are written by the SDK through the bound `BACKUP_BUCKET` R2 binding (`localBucket: true`): the container runs `mksquashfs`, the SDK uploads the archive to R2. No presigned URLs, no R2 tokens, and no credentials of any kind exist in the container. Restores are a plain `unsquashfs` extraction into a normal ext4 directory.

R2 key layout (multi-tenant):

```
users/<userId>/backup-handle.json   newest DirectoryBackup handle (restore target)
users/<userId>/backups-index.json   array of {id, dir, createdAt} (observability only)
users/<userId>/providers.json       per-user AI Gateway provider config (no secrets)
active-users.json                  userIds with currently-running containers
backups/<id>/data.sqsh             SDK-written squashfs archive
backups/<id>/meta.json             SDK-written metadata
```

Usable credentials (tunnel token, dashboard session token, gateway JWT) do NOT live in this bucket — since V9 they are in the dedicated `CREDENTIALS_KV` KV namespace under `cred:tunnel:<userId>`, `cred:session:<userId>`, `cred:gwjwt:<userId>`, so third-party R2 backups never carry credentials.

Backup lifecycle:

- **Restore:** `/api/wake` calls `restoreLatest()` (extracts the newest handle into `/home/hermes`) and writes `/tmp/restore-done` to unblock the boot script. A missing/expired handle is treated as a fresh start; a failed restore does not fail the wake.
- **Periodic snapshots:** a Worker cron fires every 10 minutes; for each user in `active-users.json` whose container is `running`, a snapshot is taken if the newest backup is older than `SNAPSHOT_INTERVAL_MINUTES` (default 60). Sleeping containers are skipped.
- **Final snapshots:** `/api/admin/stop` and `/api/admin/destroy` take a best-effort final backup before stopping/destroying.
- **Retention:** slot-filling retention pruning runs on the `0 */2 * * *` Worker cron for every user in `active-users.json` (also on demand via `POST /api/admin/prune`): newest-first, it keeps one backup per 5-minute slot for backups younger than 2h, one per hourly slot for backups younger than 24h, then the newest 5 distinct calendar-day slots and newest 5 distinct ISO-week slots regardless of age, and never deletes the absolute newest backup; everything else is deleted (`backups/<id>/data.sqsh` + `meta.json`). The SDK backup TTL itself is 365 days, so any backup that survives pruning stays restorable.
- **Integrity:** every snapshot and restore checks a sentinel file (`/home/hermes/.local/bin/hermes`) to detect partial extractions and refuse to archive a corrupt tree.

### Container image

- Base: `cloudflare/sandbox:0.12.7-python`
- Install (code, venv, Node bundle, uv CPython) lands in `/opt/hermes-install` + `/opt/uv`; `/home/hermes/.hermes` ships empty and only the tiny `hermes` wrapper lives in the snapshot tree
- Container runs as root at runtime so the SDK can run `mksquashfs`
- `start-hermes.sh` polls for `/tmp/restore-done` (120 s cap) before starting `hermes serve`

## API

All endpoints (except `/health` and `/internal/*`) require a valid Cloudflare Access JWT/`Cf-Access-Token`.

| Endpoint | Purpose |
|---|---|
| `POST /api/client-init` | Provision (or fetch) the per-user tunnel + hostname + dashboard session token |
| `GET /api/status` | Whether the user's tunnel is provisioned, and its hostname |
| `POST /api/wake` | Restore latest backup, write bootstrap/tokens, wake the container |
| `GET /api/debug/exec` | Run a command in the user's container |
| `POST /api/admin/stop` | Final backup, then stop the container |
| `POST /api/admin/destroy` | Final backup, then destroy the container |
| `GET /api/admin/status` | Container state for a user |
| `POST /api/admin/snapshot` | Force a snapshot now |
| `POST /api/admin/restore` | Force-restore the latest backup now |
| `POST /api/admin/prune` | Run slot-filling retention pruning for a user now |
| `POST /api/admin/gateway-jwt` | Store the user's gateway Access JWT (used by `setup-client.ps1`) |

## Security Notes

The container environment carries two credentials:

- **`CLOUDFLARED_TOKEN`** — the per-user Cloudflare Tunnel credential used by `cloudflared tunnel run`.
- **`HERMES_DASHBOARD_SESSION_TOKEN`** — the per-user dashboard session token.

Both are visible to any process in the container, including the Hermes agent itself. This is accepted for now because Cloudflare Sandbox is a single-container runtime with no sidecar or separate-privilege model to isolate `cloudflared` from the agent.

Possible hardening (not yet implemented): move `CLOUDFLARED_TOKEN` to a restricted file (e.g., `/run/creds.json` with `0400` permissions) and run `cloudflared` as a separate user from the Hermes agent.

## Deployment

Deploys are made manually with Wrangler from the operator's machine — there is no CI/CD pipeline by design. Deploying requires Cloudflare authentication (`wrangler login`) and a running Docker daemon (the container image is built and pushed at deploy time).

1. **Install dependencies:** `npm install` (Node 22+)
2. **Authenticate:** `npx wrangler login`
3. **Create resources** (first deploy only):
   - `npx wrangler kv namespace create CREDENTIALS_KV` — copy the namespace ID
   - `npx wrangler r2 bucket create hermes-agent-state`
4. **Configure:** `cp wrangler.example.jsonc wrangler.jsonc`, then fill in your KV namespace ID, custom domain, and (optionally) SSH authorized keys. `wrangler.jsonc` is gitignored — it carries account-specific values (KV IDs, SSH keys) and must never be committed.
5. **Set Worker secrets:** `npx wrangler secret put CF_API_TOKEN` (repeat for `ACCESS_AUD_TAG`, `CLOUDFLARE_AI_API_TOKEN` as needed)
6. **Deploy:** `npx wrangler deploy` — Docker must be running; the `Dockerfile` image is built and pushed to Cloudflare's registry as part of the deploy

### SSH debugging (troubleshooting only)

Sandboxes ship with `ssh.enabled: true` so a running container can be reached with `npx wrangler containers ssh <INSTANCE_ID>`. Get the application ID with `npx wrangler containers list`, then the instance IDs with `npx wrangler containers instances <APP_ID>` (both steps are required — `instances` takes the application ID as an argument, and `ssh` takes the instance ID). The tunnel is authenticated by your Cloudflare account — no public port is exposed. A connection succeeds only if both of the following hold:

- **sshd runs inside the container.** The image installs `openssh-server` and `start-hermes.sh` launches it. An image without an SSH server makes the tunnel useless.
- **Your public key is hydrated via `authorized_keys`** in the container config (`ssh-ed25519` keys only). With no key entry, the tunnel opens but no login succeeds. See the [Cloudflare Containers SSH docs](https://developers.cloudflare.com/containers/) before enabling.

SSH is a debugging affordance, not a feature — disable it by setting `ssh.enabled: false` in `wrangler.jsonc`.

## License

This project is licensed under the MIT License.

Portions of this project are derived from [**hermes-flare**](https://github.com/carimura/hermes-flare) by Carter Morgan, which is licensed under the Apache License, Version 2.0. Specifically:

- The R2-backed squashfs state persistence pattern (`createBackup` / `restoreBackup`)
- The sentinel-file integrity check approach for ephemeral container state hydration
- The separation of install path (`/opt/hermes-install`) from mutable state (`/home/hermes`)

The Apache License, Version 2.0 applies to those derived portions. A copy of the Apache 2.0 license is included in this repository for compliance. All original work in this project is licensed under MIT.

We gratefully acknowledge the hermes-flare project for demonstrating Cloudflare Sandbox persistence patterns that inform this implementation.
