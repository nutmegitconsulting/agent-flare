# Hermes Cloudflare V6

Hermes Agent deployed on Cloudflare Sandbox with Hermes Desktop GUI connectivity via Cloudflare Tunnel.

> Working-draft copy — the canonical README is at the repo root. This directory is a local planning vault (gitignored), not part of the deploy artifact.

## Overview

This project deploys the Hermes AI Agent inside Cloudflare Sandbox containers, using Cloudflare Tunnel for secure connectivity from a local Hermes Desktop GUI. It replaces the developer-recommended SSH-tunnel approach with a serverless, ephemeral compute model backed by Cloudflare's edge infrastructure.

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
users/<userId>/cloudflared/creds.json  per-user tunnel creds + hostname
users/<userId>/session-token.json  dashboard session token
active-users.json                  userIds with currently-running containers
backups/<id>/data.sqsh             SDK-written squashfs archive
backups/<id>/meta.json             SDK-written metadata
```

Backup lifecycle:

- **Restore:** `/api/wake` calls `restoreLatest()` (extracts the newest handle into `/home/hermes`) and writes `/tmp/restore-done` to unblock the boot script. A missing/expired handle is treated as a fresh start; a failed restore does not fail the wake.
- **Periodic snapshots:** a Worker cron fires every 5 minutes; for each user in `active-users.json` whose container is `running`, a snapshot is taken if the newest backup is older than `SNAPSHOT_INTERVAL_MINUTES` (default 60). Sleeping containers are skipped.
- **Final snapshots:** `/api/admin/stop` and `/api/admin/destroy` take a best-effort final backup before stopping/destroying.
- **Retention:** the code never deletes backups. Retention is owned by the R2 bucket's lifecycle rules on the `backups/` prefix. Per-backup TTL is 365 days so any object still present is restorable.
- **Integrity:** every snapshot and restore checks a sentinel file (`/home/hermes/.local/bin/hermes`) to detect partial extractions and refuse to archive a corrupt tree.

### Container image

- Base: `cloudflare/sandbox:0.12.7-python`
- Install (code, venv, Node bundle, uv CPython) lands in `/opt/hermes-install` + `/opt/uv`; `/home/hermes/.hermes` ships empty and only the tiny `hermes` wrapper lives in the snapshot tree
- Container runs as root at runtime so the SDK can run `mksquashfs`
- `start-hermes.sh` polls for `/tmp/restore-done` (120 s cap) before starting `hermes serve`

## API

All endpoints (except `/health` and `/internal/*`) require a valid Cloudflare Access JWT/`Cf-Access-Token`.

| Endpoint                   | Purpose                                                                       |
| -------------------------- | ----------------------------------------------------------------------------- |
| `POST /api/client-init`    | Provision (or fetch) the per-user tunnel + hostname + dashboard session token |
| `GET /api/status`          | Whether the user's tunnel is provisioned, and its hostname                    |
| `POST /api/wake`           | Restore latest backup, write bootstrap/tokens, wake the container             |
| `GET /api/debug/exec`      | Run a command in the user's container                                         |
| `POST /api/admin/stop`     | Final backup, then stop the container                                         |
| `POST /api/admin/destroy`  | Final backup, then destroy the container                                      |
| `GET /api/admin/status`    | Container state for a user                                                    |
| `POST /api/admin/snapshot` | Force a snapshot now                                                          |
| `POST /api/admin/restore`  | Force-restore the latest backup now                                           |

## Security Notes

The container environment carries two credentials:

- **`CLOUDFLARED_TOKEN`** — the per-user Cloudflare Tunnel credential used by `cloudflared tunnel run`.
- **`HERMES_DASHBOARD_SESSION_TOKEN`** — the per-user dashboard session token.

Both are visible to any process in the container, including the Hermes agent itself. This is accepted for now because Cloudflare Sandbox is a single-container runtime with no sidecar or separate-privilege model to isolate `cloudflared` from the agent.

Possible hardening (not yet implemented): move `CLOUDFLARED_TOKEN` to a restricted file (e.g., `/run/creds.json` with `0400` permissions) and run `cloudflared` as a separate user from the Hermes agent.

## Quick Start

See `ONBOARDING.md` for full setup instructions.

## License

This project is licensed under the MIT License.

Portions of this project are derived from [**hermes-flare**](https://github.com/carimura/hermes-flare) by Carter Morgan, which is licensed under the Apache License, Version 2.0. Specifically:

- The R2-backed squashfs state persistence pattern (`createBackup` / `restoreBackup`)
- The sentinel-file integrity check approach for ephemeral container state hydration
- The separation of install path (`/opt/hermes-install`) from mutable state (`/home/hermes`)

The Apache License, Version 2.0 applies to those derived portions. A copy of the Apache 2.0 license is included in the repository for compliance. All original work in this project is licensed under MIT.

We gratefully acknowledge the hermes-flare project for demonstrating Cloudflare Sandbox persistence patterns that inform this implementation.
