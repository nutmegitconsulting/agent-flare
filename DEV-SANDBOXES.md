# Dev Sandboxes — Path A (per-user Cloudflare Sandboxes behind the internal gateway)

Handoff document: what was built, the sources it rests on, and the process to stand it up per tenant.
**Status: implemented and locally verified; not yet deploy-verified** — the unverified item is marked throughout.

---

## 0. TL;DR

Each agent-flare user's `terminal`, `execute_code`, and file tools run in **their own Cloudflare Sandbox
container** (a separate Linux microVM) instead of inside the deliberately-restricted agent container. The
container reaches the sandbox through an **internal service-binding path**: no public hostname, no tokens in
any container's `.env`, no image rebuild required for a trial. The feature is per-tenant, switched on by one
wrangler build variable (`AF_DEV_SANDBOX_WORKER`); tenants that don't set it are byte-for-byte unchanged.

The agent-flare container stays exactly as restricted as it is. The sandbox is a separate tenancy.

---

## 1. The shape

```
Browser ──Access──▶ agent-flare Worker ──▶ AgentSandbox DO (one per Access user) ──▶ user's Hermes container
                                            │  hydrate(): registers the outbound intercept
                                            ▼
   Hermes (in container) ──http://cfsandbox.internal──▶ SandboxGateway (props {sub})
                                            │ service binding DEV_SANDBOX (never public)
                                            ▼
                        cf-dev-sandbox Worker ──idFromName(key(sub))──▶ DevSandbox DO ──▶ sandbox VM
```

1. **Identity already exists.** The agent-flare Worker verifies the browser's Cloudflare Access JWT on every
   request (`src/index.ts` middleware, `src/access.ts`) and resolves one Durable Object per user:
   `sandboxFor(env, sub)` → `getSandbox(env.Sandbox, sub.toLowerCase())` → `idFromName(sub)`. The file header
   states the invariant this whole design leans on: *"The container key comes only from a verified Access
   JWT, so no request parameter can reach another user's container."*
2. **The container asks for its sandbox** via the Hermes plugin (terminal-environment backend) speaking plain
   HTTP to a fake, non-resolvable hostname `cfsandbox.internal`.
3. **The AgentSandbox DO stamps identity in-process.** During `hydrate()` — registered before the
   hasReadyFile early-return so both fresh starts and restarted DOs get it — the DO calls
   `ctx.container.interceptOutboundHttp("cfsandbox.internal", ctx.exports.SandboxGateway({ props: { sub } }))`.
   Intercepts last until the container stops; hydrate re-runs on cold start and DO restart, so registration
   self-heals. **The sub comes from the DO that verified the Access JWT — never from anything the container
   sends.** This is the rule that makes cross-user abuse impossible by construction.
4. **The gateway derives the sandbox name from the verified identity only.** `SandboxGateway`
   (`src/gateway.ts`) overwrites any client-supplied key, strips `Authorization` and `CF-Access-*` headers,
   and forwards via the `DEV_SANDBOX` service binding to `getByName(key(props.sub))`.
5. **The sidecar Worker owns the sandbox lifecycle.** Its `DevSandbox` Durable Object drives the Durable
   Object Container API: lazily `container.start({ image, entrypoint: ["sleep", "infinity"], enableInternet })`,
   `container.exec(["bash", "-lc", command], { cwd, signal })`, alarm-based auto-snapshot on idle
   (`snapshotContainer()` → store the id in DO storage → `destroy()`), restore on the next request via
   `container.start({ containerSnapshot: { id } })`, `setInactivityTimeout()` re-armed in the constructor,
   and client-disconnect aborts wired through the `enable_request_signal` compatibility flag.
