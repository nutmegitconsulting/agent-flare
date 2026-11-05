# Agent Flare

Runs a private [Hermes Agent](https://hermes-agent.nousresearch.com/) for each person on your team, on Cloudflare, in the browser. Nothing to install on a laptop.

```
Browser ── HTTPS ──▶ Cloudflare Access ──▶ Worker ──▶ that user's Sandbox ──▶ Hermes webapp :9120
                                             │               │
                                             │               └─ squashfs snapshots ──▶ R2
                                             └─ per-user secrets, encrypted ─────────▶ KV
```

- **One hostname, one container per person.** The Worker verifies the Access JWT and routes on the Access user ID. No request parameter can reach another user's container.
- **HTTPS for the browser; Hermes on its default port inside.** Browsers use 443 at Cloudflare, where TLS ends. Hermes listens on 9120, plain HTTP, in the container. Containers have no public ingress, so the Worker's Access-verified path is the only way in. Keep `workers_dev` and `preview_urls` off so every request arrives through Access.
- **One login.** A small Hermes auth provider trusts the identity the Worker verified, so users never see a second sign-in.
- **Containers sleep when idle and wake on the next request.** A starting page shows while state comes back.
- **State survives.** Snapshots go to R2 every 10 minutes while in use and on every stop. Restores are verified, and a bad backup never replaces a good one.
- **Inference ready on first launch.** A template assigned by email, Access group or domain gives a user a working provider and model, with nothing to set up.

## How state works

Container disks are ephemeral, so a user's Hermes home (`/home/hermes/.hermes`) is rebuilt on every boot.

**Boot.** Hermes waits behind a gate while the Worker hydrates the home:

1. Restore the newest backup into a scratch directory, verify it (file count, bytes, SQLite `quick_check` on Hermes' own databases), and swap it into place. Only proof of corruption falls back to an older backup. A transient failure retries the newest, because falling back would let a new snapshot outrank it for good.
2. Decrypt the user's secret files from KV.
3. Apply their template (first launch), managed config and environment, and select an inference provider.
4. Open the gate. Hermes starts, and snapshots are allowed from this point on.

If backups exist and none can be restored, **the container doesn't start**. The user sees an error, and the backups stay as they are. Starting empty would soon snapshot an empty home over their history.

**Snapshot.** `container/af_state.py` builds a staged copy first: SQLite through its backup API (consistent even while Hermes writes), without Hermes' logs and caches, without secrets. The SDK archives that copy. What counts as a secret is Hermes' own list of credential stores, at the home's root and inside each profile. Those files are encrypted into KV separately, so the bucket is safe to replicate. KV holds about 12 MB per user; past that the largest files, usually browser data, are left out and logged.

Hydration, snapshots and pruning for a user run one at a time inside their Durable Object.

**Sleep.** When a container idles past `SLEEP_AFTER`, it takes a final snapshot and stops. If the snapshot fails it stays up and retries, up to three idle cycles. The snapshot cron skips containers with no activity since their last snapshot, so it doesn't hold them awake. An open browser tab holds a WebSocket and counts as activity.

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
| Worker Secrets | `MASTER_KEY`, `CLOUDFLARE_AI_API_TOKEN`, and secrets listed in the `TEMPLATE_SECRETS` var, which templates can reference as `$NAME`. Provider credentials reach a user's `.env` only, on each boot; they stay out of snapshots |
| KV, encrypted | Each user's secret files; admin prefills. AES-256-GCM, key derived from `MASTER_KEY` and bound to the KV key |
| Derived, never stored | Per-user sign-in secrets, via HKDF from `MASTER_KEY` |

A Worker holds at most 128 secrets and vars (64 on the free plan), so per-user values can't live in Worker Secrets. This design has no such cap on users. **Back up `MASTER_KEY`**: losing or rotating it makes everything sealed in KV unreadable.

## Config templates

A template's main job is to pre-fill inference providers, so a user's first launch can already answer.

```
templates/<name>/template.json     what to apply
templates/<name>/files/...         files copied into the Hermes home on first launch
```

`template.json`:

| Key | Applies | Who wins |
|---|---|---|
| `providers` | Every boot | The template, per provider name |
| `files` | First time the user gets this template, if the file doesn't exist | The user, afterwards |
| `config_defaults` | First launch, or when first assigned this template | The user, afterwards |
| `config_managed` | Every boot | The template |
| `env` | Every boot; `"$NAME"` reads Worker secret `NAME` if `TEMPLATE_SECRETS` lists it. Removed from `.env` when dropped from the template | The template |

Agent Flare's own `webapp` and `dashboard.trusted_proxies` keys always win, so a template can't change the port or public URL.

### Providers

Each entry in `providers`:

| Field | |
|---|---|
| `name` | Lowercase letters, digits and dashes. Not a Hermes built-in such as `openrouter`, which would route to the built-in instead |
| `mode` | `api_token`: credential is the Worker secret `CLOUDFLARE_AI_API_TOKEN`, shared by everyone, with requests tagged per user. `user_env`: credential comes from the user's `.env` |
| `base_url` | An `https://` OpenAI-compatible endpoint. For AI Gateway: `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/compat` |
| `key_env` | The `.env` variable holding the credential |
| `gateway_id` | `api_token` only. Sent as `cf-aig-gateway-id` |
| `model` | The model to select. Defaults to the first of `models` |
| `models` | Model IDs, with `context_length` and `max_length` |
| `api_mode`, `discover_models` | Optional; defaults `chat_completions`, `false` |
| `extra_headers` | Optional. A header carrying a credential must read it as `"Bearer ${VAR}"`, with `VAR` set through `env`, because `config.yaml` goes in snapshots |

**Selection.** Hermes uses only the selected provider, so listing one isn't enough. On every boot, if the user has no model selected, the first provider whose `key_env` has a value is selected. A choice the user makes in Hermes is never replaced. A selection Agent Flare made moves on if its credential is withdrawn.

**A missing secret** never stops a container. That provider is skipped, the next one with a credential is selected, and if none has one, Hermes opens on its own "connect a provider" setup. Nothing is selected that couldn't answer. `/__af/admin/users` shows each user's `config.inference` (`selected`, `missing`) and `config.warnings`, by variable name only. Once the secret is set, the provider is selected at that user's next boot.

Three ways to supply a credential:

| Credential | Provider | Set it with |
|---|---|---|
| Shared, Cloudflare | `mode: "api_token"` | `npx wrangler secret put CLOUDFLARE_AI_API_TOKEN` |
| Shared, any other | `mode: "user_env"`, plus `"env": {"KEY_ENV": "$NAME"}` | `npx wrangler secret put NAME`, and add `NAME` to `TEMPLATE_SECRETS` |
| Per user | `mode: "user_env"` | The admin prefill below, or the user in Hermes |

See `templates/example/` and `templates/assignments.example.json`. Your real templates are gitignored, because this repo may be public. They hold no secrets, only references.

```bash
cp -r templates/example templates/mine                 # replace each YOUR_ value
node scripts/templates.mjs check templates/mine        # validate, refuse placeholders and secrets, list secrets needed
node scripts/templates.mjs push templates/mine         # upload
node scripts/templates.mjs assign assignments.json     # who gets what
```

`check` needs Node 22.18 or later. Assignment order: exact email, then Access group, then email domain, then `default`.

To set a personal value before someone's first login, such as their own API key:

```bash
curl -X PUT https://agents.example.com/__af/admin/prefill/someone@example.com \
  -H "cookie: CF_Authorization=$TOKEN" -d '{"OWN_PROVIDER_API_KEY": "..."}'
```

It's used only while the user hasn't set that variable themselves.

## Admin screens

`/__af/admin`, for people in `ADMIN_EMAILS`: users with status and backups, a user's effective config, roles, per-user overrides, keys, and an audit trail.

A role is a template, so the screens and `scripts/templates.mjs` work on the same thing. Precedence: per-user override, then assigned role, then group, domain and default assignments. Roles set which models appear in the picker, the default, and the provider settings. They make choosing easy and aren't access limits: a provider key is in each user's `.env`, so their agent can use whatever it allows.

Keys are write-only, and sealed in KV. Screens show only whether one is set and when it changed. Order: user, then role, then the Worker secret the provider names.

Every change applies at the user's next boot, and the Users screen shows who's waiting. A user's page can apply it now: that snapshots and then restarts, and if the snapshot fails, nothing changes. A role's default model follows a role change only if the user hasn't picked their own. `config_managed` reapplies every boot; `config_defaults` applies once and is then the user's.

The picker shows our score for agent work as the first character of a model's name: `−` low, `|` medium, `+` high. It's ordinary Hermes config: a model alias maps the shown name to the real ID. The list is `config/model-tiers.json`, shared by every role; edit it with `scripts/templates.mjs tiers` or by typing the mark in a role's model list. A model with no entry shows no mark. Low is the minus sign U+2212, because Hermes's name formatting removes a leading hyphen. The model in use shows under its real name.

New homes start in dark mode, through Hermes's own preferences file. A user can change it, and a choice they've made is never replaced.

## Routes

Everything is behind Access. Anything not listed goes to the caller's Hermes webapp.

| Route | Does |
|---|---|
| `GET /__af/status` | Wakes the caller's container; reports its state |
| `POST /__af/snapshot` | Snapshots the caller's container |
| `POST /__af/stop` | Final snapshot, then stop |
| `/__af/admin` | Admins: the screens above |
| `GET /__af/admin/users` | Admins: all users, their backups, and their selected inference provider |
| `POST /__af/admin/users/:sub/{stop,snapshot,prune}` | Admins: act on a user |
| `PUT /__af/admin/prefill/:email` | Admins: pre-set a user's `.env` values |

Admins are listed in the `ADMIN_EMAILS` var.

## Deploying

See [ONBOARDING.md](ONBOARDING.md).

## Testing

```bash
npm test                      # Worker unit tests
tests/container/run.sh        # clean image, real webapp behind a simulated proxy, a chat turn to a stub provider, state round trip
node tests/e2e/run.mjs        # wrangler dev: Worker, Durable Object, container, local R2 and KV
```

The end-to-end test simulates Access with a locally generated signing key. It covers every route refusing absent, forged, wrong-audience, wrong-issuer and expired tokens, isolation between users, the starting page, WebSockets, templates, provider selection with and without its secret, restore after stop, fallback from corrupt backups, failing closed when every backup is bad, and idle sleep. It can't cover real Access login, production R2 or production container timing.

The Hermes version is pinned in the `Dockerfile` (`HERMES_COMMIT`), because the sign-in provider uses Hermes internals. Rerun `tests/container/run.sh` when bumping it.

## Limits

- A container sleeping means Hermes' own scheduled jobs and messaging gateways don't run. Raise `SLEEP_AFTER` for those, at higher cost.
- A forgotten open tab keeps a container running.
- Only the Hermes home survives a restart. Agents default to working in `<home>/workspace` for that reason. Files elsewhere in the container, such as `~/.gitconfig` for the OS user, are lost; `terminal.home_mode: profile` in `config.yaml` keeps those under the home too.

## License

This project is licensed under the MIT License.

Portions of this project are derived from [**hermes-flare**](https://github.com/carimura/hermes-flare) by Carter Morgan, which is licensed under the Apache License, Version 2.0. Specifically:

- The R2-backed squashfs state persistence pattern (`createBackup` / `restoreBackup`)
- The separation of install path (`/opt/hermes-install`) from mutable state (`/home/hermes`)

The Apache License, Version 2.0 applies to those derived portions. A copy of the Apache 2.0 license is included in this repository for compliance. All original work in this project is licensed under MIT.

We gratefully acknowledge the hermes-flare project for demonstrating Cloudflare Sandbox persistence patterns that inform this implementation.
