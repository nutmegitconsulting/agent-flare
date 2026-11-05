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

- Hostname `agents.shipleybuilds.ai`, Worker `agent-flare`, image tag `9765e5d`, deployed from commit `4e1fd74`. Access app "agents" (Chris's) covers it, and that hostname only.
- `workers_dev` and `preview_urls` are off. The Access app also lists a workers.dev name; nothing serves there.
- R2 `agent-flare-state`, KV `agent-flare-credentials`, secrets `MASTER_KEY` and `CLOUDFLARE_AI_API_TOKEN`, two crons, template `team` assigned as the default, tiers in `config/model-tiers.json`.
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

- Worker unit tests: 49 pass (`npm test`). `tsc` clean.
- Container tests: 38 unit, 37 integration pass (`tests/container/run.sh`), including a real chat turn to a stub provider for each tier mark.
- End to end through `wrangler dev`: 111 pass (`node tests/e2e/run.mjs`), including 14 Worker routes against 5 kinds of bad token and 14 admin routes against non-admin, absent, forged and wrong-audience tokens.

## Found while deploying

- The old example template never worked: a provider that's only listed leaves Hermes reporting nothing connected. A selected provider with no key sends `no-key-required` and gets refused. The container now selects only a provider that has a credential.
- A snapshot taken as a container stopped could record 0 files, outrank every good backup and pass verification. It appeared once, under load, and it's fixed. It was older than this work.
- A single 4 GB layer timed out pushing. The image is now multi-stage, 1.85 GB compressed. Pushing through inspection can still time out on one layer; retrying finishes it.
- The first login landed on a workers.dev name instead of the app. That name was a second hostname on the Access app, and the request never reached the Worker. It stopped once Chris removed the hostname.
- **Most gateway models answer 429 (2026-11-05), and we don't know exactly why.** `AiError: Service temporarily at capacity`, code 4006, 0 neurons. Over the day `glm-5.3-flash` never answered, on every path, and neither did `kimi-k2.5`, `kimi-k2.6`, `kimi-k2.7-code`, `glm-5.2`, `glm-5.3`, or any of the 3 DeepSeek models. `gemma-4-26b` answered once and then stopped. These answered every time: `qwen3.8-27b`, `gpt-oss-20b`, `gpt-oss-120b`, `glm-4.7-flash`, `llama-4-scout`.
  - **Not a wrong reference:** IDs match Cloudflare's catalog; a bad ID gets 400 (5007 or 2008), never 429. Adding the `workers-ai/` prefix from the compat docs changes nothing, and the bare `@cf/` form works on `qwen3.8-27b`. The same 429 comes back without AI Gateway, on the REST `/ai/run` route from the model page and on `/ai/v1`.
  - **Not a label bug:** all 11 names map to their own ID in the deployed files. A pick sent the right ID in tests and in a real session against a stub.
  - **Not settled:** code 4006 isn't in Cloudflare's error table (capacity is 3040, free allocation is 3036). A second credential couldn't test it, so upstream capacity and a limit on this account or key can't be told apart from here. Next: try the Workers AI playground on this account, then a Cloudflare ticket quoting 4006 and the request IDs.
  - `moondream3.1` is an image-to-text model: 502 through the gateway's chat route, 200 direct. It probably doesn't belong in a chat list; Chris's call.
- The `team` template selects `@cf/qwen/qwen3.8-27b`, which works. glm stays listed. An existing user keeps the model they have until they pick another.
- **A deploy restarts running containers.** The rollout signals them to exit with no final snapshot, so a user can lose work since the last 10-minute snapshot. Deploy when nobody's active, or stop them first.

## First login, production (2026-11-05)

Proven with Chris's real login on the phone: Access, the Worker accepting a real JWT, container start, hydration, silent Hermes sign-in, the webapp, the template's provider selected, automatic snapshots, and a chat turn through the production gateway. Chris's `/__af/admin/users` showed state ready, template `team`, `cloudflare-gateway` selected, nothing missing, no warnings, no snapshot error, 2 backups.

## Admin screens, deployed 2026-11-05

Not yet used with a real login.

- **Admin screens** at `/__af/admin`, server-rendered with no script (`src/admin.ts`): users, a user's effective config, roles, per-user overrides, keys, audit.
- **Roles are templates**, and assigning one is an entry in `assignments.users`. Precedence: per-user override (`config/overrides/<email>.json`) > role > group, domain and default assignments (`src/effective.ts`).
- **Keys are write-only** (`src/credentials.ts`): sealed in KV, shown only as set/not set and last changed. Order: user > role > the Worker secret the provider names. At boot a key goes to that user's `.env`, as provider keys always have.
- **Timing:** every change applies at the user's next boot. The Users screen shows who's waiting. "Apply now" snapshots and then restarts; if the snapshot fails, the container stays up and nothing changes.
- **Default model:** a role's default follows a role change only if the user hasn't picked their own.
- **Audit:** one new R2 object per change, under `audit/`, never with a key value.
- Roles only set which models appear and the default. **Chris's decision (2026-11-05): usability, not security**, so there's no enforcement and no budgets. The screens say so.

## Tier marks and dark mode (2026-11-05)

Chris: vanilla Hermes, with no patch and no new plugin code. A plugin mark and a webapp patch were both built and removed. The Access auth plugin stays, because login depends on it.

- **Tier marks are plain config:** `model_aliases` maps a shown name such as `+glm-5.3` to its real ID. Chris chose `-` low, `|` medium, `+` high. The webapp strips a leading hyphen and refuses to switch to one, so low uses the minus sign U+2212, which looks the same; the role form also accepts a typed hyphen. Names have no space after the mark, because the webapp can't switch to a name with a space in a running session.
- **One list:** `config/model-tiers.json` in R2, shared by all roles. Source: `templates/model-tiers.example.json`. Cutoffs: blended = (3 x input + output) / 4 per million tokens; low under 0.50, medium up to 1.50, high above. Pricing page updated 2026-10-20.
- **Limit:** the model in use shows under its real name, with no mark, in the pill and in an extra top row of the menu.
- **Dark mode:** seeded into Hermes's own `ui-preferences.json` when the key is absent. It's the user's afterwards.

## Known limit, and a future option

- The shared gateway key is in every user's `.env`, so their agent can read it and call any model it allows. Chris accepts this for now. It's also the key on Chris's own Hermes profile.
- If real limits are wanted later, Containers outbound handlers look like the way: per the docs they run outside the container, with bindings, so the container could hold no key. The Worker would check each request's model against the user's role and set the user tag itself. Per-role keys wouldn't do it: Cloudflare's docs say `AI Gateway Run` can't be limited to one gateway. Not built and not spiked.

## To do when Chris is home

**Why most gateway models return 429.** Chris's hypothesis: it comes from the difference between free and paid access to AI Gateway.

- **For:** Cloudflare marks `glm-5.3-flash`, `glm-5.3` and the DeepSeek and Kimi k2.6 and k2.7 models as paid access required, and all of them return 429. `qwen3.8-27b` and `gpt-oss-20b` aren't marked paid, and they answer. The same docs offer prepaid AI Gateway credits as a way to use paid models.
- **Against:**
  - `gemma-4-26b` and `kimi-k2.5` aren't marked paid and also return 429, and `gemma-4-26b` answered once earlier.
  - The error says "Service temporarily at capacity", not anything about billing. Its code, 4006, isn't in Cloudflare's error table. The account's analytics record these calls as 4006 with 0 neurons.
  - The same 429 comes back without AI Gateway, on the REST routes, so the gateway path alone doesn't explain it.
  - Containers run on this account, which needs Workers Paid. The plan itself couldn't be read, though, and nothing checked the gateway's billing setting or credits.
- **Next:**
  1. Try `glm-5.3-flash` in the Workers AI playground on this account. If it answers there, look at this key and path; if not, the account or upstream.
  2. If it still fails, open a Cloudflare ticket quoting code 4006, the 0-neuron analytics and a request ID.

Details are under "Found while deploying".

## Not proven yet

0. With a real login: the admin screens, "Apply now", tier marks in the picker, and dark mode
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