6. **The plugin** (`plugin/cloudflare_sandbox/`, baked at `plugins/cloudflare_sandbox` by the Dockerfile
   COPY, or installed per user) subclasses Hermes' `BaseEnvironment` and implements only `_run_bash()` —
   the same primitive the built-in SSH backend implements — inheriting background-process plumbing, env
   bookkeeping, cwd tracking, stdin, bounded output and the timeout backstop. Its local client POSTs the
   command to the gateway hostname and hands back the result, which arrives whole when the command ends,
   through a real `Popen`, so the inherited machinery
   is exercised identically to SSH.

---

## 2. Why it is safe against abuse

**Cross-user (intentional).** The only name-forming input for the sandbox DO is `props.sub`, set by the DO
that verified the Access JWT. Request body and headers are payload, never identity — there is no key to
spoof because the gateway strips/overwrites it. Same guarantee as `sandboxFor`, extended one hop.

**Direct hits.** The sidecar has `workers_dev: false`, `preview_urls: false`, no routes, no custom domain.
Its only entry is the service binding from the agent-flare Worker, reachable only through the gateway, which
is reachable only through the intercept the user's own DO installed. From the internet the endpoint does not
exist.

**Code inside the sandbox.** The microVM is the trust boundary: no Worker memory, no bindings, no other
sandboxes, no shared localhost. Nothing secret is ever placed inside (no env forwarding; the plugin forwards
no credentials; in Path A there is no credential at all). Sandbox code hitting agent-flare's public hostname
is just an unauthenticated internet client behind the existing Access/WAF.

**Resource abuse.** One DO per user means no fan-out; idle sandboxes are snapshotted and stopped (billed only
while running). Known gap: the sidecar container sits **outside agent-flare's `underAwakeCap`** accounting —
decide whether to count it or accept ~2× container cost for active users. The gateway can add a per-sub
concurrency cap cheaply later.

**Failure modes fail closed.** No binding → no intercept, no shipped env value, gateway answers 503; the
plugin's URL simply doesn't resolve and Hermes reports a command failure. No silent fallback exists.

---

## 3. What was changed where

**agent-flare repo** (all behind the `DEV_SANDBOX` binding flag; tenant without the binding is unchanged):

| File | Change |
|---|---|
| `src/gateway.ts` (new) | `SandboxGateway` WorkerEntrypoint: `props {sub}` → stamps `X-Sandbox-Key` = `"af-" + sanitized(sub)`, strips client auth headers, forwards via the binding |
| `src/sandbox.ts` | `hydrate()`: the intercept registration (fail-soft, both hydrate paths); `applyConfiguration()`: ships `CF_DEV_SANDBOX_URL=http://cfsandbox.internal` as a platform `.env` value (platform-wins over templates, carries no secret) |
| `src/env.ts` | optional `DEV_SANDBOX?: Fetcher` binding (unbound = feature off) |
| `src/index.ts` | exports `SandboxGateway` |
| `wrangler.example.jsonc` | optional `services` block between `// BEGIN_DEV_SANDBOX` / `// END_DEV_SANDBOX` markers |
| `scripts/render-wrangler.mjs` | `AF_DEV_SANDBOX_WORKER` renders the service name in; unset **strips the block entirely** |
| `Dockerfile` | `COPY container/plugins/cloudflare_sandbox` → `plugins/cloudflare_sandbox` in the Hermes install (inert until the env value arrives; per-user installs work without a rebuild) |
| `container/plugins/cloudflare_sandbox/` | the plugin, copied into the image. It also points Hermes' file routes (`/api/fs/*`, `/api/files/stream`) at the sandbox, so the file browser, previews, images and downloads read where the terminal writes. The webapp's git (`/api/git/*`: worktrees, branches, the review pane) and a session's branch run there too, and a session started in a folder of the workspace runs in that folder of `/workspace` |
| `ONBOARDING.md` | build-variable row + "per-user dev sandboxes" section |

**Sidecar** (`~/cf-dev-sandbox/`, tarball at `~/cf-dev-sandbox.tar.gz`): `worker/` (Worker + `DevSandbox` DO:
`/exec`, `/home`, `/status`, `/pty`, alarm snapshot recipe, output cap 1 MiB, 1 MiB command cap, server-side exec
deadline with the documented safe AbortController pattern), `plugin/cloudflare_sandbox/` (the Hermes
backend), `scripts/smoke.sh`, `tests/` (contract test), `README.md`.

