# Agent Flare: webapp and state overhaul

Branch: `return-0.12.14` (live). `webapp-and-state` holds the 1.0.3 work. Deployed from this machine 2026-11-05, and SDK 1.0.3 on 2026-11-06. Not pushed to GitHub: Chris hasn't asked for that yet.
Started 2026-11-04. Keep this file current; secrets, the account ID and the Access AUD never go in it.

## Current state: back on SDK 0.12.14 (live 2026-11-06)

Chris's direction: use 0.12.14 until Cloudflare's 1.0.3 docs catch up with the container management features this needs. Branch `return-0.12.14`, from `185264f`. The 1.0.3 work is intact on `webapp-and-state`. Local only, no GitHub.

**Live:** Worker version `620124a8`, commit `fe36c32`, `SLEEP_AFTER` 30m, class `AgentSandbox`, application `agent-flare-agentsandbox`, default scheduling, `max_instances` 10, image `agent-flare:f60285f` (no cache, guard clean, container suite 39 and 37). Not in production in Chris's sense: no need to ask for deploy times until he says so. Deploy Worker-only changes with `--containers-rollout=none`.

**Why a new class:** Cloudflare's guide says "You cannot undo the deploy that moves your class to `scheduling_policy: "durable_object"`" and "0.x code cannot start containers for the class, even after `wrangler rollback`". So `HermesSandbox` stays as an empty stub, keeping its namespace and data. Its application `agent-flare-hermes` remains, as does `agent-flare-hermessandbox` (0.x, 9765e5d), which waits on Chris.

**Idle design: 100% chip led (Chris).** The chip reports a tap, a keystroke, a page load, and an agent mid-turn (`busyBySession`), at most once a minute. Nothing else counts. A container gets its 30 minutes at start, kept in Durable Object storage. The SDK's alarm loop checks it, up to 3 minutes late (Chris accepted). After a stop, only a page load starts a new container. 12-hour backstop since the last real tap or key, even with an agent busy (Chris accepted). A closed tab stops about 30 minutes after the last report, ending the turn, unless Keep awake is on (Chris accepted).

**Measured on production, primus@, at `SLEEP_AFTER` 3m (each n=1 unless noted):**
- Untouched tab: counted down, stopped about 75s after zero with a final snapshot, turned red, stayed stopped 2 minutes until a click, then restarted with a countdown. Ran before the rollout finished, so its plugin isn't known; the Worker logic was new.
- Tap renews the time. Same plugin caveat.
- Stop: red, parked, instance inactive. On the old plugin.
- Busy agent, new plugin: a 6-minute turn held past the 3-minute timer, the time moving about a minute each minute. **Not seen: the countdown and stop after the turn ended.** Testing stopped on Chris's word.
- Deploy with `--containers-rollout=none`, mid-turn: container not stopped, turn kept running.
- Deploys without that flag started container rollouts. Two containers stopped during rollouts, with no snapshot, so changes since the last snapshot were lost (n=2). That rollouts caused it is inferred.

