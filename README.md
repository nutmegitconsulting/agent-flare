# Agent Flare

Runs a private [Hermes Agent](https://hermes-agent.nousresearch.com/) for each person on your team, on Cloudflare, in the browser. Nothing to install on a laptop.

```
Browser ── HTTPS ──▶ Cloudflare Access ──▶ Worker ──▶ that user's Sandbox ──▶ Hermes webapp :443
                                             │               │
                                             │               └─ squashfs snapshots ──▶ R2
                                             └─ per-user secrets, encrypted ─────────▶ KV
```

- **One hostname, one container per person.** The Worker verifies the Access JWT and routes on the Access user ID. No request parameter can reach another user's container.
- **One login.** A small Hermes auth provider trusts the identity the Worker verified, so users never see a second sign-in.
- **Containers sleep when idle and wake on the next request.** A starting page shows while state comes back.
- **State survives.** Snapshots go to R2 every 10 minutes while in use and on every stop. Restores are verified, and a bad backup never replaces a good one.
- **Config templates.** A user's first launch is already filled in, from a named template assigned by email, Access group or domain.

## How state works

Container disks are ephemeral, so a user's Hermes home (`/home/hermes/.hermes`) is rebuilt on every boot.

**Boot.** Hermes waits behind a gate while the Worker hydrates the home:

1. Restore the newest backup that verifies: squashfs extraction, then a manifest check and SQLite `quick_check`. A corrupt backup falls back to the next oldest.
2. Decrypt the user's secret files from KV.
3. Apply their template (first launch), managed config and environment.
4. Open the gate. Hermes starts, and snapshots are allowed from this point on.

If backups exist and none can be restored, **the container doesn't start**. The user sees an error, and the backups stay as they are. Starting empty would soon snapshot an empty home over their history.

**Snapshot.** `container/af_state.py` builds a staged copy first: SQLite through its backup API (consistent even while Hermes writes), without logs and caches, without secrets. The SDK archives that copy. Secret files (`.env`, `auth.json`, `mcp-tokens/`) are encrypted into KV separately, so the bucket is safe to replicate.

**Sleep.** When a container idles past `SLEEP_AFTER`, it takes a final snapshot and stops. The snapshot cron skips containers with no activity since their last snapshot, so it doesn't hold them awake. An open browser tab holds a WebSocket and counts as activity.

R2 layout:

```
users/<sub>/backups-index.json   restore source of truth
backups/<id>/data.sqsh           snapshot archive
backups/<id>/meta.json           snapshot metadata
active/<sub>                     marker: this user may have a running container
config/assignments.json          who gets which template
templates/<name>/...             templates
```

Retention (`src/prune.ts`) keeps recent snapshots densely and older ones sparsely, and never deletes the newest.

## Secrets

| Where | What |
|---|---|
| Worker Secrets | `MASTER_KEY`, `CLOUDFLARE_AI_API_TOKEN`, anything a template references as `$NAME` |
| KV, encrypted | Each user's secret files; admin prefills. AES-256-GCM, key derived from `MASTER_KEY` and bound to the KV key |
| Derived, never stored | Per-user sign-in secrets, via HKDF from `MASTER_KEY` |

A Worker holds at most 128 secrets and vars (64 on the free plan), so per-user values can't live in Worker Secrets. This design has no such cap on users. **Back up `MASTER_KEY`**: losing or rotating it makes everything sealed in KV unreadable.

## Config templates

```
templates/<name>/template.json     what to apply
templates/<name>/files/...         files copied into the Hermes home on first launch
```

`template.json`:

| Key | Applies | Who wins |
|---|---|---|
| `files` | First launch, if the file doesn't exist | The user, afterwards |
| `config_defaults` | First launch | The user, afterwards |
| `config_managed` | Every boot | The template |
| `env` | Every boot; `"$NAME"` reads Worker secret `NAME` | The template |
| `providers` | Every boot | The template, per provider name |

Agent Flare's own `webapp` and `dashboard.trusted_proxies` keys always win, so a template can't change the port or public URL.

See `templates/example/` and `templates/assignments.example.json`. Your real templates are gitignored, because this repo may be public.

```bash
node scripts/templates.mjs check templates/mine        # validate, refuse anything that looks like a secret
node scripts/templates.mjs push templates/mine         # upload
node scripts/templates.mjs assign assignments.json     # who gets what
```

Assignment order: exact email, then Access group, then email domain, then `default`.

To set a personal value before someone's first login, such as their own API key:

```bash
curl -X PUT https://agents.example.com/__af/admin/prefill/someone@example.com \
  -H "cookie: CF_Authorization=$TOKEN" -d '{"OPENAI_API_KEY": "..."}'
```

It's used only while the user hasn't set that variable themselves.

## Routes

Everything is behind Access. Anything not listed goes to the caller's Hermes webapp.

| Route | Does |
|---|---|
| `GET /__af/status` | Wakes the caller's container; reports its state |
| `POST /__af/snapshot` | Snapshots the caller's container |
| `POST /__af/stop` | Final snapshot, then stop |
| `GET /__af/admin/users` | Admins: all users and their backups |
| `POST /__af/admin/users/:sub/{stop,snapshot,prune}` | Admins: act on a user |
| `PUT /__af/admin/prefill/:email` | Admins: pre-set a user's `.env` values |

Admins are listed in the `ADMIN_EMAILS` var.

## Deploying

See [ONBOARDING.md](ONBOARDING.md).

## Testing

```bash
npm test                      # Worker unit tests
tests/container/run.sh        # image, real webapp behind a simulated proxy, state round trip
node tests/e2e/run.mjs        # wrangler dev: Worker, Durable Object, container, local R2 and KV
```

The end-to-end test simulates Access with a locally generated signing key. It covers forged tokens, isolation between users, the starting page, WebSockets, templates, restore after stop, fallback from corrupt backups, failing closed when every backup is bad, and idle sleep. It can't cover real Access login, production R2 or production container timing.

The Hermes version is pinned in the `Dockerfile` (`HERMES_COMMIT`), because the sign-in provider uses Hermes internals. Rerun `tests/container/run.sh` when bumping it.

## Limits

- A container sleeping means Hermes' own scheduled jobs and messaging gateways don't run. Raise `SLEEP_AFTER` for those, at higher cost.
- A forgotten open tab keeps a container running.
- `sandbox.wsConnect` refuses ports below 1024, so the Worker switches ports itself for WebSockets (`src/index.ts`).

## License

This project is licensed under the MIT License.

Portions of this project are derived from [**hermes-flare**](https://github.com/carimura/hermes-flare) by Carter Morgan, which is licensed under the Apache License, Version 2.0. Specifically:

- The R2-backed squashfs state persistence pattern (`createBackup` / `restoreBackup`)
- The separation of install path (`/opt/hermes-install`) from mutable state (`/home/hermes`)

The Apache License, Version 2.0 applies to those derived portions. A copy of the Apache 2.0 license is included in this repository for compliance. All original work in this project is licensed under MIT.

We gratefully acknowledge the hermes-flare project for demonstrating Cloudflare Sandbox persistence patterns that inform this implementation.