**Plugin credential modes** (the sidecar serves both): Path A internal — no secret at all, the gateway-stamped
`X-Sandbox-Key` is required; Path B (public hostname testing) — bearer `SANDBOX_TOKEN` secret, optionally
Cloudflare Access service-token headers.

---

## 4. Process

### 4.1 One-time: the sidecar Worker

Same Cloudflare account as the tenant's agent-flare Worker (service bindings are same-account). No secret
needed for Path A.

```bash
cd ~/cf-dev-sandbox/worker    # or a clone of the sidecar repo
npm install
npx wrangler deploy           # image: cloudflare/debian-trixie (managed) — no local Docker
```

One sidecar can serve **several agent-flare Workers in the same account**; sandbox keys derive from the
Access `sub`, so the same person's dev sandbox follows them across tenants that bind the same sidecar.
Deploy a second sidecar (same code, another `--name`) for tenant-isolated sandboxes.

Tunables (wrangler `vars`): `SANDBOX_IMAGE` (managed image ref), `ENABLE_INTERNET` (default `true` — see
open items), `SANDBOX_INSTANCE` (`lite` default; `standard-1` for heavier builds), `MAX_OUTPUT_BYTES`.

### 4.2 Per-tenant: enable the feature

Follow ONBOARDING.md for a fresh tenant; the only addition is one build variable:

- **Workers Builds (dashboard import):** build variables include `AF_DEV_SANDBOX_WORKER=cf-dev-sandbox`
  alongside the usual `AF_*` set. Point the application's production branch at the branch carrying this work.
- **From your machine:** `AF_DEV_SANDBOX_WORKER=cf-dev-sandbox` in the environment before
  `node scripts/render-wrangler.mjs` (render in / `wrangler deploy`).
- **No Docker needed for the trial:** the Worker code deploys like any Worker. The baked plugin is optional —
  per-user install (4.3) replaces it — and `AF_IMAGE=<existing pushed image>` avoids an image build entirely.

Rollout control: **unset the variable and the feature is gone** — the services block is stripped from the
rendered config, no binding, no intercept, no env value, no plugin activation.

### 4.3 Per-user: turn it on

Inside the user's Hermes container (either after the next image build, or per-user install of the two plugin
files into `~/.hermes/plugins/cloudflare_sandbox/`):

```bash
hermes plugins enable cloudflare-sandbox      # plugin name; backend name is cloudflare_sandbox
hermes config set terminal.backend cloudflare_sandbox
```

`CF_DEV_SANDBOX_URL=http://cfsandbox.internal` arrives with the next container boot as a platform `.env`
value. No token, no key: the gateway supplies identity. (`strip_env_keys` retains the legacy credential
names for Path-B testing; nothing needs setting in Path A.)

### 4.4 Verify

1. `npx wrangler tail` on the tenant Worker during a container boot: a clean hydrate shows no
   `[dev-sandbox:<sub>]` warns (those warns are the failure surface: missing intercept surface, missing
   export, registration failure).
2. In the user's Hermes: ask the agent to run `uname -a` — output should come from the sandbox VM
   (`whoami` = root of the sandbox image, `uname` = the microVM kernel).
3. `scripts/smoke.sh` against the sidecar (Path A mode: set only `CF_DEV_SANDBOX_URL` — but note smoke.sh
   speaks to the Worker *directly*, which only works with a route/B hostname; inside Path A, verify from
   Hermes instead).
4. Persistence: drop a marker file in the sandbox, let it idle past the snapshot+stop cycle
   (check every 60 s, idle limit 10 min), then run a command again — the marker should still be there.