**Not tested:** a turn with the tab closed; the chip across a no-rollout deploy once the turn ends; a real 30-minute run; the live admin pages, including themes (primus@ isn't an admin, Chris has to check). The remaining tests are on the ops board.

**Admin:** the same-origin check is gone, because `Referrer-Policy: no-referrer` made every admin form send `Origin: null`. Admin pages now send `same-origin`. Chris's decision: Access protects this for now, and a WAF rule, documented in README and ONBOARDING, comes later (ops board). Theme picker: Ember by default, Lantern, or custom `#rrggbb` colours, per browser in a cookie.

**R2:** Chris allows deleting Agent Flare data when work needs it, without asking.

**Came forward:** admin container control, backup list and download, optional awake cap (`max_instances` is also a hard limit, 10), deploy guard, user guide, dark waiting screens. Chip actions are logged in the Worker.

**Data:**
- 1.0.3 `tar+zstd` backups can't be restored by 0.x. Each user's index and newest archive were copied to `hold/1x-2026-11-06/`; the live index holds only `squashfs` entries. The archives stay in `backups/`; nothing was deleted.
- `3d97ae43...` (Chris's newer account) has only 1.0 backups, so its next load starts empty. Its data is in hold. Converting it back would need a small extra step.
- primus@ restores from its 13:45 UTC 0.x backup.
- `e1491709...` (Chris's older account) is untouched, three `squashfs` backups, newest 2026-11-05 19:45 UTC, plus `hold/0x-2026-11-06/`.

**Support:** Sandbox SDK 0.x gets fixes until 2026-12-31, then keeps running with none.

**Earlier sections about 1.0.3 and its idle plan are history.** The root cause work there applies to 1.0.3, not to this.

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

## Idle fix plan (2026-11-06, for Chris's review; nothing deployed)

Chris's rule: Cloudflare doesn't run containers the way local Docker does. **No local result counts as evidence of idle behaviour or as proof of the fix.** Local tests only catch code regressions. Everything marked confirmed below came from production on primus@ or from Cloudflare's docs.

Two local commits, `a639de1` and `b405460`, hold part of this fix. They aren't deployed, and they're incomplete until the rest of section 4 is built.

### 1. Chris's requirements, and where each lands

| Requirement | Design | State today |
|---|---|---|
| Only real taps and keystrokes count as activity | The chip reports them, timestamps only, at most once a minute | Built; the timer is lost on reset (section 2) |
| Worker-seen writes are the fallback, in case the chip fails | A non-GET request through the Worker extends the time, at most once a minute | Built; same loss |
| Open-tab chatter doesn't count | Polls and socket frames never move the chip's idle time | Built; same loss |
| An unattended agent task stops at idle unless Keep awake is on (Chris accepted) | Work inside the container isn't counted | Built |
| Sleep after 30 minutes idle | The alarm stops it after a final snapshot | **Broken on production** |
| Snapshot before sleep | Every stop path snapshots first | Built; idle path never reached |
| Snapshots at the set interval, 10 minutes | The cron checks the time since the last snapshot | **Broken**: 5 or 15 minutes (section 2) |
| Keep awake: 1 or 2 hours, server-enforced, tap only, no stacking, no auto-renew | Worker accepts only 1 or 2; counts from now; kept in storage | Built; proven on production only partly |
| Lease ends with snapshot then stop; warning 10 minutes before | Alarm and cron | Built; to prove (P4) |
| Chip: dot plus countdown; green active, orange idle, red stopped | Plugin in the status bar | **Broken**: "Active" with no time (section 2a) |
| Chip always shows time to stop when one exists | Worker always gives the next stop time | **To build** |
| Stopped tab says `Stopped, tap to restart`; tap reloads | Plugin | Built; works on production |
| Only a page load starts a container; a tab's retries get 503 | Checked in the Worker | Built |
| 12-hour cap for a forgotten tab | Stored start time; alarm and cron | Built; to prove (P6 covers the path) |
| Optional awake cap, default 0 for none, set on the admin screen, running containers untouched | Checked only when starting | Built |
| Admin container control and backup download, audited | Admin page | Built |
| Dark waiting screens | Worker pages | Built locally, not deployed. Pale flash accepted by Chris |
| No Hermes patches | Plugin slot only | Kept |

### 2. Root cause

**Confirmed on production: the Durable Object loses its memory about 10 seconds after its last event, while the container keeps running.**

- Test on primus@, no tab open: set the chip's idle time, wait, read it back. 16 tries: still there after 3 and 6 seconds in every try, gone after 12 seconds or more in every try. At 9 seconds it went both ways.
- That matches Cloudflare's documented hibernation: "currently occurs after 10 seconds of inactivity", and hibernation "discards in-memory state".
- The idle timers lived only in memory, so a closed tab loses them within seconds.

**Confirmed: an alarm wakes it every 60 seconds, and each wake starts fresh.** Production logs show an alarm about every 60 seconds for each container. The constructor runs again (docs), and our constructor sets the fallback timer to "30 minutes from now". So the timer is reset every minute and never runs out.

**Confirmed result:** the primus@ tab was closed at about 15:17 UTC and the container was still up at 16:04, past its 30 minutes. It only stops at the 12-hour cap.

**Why snapshots are every 5 minutes.** Confirmed from logs: with no tab, both containers snapshot at every 5-minute cron tick. From the code: the last-snapshot time was in memory, so it reads as "never", and both skip checks pass. Inferred, because I can't read that value directly.

**Why every 15 minutes with a tab open, also wrong.** Confirmed from logs: primus@ at 14:45, 15:00, 15:15. From the code: the time is recorded when a snapshot finishes, a few seconds after the tick, so ten minutes later it's seconds short and waits for the next tick.

**Unconfirmed, and still open: a reset with a tab open.** At 14:42:30 UTC primus@'s memory reset while its tab was busy. No deploy happened; there was only one deployed version in that period. The docs list runtime updates and host moves as causes, but I have no evidence which it was. The fix doesn't depend on knowing, because the timers will survive any reset.

**What would have ruled this out:** the idle time surviving past 12 seconds with nothing else happening. It didn't.

**Why the suites missed it.** They run locally, which Chris's rule says isn't valid for this. Whatever the reason locally, they never saw this behaviour. I added a local reset test; it can only catch a regression in the code.

### 2a. "Active" with no countdown

**Requirement:** while a container is running, the chip always shows time until it stops.

**Root cause, confirmed in the code, reproduced on primus@:** the chip shows the Worker's `idleAt`, or the word "Active" if that's missing. `idleAt` is the in-memory value above. After any reset it's missing until the next tap or keystroke, and the chip reports at most once a minute. Also, the chip ignores the 12-hour stop time unless it's within the warning window, so it shows no time even though one exists.

**So it isn't only a closed tab.** Any reset does it: a phone suspending a backgrounded tab is the likely everyday case (inferred, not tested), and the 14:42 reset did it with a tab open.

**Chris's own session: unconfirmed.** I can't read it without his login. Logs show his container snapshotting every 5 minutes, which means it's resetting. Chris can check in one tap: open `https://agents.shipleybuilds.ai/__af/lease` in a new tab while the chip says "Active". It's read-only. If there's no `idleAt`, it's this cause.

**Fix, Worker-only:** keep the idle time in storage, and have the Worker always send `idleAt`: the chip's time, or if the chip hasn't reported, the earlier of the fallback timer and the 12-hour stop.

**If no stop time exists:** a running container always has one, because the 12-hour cap starts when it starts. If the Worker can't be reached, the chip keeps its last known time. The word "Active" stays in the plugin as dead code until the next image, since changing the plugin needs an image rebuild; then it becomes "–".

**Check:** P7 below.

### 3. Cloudflare docs relied on

- [Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/): hibernation at about 10 seconds; eviction at 70-140 seconds; memory discarded; constructor re-runs; code updates reset objects; WebSockets close. **Tested on production:** the 10-second memory loss. **Docs only:** what a deploy does.
- [Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/): one alarm per object, at-least-once, six retries with backoff, catch errors and set a new alarm. **Tested:** alarms fire about once a minute. **Docs only:** retries.
- [Durable Object Container API](https://developers.cloudflare.com/containers/api/durable-object-container/): `setInactivityTimeout` up to 6 hours; a restarted object has to set it again; without it the container stops soon after the object goes inactive. **Tested:** the container survives repeated resets. **Docs only:** the timeout firing.
- [Containers architecture](https://developers.cloudflare.com/containers/platform-details/architecture/): what stops a container (timeout, `signal`, `destroy`, rollout, process exit); SIGTERM, up to 15 minutes, then SIGKILL; disk is ephemeral. **Docs only.**
- [Rollouts](https://developers.cloudflare.com/containers/platform-details/rollouts/) and the [Sandbox migration guide](https://developers.cloudflare.com/sandbox/sdk/migrate/): Durable Object-managed instances aren't in rollouts; "a deploy does not restart running sandboxes". **Docs only; P8 tests it.**
- [Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) and [Containers pricing](https://developers.cloudflare.com/containers/pricing/): figures in section 4. **Docs only.**

### 4. The design: on hold, redesign requested

Chris rejected the 60-second alarm on 2026-11-06 and asked for the built-in timeout first, with Worker logic only as the fallback. The earlier design is withdrawn as the recommendation. Sections 5, 6 and 7 still describe it and get rewritten once Chris picks an option from "Idle: built-in timeout first", below.

### Idle: built-in timeout first

Marked **docs**, **production** or **code**. Nothing here has been tested on production unless it says so.

**1. Where the 30 minutes is.** `wrangler.prod.jsonc:41`, `"SLEEP_AFTER": "30m"`, in `vars`. It isn't in the `containers` block, and Wrangler's config schema has no idle setting there (code). `src/sandbox.ts:107` reads it. On 0.x it went straight to the SDK's `sleepAfter`. On 1.0.3 I set the built-in timeout to 45 minutes from it (`:122`, 30 + 15), a choice I made in the rewrite and didn't call out, and our own check handles the 30 (code).

**2. Is the built-in stop still there? Yes. Chris is right, and I overstated it.**
- Docs: "the instance keeps running for the time set with `setInactivityTimeout()`, up to 6 hours", and all processes get `SIGTERM`. ([Lifetime](https://developers.cloudflare.com/sandbox/concepts/lifetime/))
- Docs: no page says it was removed. The [migration guide](https://developers.cloudflare.com/sandbox/sdk/migrate/) lists `sleepAfter`, `onStop()`, `onActivityExpired()` as 0.x code under "Replace the Sandbox class", and the [1.0.0 changelog](https://github.com/cloudflare/sandbox-sdk/blob/main/packages/sandbox/CHANGELOG.md) says "ground-up rewrite". Neither says more about idle.
- Code: SDK 1.0.3 has none of `sleepAfter`, `onStop`, `onActivityExpired` in its source. The `Container` class has them, but docs say it "does not support applications that use the durable_object scheduling policy". ([Container class](https://developers.cloudflare.com/containers/container-class/))
- **Retracted:** "Version 1.0 has neither" was true only of those hooks in the SDK package. "The platform's timeout stops a container with no warning" was wrong: it sends `SIGTERM`. What's gone is a hook that runs Worker code before the stop.

**3. Can it be the main mechanism? What's missing is a guaranteed snapshot before the stop.**
- Docs: "Do not rely on a `SIGTERM` handler to finish work. Save the files you need before the instance stops" ([Lifetime](https://developers.cloudflare.com/sandbox/concepts/lifetime/)). The [architecture page](https://developers.cloudflare.com/containers/platform-details/architecture/) says it "Waits up to 15 minutes", but Lifetime says the instance stops "whether or not the processes exit". They don't agree, and I haven't tested it.
- Docs: "Cloudflare does not wake the Durable Object when its instance stops", and disk is ephemeral, so nothing can be saved afterwards.
- Docs: requests, streamed responses and WebSockets keep it active. So open-tab chatter counts, and the only way to the container is through the Durable Object, so it can't be hidden from the timer (code).

**4. What renews it.**
- Docs: another request before the timeout ends keeps it running, and "each alarm keeps the container running" ([Background processes](https://developers.cloudflare.com/sandbox/commands/run-background-processes/)).
- Docs: "Code that runs inside the instance does not count as activity."
- Inferred: our 5-minute cron, an RPC into the object, counts as a request. So with the cron and alarm, **the built-in timer can't fire today**. Production fits that: primus@ outlasted 45 minutes.

**For the record:** Cloudflare's own [Save a sandbox automatically](https://developers.cloudflare.com/sandbox/files/save-a-sandbox-automatically/) guide uses a 60-second alarm, an idle check, a snapshot, `destroy("idle")`, and the inactivity timeout "as a fallback". I didn't know that when I wrote it, and I'm reporting it, not arguing for it.

**Chris's working assumption (2026-11-06):** unless a doc explicitly says it was removed or changed, 0.x lifecycle items still apply. We ran 0.12.14; Chris said 0.12.7. Their `sleepAfter`, `keepAlive`, `onActivityExpired` and `onStop` declarations are identical (code).

What docs say explicitly:
- Migration guide: "replace the `Sandbox` class with a Durable Object class that you write". "You cannot undo the deploy that moves your class", and 0.x code then can't start containers for that class, even after rolling back.
- Container class page: "The Container class does not support applications that use the durable_object scheduling policy."
- So on our deployed class, `Sandbox` and `Container` hooks are out by those docs. On a **new** class with the default policy, nothing says they're gone: Container class is "available only with the default scheduling policy", and Existing applications "may use" it.

**Conflict for Chris, code finding, not a doc statement.** SDK 1.0.3's package exports only `DirectoryBackup`, `DirectoryBackupGateway`, `Files`, `S3Gateway`, `S3Mount` and three error types. `import { Sandbox, getSandbox } from "@cloudflare/sandbox"` fails on 1.0.3 with TS2305, no exported member. So the assumption can't be used through this package at 1.0.3.

Source finding: 0.12.14's `Sandbox` depends on `@cloudflare/containers`. Its `sleepAfter` runs in `Container.alarm()` (0.3.7, `dist/lib/container.js:1502`): a loop that wakes at least every 3 minutes, checks `isActivityExpired()`, calls `onActivityExpired()`, and re-arms. The docs say "The Container class uses the alarm handler to manage the container lifecycle". So the 0.x `sleepAfter` was itself a repeating alarm, not a platform timer.

**Options for that conflict:**
- D: move to a new class on the default policy using `Container` or 0.12.14: `sleepAfter` and `onActivityExpired` come back, with a snapshot in the hook. New class and application, and the DO's stored state doesn't carry over. Backups stay in R2, but `tar+zstd` restore would need the 1.0 code or a converter. Not tested on production with this design. It includes a repeating alarm inside it.
- A, B, C below, staying on 1.0.3.

**5. Options.** All drop the 60-second alarm. All have the cron stop waking containers: pruning works from R2 alone, and stale markers expire by age. All check an open tab's stored idle time on its own requests, since chatter would otherwise keep it up forever.

| | A: built-in only | B: one alarm at the stop time | C: built-in stops it, one alarm saves first |
|---|---|---|---|
| What stops it | Timeout at 30 min | Our alarm at 30, built-in at 45 as fallback | Alarm at 30 saves, then shortens the timeout so the built-in stops it |
| Snapshot before sleep | `SIGTERM` handler only, which docs warn against | Yes, unless the alarm fails | Yes, unless the alarm fails |
| Work at risk if that fails | Everything since the last snapshot | Same, only if the alarm fails | Same, only if the alarm fails |
| Built-in is primary, as Chris asked | Yes | No | Yes for the stop, no for the timing |
| Needs a new image | Yes, for the handler | No | No |
| Unknowns to test | Handler time; reaching the object during `SIGTERM` | Timeout holding across a 30-minute sleep (docs say it does) | Same as B, plus shortening the timeout |

**Requirements that can't be met by the built-in timeout alone:**
1. **Snapshot before sleep.** Option A can't guarantee it. Docs say not to rely on it. B and C need one alarm.
2. **Open-tab chatter doesn't count.** Docs say requests count. All options need a Worker check on the tab's requests.
3. **Snapshots every 10 minutes.** A wake renews the timer. All options snapshot on the tab's requests instead, so a closed tab takes no further ones. With keep-awake and a closed tab, an agent's work needs a timed wake, so A would have no snapshot until the end.

**Test first on Cloudflare?** A throwaway Worker with a small container, no user data, could answer the unknowns on the real platform before touching the live one: does the timeout fire across a long sleep; how long does `SIGTERM` get; do alarms and RPC renew it. It needs Chris's OK, since it creates a Worker and a container application, and costs pennies.

### 5. Failure modes

| Risk | Prevention | Left over |
|---|---|---|
| Sleeping on someone actively working | Taps and keys reset the timer; writes do too; the check is repeated after the snapshot | Someone only reading for 30 minutes stops; Chris accepted that. The orange dot and countdown show it coming |
| Chip's report fails while typing | Sending a message is a Worker-seen write, which extends it | Typing one message for 30 minutes with reports failing. Rare; the draft could be lost |
| Stored time goes wrong | It's only ever set from now plus 30 minutes; the 12-hour cap applies regardless | None known |
| Stopping too early after a reset | The fallback time can be at most a minute stale, and only when no requests are arriving | A stop up to a minute early with no one there |
| Losing data at sleep | Snapshot first, with the existing safety checks; a failed one retries | **Decision for Chris, below** |
| Fix fails on production | Alarm and cap remain; rollback in section 7 | Back to today's behaviour |
| Snapshot of a half-started container | Refused if the home isn't marked ready | None known |

**Decision for Chris.** After three failed snapshots at idle, today's code stops anyway, losing up to one interval of work. The other choice: stay up and keep retrying until the 12-hour cap, which costs a little more but loses nothing unless the container dies. I recommend staying up, and logging it.

### 6. Proof, on production and primus@ only

**The limit:** there's no way to prove this before deploying. Local doesn't count. So **the fix has to be deployed before we know it works**, and the test window is the deploy itself. Each test takes real time, about 30 minutes for most.

**Option:** a separate staging Worker on Cloudflare would prove it first without touching the live one. It needs a new hostname, an Access app (Chris's), its own bucket and KV, and more time. **I recommend deploying directly**, since rollback is one command, the risk is limited to today's behaviour, and hibernation happens by itself here, so no forcing is needed. It's Chris's call.

Forcing a reset: no tool for it on production. It happens by itself within about 10 seconds of quiet, which covers P1, P5 and P7.

Measurements read `/__af/lease`, R2 and logs. Times use a 30-minute idle setting.

| # | Test | Pass | Fail |
|---|---|---|---|
| P1 | Closed tab | Stopped within 32 minutes of the last action, with a snapshot, and stays stopped | Up past 35 minutes |
| P2 | Open tab, untouched | Stopped within 32 minutes of the last tap; no restart from tab retries | Up past 35, or restarts |
| P3 | Active tab: a real tap or key at least every 10 minutes for 45 minutes | Up the whole time, countdown back near 30m | Stops, or the countdown doesn't reset |
| P4 | Keep awake 1 hour, tab closed | Up past 30 minutes; stops within 2 minutes of its end, after a snapshot; 8 hours refused | Stops early, runs on |
| P5 | Reset: 15 quiet seconds, repeated | `idleAt` the same before and after, every time | Missing or moved |
| P6 | Snapshots at the interval | With a tab and activity, gaps of 10 minutes, or the next 5-minute tick; none after the last activity | 5 or 15 minute gaps, or endless |
| P7 | Chip | On every reading while running, a time is shown: after load, after a quiet reset, in lease, near cap. Never the word "Active" | "Active" appears |
| P8 | Deploy mid-timer: a no-change redeploy at about 10 minutes into the timer, tab open | Container not restarted (no new restore, home intact), tab reconnects, same idle time | Restart, or timer moved |
| P9 | Existing containers after the deploy | `3d97ae43…` isn't touched, but it should sleep within about 35 minutes if unused | Still up past that |

Also: P2 needs a real browser window, and P3 needs real input events. Also confirm the dark screens on production; the screenshots so far were local.

P8 drops open sockets for anyone connected, so it needs a moment when no one's mid-chat. P9 reads only markers.

**Not provable quickly:** the 12-hour cap (would take 12 hours; I could run it overnight), and the 45-minute platform backstop (would need alarms to fail).

### 7. Deploy and rollback

**Deploy:** Worker only, same image. Check-deploy guard, then `wrangler deploy` of the production config. Also removes `SANDBOX_TRANSPORT`. Containers aren't restarted (docs; P8 tests it). Open sockets drop and reconnect, so it needs a quiet moment, confirmed by Chris.

**Rollback target:** Worker version `7989ab18`, same image, one `wrangler rollback`. It restores today's code and its bug: containers that idle only at the cap, 5-minute snapshots, "Active", light waiting screens, and `SANDBOX_TRANSPORT`. Stored data, backups and containers are untouched, and the new `idle` record is simply ignored. Rollback restarts Durable Objects, so sockets drop once more.

**Not a rollback target:** `4d5cc11e`, the 0.x version. The 1.0.3 move can't be undone.

**Stop and roll back if:** any container restarts on deploy; P1, P2 or P5 fail with no quick correction; or anyone is stopped while actively working.

### 8. Decisions needed from Chris

1. The plan: go or changes.
2. Deploy directly, or staging first. I recommend directly.
3. After three failed idle snapshots: keep trying until the cap, or stop. I recommend keep trying.
4. When to deploy, given sockets drop.

## SDK 1.0.3 (deployed 2026-11-06)

Chris chose to move now. It's a rewrite, per Cloudflare's guide at /sandbox/sdk/migrate/: our own Durable Object around `ctx.container`, Ubuntu 22.04 pinned by digest, `sandbox-shim` copied from the matching image, `tar+zstd` backups through `DirectoryBackup`, and our own idle alarm. **The deploy can't be undone:** it moves to `scheduling_policy: "durable_object"` under a new container application name.

- Backups from 0.x restore directly with `unsquashfs`, and later snapshots are in the new format. Retention removes both kinds.
- **Live:** Worker version `7989ab18`, image `agent-flare:0fbf62f`, `sha256:91d7a990...`. Newest 0.x backups of each user are copied under `hold/0x-2026-11-06/`, verified. Container application `agent-flare-hermes`. The old application `agent-flare-hermessandbox` waits on Chris's answer about deleting it. Remove the leftover `SANDBOX_TRANSPORT` at the next deploy.
- **Proven on production with primus@, no user data:** old-format restore (325 files, 708 ms), a real `tar+zstd` snapshot through the gateway, stop, and a restart that fetched it through the gateway. Old: 2.53 MB in R2, 9.74 MB unpacked, 326 files. New: 2.07 MB, 9.77 MB, 328 files. Largest in both: `models_dev_cache.json` 5.8 MB, `skills` 3.6 MB, `state.db` 0.5 MB. Timed on production: Stop with its snapshot 2.6 s, the upload 0.23 s; restart to serving about 14 s, the backup fetch 0.2 s; old-format restore 708 ms.
- `wrangler tail` often doesn't show this Durable Object's logs when it's restoring or snapshotting, so timings come from event timestamps. A restore's outcome is on the admin user page.
- At the next deploy: remove `SANDBOX_TRANSPORT`. An image must be pinned by digest, or `wrangler deploy` refuses the config.
- **Local suites use a stand-in** for the backup transfer (`src/test-backups.ts`), because this host's firewall blocks a container from the Docker bridge, which local `wrangler dev` needs. They don't prove the real path; the production run above does. The Worker refuses to serve with a test setting away from localhost, and `scripts/check-deploy.mjs` blocks deploying one.
- Chris chose to prove real backups right after the deploy, not to open the firewall. A real production 0.x backup unpacked and verified on the new image in an offline container: 2.62 MB (lz4), 9.95 MB, 330 files, 0.03s.
- Results at `0fbf62f`, no-cache image `agent-flare:0fbf62f`: guard clean, container suite 39 unit and 37 integration, Worker 63, tsc clean, end-to-end 189 **using the stand-in**. A real Worker with `TEST_BACKUPS` on a non-local host answered 500 and logged the refusal.
- To do at deploy: nobody active, hold a copy of the newest 0.x backup under `hold/`, then right after: real snapshot, stop, restore, old-format restore, sizes and timings of each format. If backups fail, stop and tell the coordinator.
- SSH debug access is gone, because `containers[].ssh` isn't supported with this policy.

Backup downloads, Chris's decision 2026-11-05: option (a). Admins are super admins, trusted with sensitive data. A backup can hold plaintext credentials in chats, memories, `config.yaml` and `workspace/`, so each download is audited, and the screen says so in one line.

## Container control (built, not deployed)

Chip in `statusBar.right` through Hermes's desktop plugin feature, with no patch or injection; see README. Chris ruled out new plugin code earlier for tier marks, then chose this for container control. **The 12-hour cap is a default Chris hasn't confirmed** (`FORGOTTEN_TAB_CAP_HOURS`).

Measured 2026-11-05 on SDK 0.12.14, before the move to 1.0, with a real tab and a 2-minute idle time: an open tab stayed up over 6 minutes. The tab's own frames and polling renewed the SDK's timer every few seconds. On 1.0 our alarm owns the timer, but a tab's requests would still look like use. A backgrounded phone tab probably goes idle because the phone suspends it.

So activity is now a tap or keystroke the chip reports, and the cap is only the backstop for when the chip isn't reporting. The tab's retries can't wake a stopped container: they did within about 20 seconds before this.

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
- Without the status chip reporting, an open browser tab keeps a container running until the cap, and so costs money.
- A sleeping container runs no Hermes cron jobs or messaging gateways.
- SDK 1.0 has no `max_instances`. Chris chose an optional limit on the admin screen instead, default 0 for none. It's enforced only when starting a container.
- Cloudflare's own Container Snapshots aren't a replacement for R2: tied to one image version, 30-day expiry.
- The whole shared gateway credential is in each user's `.env`, so each user's agent can read it. Keep its scope narrow.