5. The `sandbox` command: open a terminal tab in Hermes and run `sandbox`. The prompt changes to the
   sandbox's (`sandbox:/workspace#`), `ls` shows the agent's files, and `exit` returns to the tab's own
   shell. `wrangler tail` on the sidecar shows `GET /pty 101`.

### 4.5 A shell in the sandbox for the user: the `sandbox` command

Hermes' terminal pane always opens a shell beside Hermes (`/api/host-terminal` spawns a local PTY and never
asks the terminal backend), and it has no hook for another kind of terminal. So the pane is left alone and
the image carries a command: `sandbox`, typed in any terminal tab, attaches that tab to an interactive shell
in the user's sandbox. Tabs where it isn't typed stay local.

- **Sidecar:** `GET /pty` is a WebSocket. The Durable Object runs `bash -l` on a pseudo-terminal in the
  container (`container.exec` with `pty`) and carries the terminal's bytes as binary frames both ways. Text
  frames are control: `{"resize":[cols,rows]}` in; `{"exit":code}` or `{"error":message}` out, before the
  close. At most 8 shells per sandbox.
- **Idle:** a shell with input or output in the last minute counts as a command in flight, so no snapshot or
  stop lands under someone typing. A shell left alone doesn't hold the sandbox up: after the usual 10 minutes
  with no activity the sandbox is saved and stopped, and the tab is told why. Files are kept; what was
  running in the shell is not.
- **Closing the tab** hangs up everything on that shell's terminal, as closing a real terminal does.
- **Client:** `container/plugins/cloudflare_sandbox/shell_client.py`, run by `/usr/local/bin/sandbox` with
  Hermes' Python. It uses the plugin's settings from the environment or Hermes' `.env`, and goes through the
  same gateway, so the sandbox is the one named by the verified identity. A tab opened in a folder of
  Hermes' workspace starts in the same folder of `/workspace`.
- **Tests:** `tests/container/test_sandbox_shell.py` drives the command under a pseudo-terminal against a
  stand-in for `/pty`; `SANDBOX_SHELL_URL=http://localhost:PORT` points it at a sidecar under `wrangler dev`.

### 4.6 Roll back / turn off

Remove `AF_DEV_SANDBOX_WORKER` from the build variables and redeploy: the rendered config loses the binding;
running containers lose nothing (their snapshot survives in the sidecar until the 30-day TTL; an unused
sidecar costs nothing once instances stop).

---

## 5. Known open items and risks

1. **Not yet deploy-verified:** the `ctx.container.interceptOutboundHttp` + `ctx.exports` call shape under
   `@cloudflare/sandbox` 0.12.14 / compatibility date `2026-08-03` is unproven on the wire. The code
   fail-softs (logs `[dev-sandbox:<sub>]` warns) and hydrate continues; a live tenant deploy is the test.
   (`wrangler dev` verification needs Docker — unavailable on the build host.)
2. **Sandbox egress posture:** `ENABLE_INTERNET` defaults to `true` (dev sandboxes need `npm install`/`git`).
   Accepted for v1 because the security posture rests on *nothing secret inside the sandbox*, per
   [CF-Security]. An allowlist via `interceptOutboundHttps()` is the later hardening step.
3. **Container snapshots are public beta** and carry an **implicit 30-day TTL refreshed on restore**
   [CF-DO-API]. Regularly used sandboxes keep refreshing; a workspace untouched for 30 days is gone. For
   longer durability: R2 `DirectoryBackup` / `S3Mount` (later).
4. **Cost:** the sidecar container bills while running (outside `max_instances` and `underAwakeCap`).
5. **Kill semantics:** aborting a foreground command SIGKILLs the `bash -lc` wrapper; children it spawned
   keep running [CF-DO-API]. Long jobs run `nohup … >log 2>&1 &` and get polled — the inherited background
   plumbing handles that pattern (verified in the contract test).
6. **Sidecar DO storage** (snapshot ids, sandbox keys) is outside agent-flare's R2 snapshot scheme — the
   admin offboarding/wipe needs a second target.
7. **Plugin API version skew:** the contract was verified against the *installed* Hermes v0.22.7+193
   (commit `ed1afb0`); the public docs describe a slightly newer surface (e.g. hosted-scope machinery not
   present in the installed version — irrelevant for single-tenant containers). The docs' minimal contract
   says `execute()` returns `{"output", "exit_code"}`; the installed `BaseEnvironment` returns
   `{"output", "returncode"}` — this plugin rides the inherited implementation, so both consumers work.

---

## 6. Sources

### Cloudflare documentation (all fetched and read 2026-11-16; "last updated" dates from the pages)

- **[CF-Sandboxes]** Sandboxes on Cloudflare — overview, Containers vs Dynamic Workers. Last updated
  Sep 30, 2026. https://developers.cloudflare.com/sandbox/
- **[CF-Lifetime]** Sandbox lifetime — DO keeps storage; instance keeps files; activity/`setInactivityTimeout`
  (≤ 6 h); billed while running. Last updated Oct 22, 2026.
  https://developers.cloudflare.com/sandbox/concepts/lifetime/
- **[CF-SaveAuto]** Save a sandbox automatically — the alarm recipe this DO implements verbatim
  (CHECK_INTERVAL 60 s, IDLE_LIMIT 10 min, CHECKPOINT_INTERVAL 15 min, INACTIVITY_TIMEOUT 5 min;
  `containerSnapshot: {id}` restore; constructor re-arms the timeout). Last updated Oct 22, 2026.
  https://developers.cloudflare.com/sandbox/files/save-a-sandbox-automatically/
- **[CF-Security]** Sandbox security — *"the sandbox is the smallest unit of trust"* (exec `user` does not
  isolate inside a deployed durable-object-policy container: all processes hold root capabilities);
  *"Authenticate the caller in your Worker, and derive the sandbox name from that identity"*; credentials
  belong outside the sandbox; `enableInternet: false` by default; outbound handlers. Last updated Oct 22,
  2026. https://developers.cloudflare.com/sandbox/concepts/security/
- **[CF-Network]** Credentials and network access — keep tokens in the Worker; outbound handler patterns.
  Last updated Sep 30, 2026. https://developers.cloudflare.com/sandbox/network/
- **[CF-DO-API]** Durable Object Container API — `start({ image | containerSnapshot, enableInternet
  (required), entrypoint, instance, env, labels })`; `exec(cmd, { stdin, stdout, stderr: "combined", cwd,
  env, user, signal })` (no shell implied — `["bash","-lc",…]`); `output()` buffers in DO memory (128 MB);
  `snapshotContainer({name})` → `{id, size}` with the 30-day TTL; `destroy(reason)`; `setInactivityTimeout`
  (re-arm in the constructor); `interceptOutboundHttps(addr|glob, binding)` family; abort-on-disconnect via
  the `enable_request_signal` flag + safe AbortController pattern; *canceling the request that started a
  process does not stop it*. Last updated Nov 9, 2026.
  https://developers.cloudflare.com/containers/api/durable-object-container/
- **[CF-Exec]** Execute commands — `bash -lc` guidance, stdin piping, output buffering vs streaming, tree
  semantics of `kill()`/`signal`. Last updated Nov 9, 2026.
  https://developers.cloudflare.com/containers/guides/execute-commands/
- **[CF-GetStarted]** Run a Linux command — the wrangler config shape for the `durable_object` scheduling
  policy (`containers` + `durable_objects.bindings` + `exports { type: "durable-object", storage: "sqlite" }`)
  and the `cloudflare/debian-trixie` managed image (no local build). Oct 22, 2026.
  https://developers.cloudflare.com/sandbox/get-started/
- **[CF-Ref]** `@cloudflare/sandbox` reference — the helper classes require the `sandbox-shim` binary and
  `nodejs_compat`; **Path A does not use the npm package** (the DO drives `ctx.container` directly), so
  neither requirement applies here. Oct 22, 2026. https://developers.cloudflare.com/sandbox/reference/
- **[CF-ServiceTokens]** Cloudflare One — Service tokens: created explicitly (dashboard or
  `POST /accounts/{id}/access/service_tokens`, `Access: Service Tokens Write`), secret shown once,
  tag-based Service Auth policies; *not* auto-issued per user. Accessed Nov 16, 2026.
  https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/
- **[CF-AgentAuth]** Cloudflare One — Authenticate coding agents with service tokens. Accessed Nov 16, 2026.
  https://developers.cloudflare.com/cloudflare-one/access-controls/authenticate-agents/

### Nous Research / Hermes Agent documentation (fetched and read 2026-11-16)

- **[Hermes-Docs]** Hermes Agent documentation — *"6 built-in terminal backends (local, Docker, SSH, Daytona,
  Modal, Vercel Sandbox) plus plugin backends such as Singularity"*; `/docs/llms.txt` is the generated
  feature index. https://hermes-agent.nousresearch.com/docs/
- **[Hermes-TerminalPlugin]** Terminal Environment Provider Plugins — the contract Path A's plugin implements:
  `~/.hermes/plugins/<name>/` + `plugin.yaml` (`kind: backend`), `register(ctx)` →
  `ctx.register_terminal_environment_provider(provider)`; reserved built-in names; `create_environment`
  must accept `**kwargs`; `is_available()`/`probe()` network-free; secrets in `strip_env_keys`;
  `execute(command, timeout)` → `{"output", "exit_code"}` + `cleanup()`; subclass `BaseEnvironment` for the
  file-sync/background plumbing; `cleanup_stops_processes = False` when the backend only detaches and jobs
  stay reachable; `session_isolated_when_nonpersistent` for resumable sandboxes; `default_cwd: "~"`;
  in-process-only rule (refuses under `plugins.isolation: host`).
  https://hermes-agent.nousresearch.com/docs/developer-guide/terminal-environment-plugin
- **[Hermes-Plugins]** Plugins — discovery layout, `kind: backend` sub-categories, requires_env.
  https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins
- **[Hermes-BackendRef]** Hermes skill reference `references/terminal-backends.md` — the registration
  procedure and the why-a-backend-not-MCP rule (an MCP shell tool would split work between local and remote
  state; a backend routes `terminal`, `execute_code` *and* the file tools together).

### Verified against installed source (not just docs)

- Hermes Agent **v0.22.7+193** (commit `ed1afb0`): `agent/terminal_env_provider.py` (the provider ABC),
  `tools/environments/base.py` (`BaseEnvironment`; the `execute()` orchestration and the `_run_bash`
  primitive), `tools/environments/ssh.py` (the SSH backend's `_run_bash` returns a local `Popen` — the
  pattern this plugin copies via `tools.environments.base_output._popen_bash`), `hermes plugins validate`
  (structure + capability probe).
- agent-flare: `src/index.ts` (JWT middleware, `sandboxFor`), `src/sandbox.ts` (`hydrate`,
  `applyConfiguration`, bundle keys), `src/access.ts` (JWKS verify pattern), `src/env.ts`, `src/secrets.ts`
  (sealed prefill), `src/templates.ts` (`$NAME` → Worker secrets), `scripts/render-wrangler.mjs`,
  `scripts/templates.mjs`; skill references `references/per-user-services.md` and
  `references/state-flow.md`.

---

*Handoff prepared 2026-11-16. Implementation lives on the working tree (uncommitted, `main` mixed with
pre-existing WIP) — the route-A set is cleanly separable (`src/gateway.ts`, `Dockerfile`,
`scripts/render-wrangler.mjs`, `src/env.ts`, `src/index.ts`, `wrangler.example.jsonc`,
`container/plugins/cloudflare_sandbox/`, `ONBOARDING.md` rows/section) plus the `sandbox.ts` hunks, which
are interleaved with the pre-existing WIP in that file.*
