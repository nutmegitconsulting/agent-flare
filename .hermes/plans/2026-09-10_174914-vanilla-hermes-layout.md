# Plan: Remove the /opt split — vanilla Hermes layout in the Sandbox image

Status: proposed (plan mode)
Author: for an implementer with zero codebase context. Every path, command, and
expected output is stated explicitly. Do not improvise.

## Goal

Replace hermes-flare's split-folder deployment (install in `/opt/hermes-install` +
uv in `/opt/uv`, tiny home) with a vanilla Hermes install (root FHS layout), while
keeping the Cloudflare Sandbox SDK `createBackup()`/`restoreBackup()` squashfs
persistence as the one proven mechanism — now pointing at
`/home/hermes/.hermes`.

## Current context / assumptions

Repo: `~/projects/hermes-cloudflare-v6` (worker `hermes-cloudflare-v6`,
custom domain `hermes-agent.hermes-test.app`, R2 bucket `hermes-agent-state`,
SDK `@cloudflare/sandbox` 0.12.7, base image
`docker.io/cloudflare/sandbox:0.12.7-python`).

Current split (what we are removing):
- `Dockerfile` installs as the `hermes` user with
  `--hermes-home /opt/hermes-install`, forcing everything (code, venv, node, uv)
  under `/opt/hermes-install`, uv CPython under `/opt/uv`, and leaving only a tiny
  `hermes` wrapper in `/home/hermes/.local/bin/hermes`. `HERMES_HOME` at runtime
  is `/home/hermes/.hermes` and ships EMPTY.
- `src/persistence.ts`: `BACKUP_DIR = "/home/hermes"` (whole home), corruption
  sentinel `SENTINEL_FILE = "/home/hermes/.local/bin/hermes"`.
- `start-hermes.sh`: `PATH` references `/home/hermes/.local/bin` and
  `/opt/hermes-install/node/bin`.
- `scripts/build-and-push.sh` / `.ps1`: image verification runs
  `su hermes -c "HERMES_HOME=/home/hermes/.hermes /home/hermes/.local/bin/hermes --version"`.
- `src/providers.ts` already targets `/home/hermes/.hermes/config.yaml` and
  `/home/hermes/.hermes/.env` — NO change needed there.
- `wrangler.jsonc` — NO change needed (container/DO/R2 config unaffected).

Vanilla layout facts, verified against the live `install.sh`
(https://hermes-agent.nousresearch.com/install.sh, 2026-09-10) and the installed
SDK source (`node_modules/@cloudflare/sandbox/dist/sandbox-D0rNqxlr.js`):

1. Run as **root** on Linux with no `--hermes-home` override, install.sh picks the
   **root FHS layout**: code `/usr/local/lib/hermes-agent/`, venv
   `/usr/local/lib/hermes-agent/venv/`, command wrapper `/usr/local/bin/hermes`
   (self-contained bash shim that execs the venv python + entrypoint — no env
   tricks needed at runtime), uv-managed CPython defaults
   `/usr/local/share/uv/{python,bin}` (world-readable by design so the wrapper
   works for any user).
2. Managed `uv` is ALWAYS installed to `$HERMES_HOME/bin/uv` (unconditional in
   `main()`, not gated by `--skip-setup`). Managed Node (if the base image's node
   is too old) lands in `$HERMES_HOME/node/` — both INSIDE the snapshot tree,
   which is fine and desirable (a restore re-materializes them; a fresh user gets
   them baked in the image).
3. `copy_config_templates()` seeds `$HERMES_HOME/` at build time with: `.env`
   (template), `config.yaml` (template), `SOUL.md`, empty data dirs
   (`cron sessions logs pairing hooks image_cache audio_cache memories skills`),
   and bundled skills into `$HERMES_HOME/skills/` including
   `$HERMES_HOME/skills/.bundled_manifest`. This build-time state MUST be wiped
   (keep `skills/`, `bin/`, `node/`) — otherwise a failed restore looks like a
   healthy boot (Pitfall 12, see skill `cloudflare-sandbox-ai-agents`).
4. SDK `doRestoreBackupLocal` (localBucket path) restores with
   `unsquashfs -f -d <dir>` — **force overwrite onto the existing directory, no
   wipe**. Restoring onto the baked install is safe: the backup only contains
   `$HERMES_HOME` contents; the code in `/usr/local` is never touched.
5. SDK `CreateBackupOptions = { dir: string; name?; ttl?; localBucket? }` — only
   the `dir` constant changes on the Worker side; `name` is optional.
6. Backup handles store their own `dir`. Old per-user handles in R2 say
   `dir: "/home/hermes"`; new snapshots will say `dir: "/home/hermes/.hermes"`.
   Old handles stay restorable as-is: the old backup's tree puts user data at
   `/home/hermes/.hermes`, the exact same absolute path the new runtime reads.
   NO data migration is required. After one stop/wake cycle the handle rolls over
   to the new dir automatically.
7. The absolute sentinel path `/home/hermes/.hermes/skills/.bundled_manifest`
   exists in BOTH old and new user data (old runtime also synced bundled skills
   into `.hermes/skills/` on first boot), so it works for old handles, new
   snapshots, and fresh image boots alike.

## Architecture / proposed approach

The image performs a stock root FHS Hermes install; `/home/hermes/.hermes`
(HERMES_HOME) holds all mutable state plus the baked runtime binaries
(`bin/uv`, `node/`, `skills/`) and nothing else. The Worker keeps using the
SDK backup API unchanged except `BACKUP_DIR` shrinks from `/home/hermes` to
`/home/hermes/.hermes` (smaller, faster, exactly what the user asked for) and
the corruption sentinel moves to the bundled-skills manifest inside the tree.
Everything else (restore gate, cron registry, provider injection, stop/destroy
final snapshots, R2 layout) is untouched.

## Step-by-step tasks

### Task 1 — Rewrite the Dockerfile to a vanilla root FHS install

File: `~/projects/hermes-cloudflare-v6/Dockerfile` (replace the ENTIRE file).

Rationale in comments: root install → FHS layout (`/usr/local/...`), data in
`$HERMES_HOME=/home/hermes/.hermes`, build-time state wiped (Pitfall 12), runtime
binaries (`bin/uv`, `node/`, `skills/`) intentionally kept inside the snapshot
tree.

Copy-paste this complete file:

```dockerfile
# =============================================================================
# Hermes Agent on Cloudflare Sandbox — VANILLA layout
# =============================================================================
# Base: cloudflare/sandbox:0.12.7-python (must match @cloudflare/sandbox version).
#
# LAYOUT (vanilla root FHS install — no /opt split):
#   /usr/local/lib/hermes-agent        code + venv (baked, outside snapshot)
#   /usr/local/bin/hermes              self-contained launcher shim (outside)
#   /usr/local/share/uv/{python,bin}   uv-managed CPython (world-readable)
#   /home/hermes/.hermes               ALL mutable state (HERMES_HOME) = snapshot
#                                       + baked runtime bits: bin/uv, node/, skills/
#
# The SDK snapshots dir=/home/hermes/.hermes via createBackup (mksquashfs in
# container, uploaded through the bound BACKUP_BUCKET R2). Restores are
# `unsquashfs -f -d /home/hermes/.hermes` — force-overwrite ONTO the baked
# install, so the /usr/local code is never disturbed.
#
# The container ends as root so the Sandbox SDK can run mksquashfs.
# =============================================================================

FROM docker.io/cloudflare/sandbox:0.12.7-python

USER root

# --- System tools ---
# build-essential: required by install.sh's node-pty native build.
# squashfs-tools: createBackup/restoreBackup run mksquashfs/unsquashfs in-container.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
         curl ca-certificates git squashfs-tools build-essential openssh-server \
    && rm -rf /var/lib/apt/lists/*

# --- SSH setup for Cloudflare Containers debug access ---
RUN mkdir -p /run/sshd \
    && echo 'root:*:19694:0:99999:7:::' > /etc/shadow \
    && sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin yes/' /etc/ssh/sshd_config \
    && sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config \
    && sed -i 's/#PubkeyAuthentication yes/PubkeyAuthentication yes/' /etc/ssh/sshd_config \
    && ssh-keygen -A

# --- cloudflared (tunnel for Desktop App access) ---
RUN curl -sfL --output /usr/local/bin/cloudflared \
        https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
    && chmod +x /usr/local/bin/cloudflared

# --- hermes user (owns the runtime data dir; install runs as root below) ---
RUN useradd --create-home --shell /bin/bash --uid 1000 hermes

# HERMES_HOME: the ONE snapshot tree. Everything mutable lives here.
ENV HERMES_HOME=/home/hermes/.hermes
ENV UV_NO_CONFIG=1
ENV PATH=/usr/local/bin:$PATH

# --- Vanilla install as ROOT -> FHS layout (code/venv/shim under /usr/local) ---
# uv-managed CPython lands world-readable at /usr/local/share/uv (install.sh does
# this automatically for root Linux FHS installs). Managed uv binary and the
# managed Node bundle (if needed) land inside $HERMES_HOME (bin/uv, node/) —
# inside the snapshot tree on purpose: a restore re-materializes them, and a
# fresh user gets them baked in.
RUN curl -fsSL https://hermes-agent.nousresearch.com/install.sh \
      | bash -s -- --skip-setup --non-interactive \
    && test -x /usr/local/bin/hermes \
    && test -x /usr/local/lib/hermes-agent/venv/bin/python \
    && ls -la /usr/local/lib/hermes-agent \
    && chown -R hermes:hermes /home/hermes

# --- Wipe build-time user state (Pitfall 12) ---------------------------------
# install.sh's copy_config_templates seeded $HERMES_HOME at build time with
# template config.yaml / .env / SOUL.md, install_id, bundled skills, empty data
# dirs, etc. Ship the home WITHOUT that state so (a) a failed restore shows an
# obviously-empty home instead of fake-healthy build state, and (b) the snapshot
# stays small. KEEP the baked runtime bits that live inside the tree:
#   bin/  (managed uv binary), node/ (managed Node), skills/ (bundled skills).
RUN rm -rf /home/hermes/.hermes/config.yaml \
         /home/hermes/.hermes/.env \
         /home/hermes/.hermes/SOUL.md \
         /home/hermes/.hermes/install_id \
         /home/hermes/.hermes/state.db \
         /home/hermes/.hermes/state.db-wal \
         /home/hermes/.hermes/state.db-shm \
         /home/hermes/.hermes/.startup-status \
    && find /home/hermes/.hermes -mindepth 1 -maxdepth 1 \
         ! -name bin ! -name node ! -name skills -exec rm -rf {} + \
    && chown -R hermes:hermes /home/hermes \
    && chmod -R a+rX /home/hermes/.hermes

# --- Startup ---
COPY --chown=root:root start-hermes.sh /usr/local/bin/start-hermes.sh
RUN chmod +x /usr/local/bin/start-hermes.sh

# sandbox binary is ENTRYPOINT; CMD is spawned as its child.
USER root
CMD ["/usr/local/bin/start-hermes.sh"]
```

Note on the wipe `find`: it removes every top-level entry in `.hermes/` EXCEPT
`bin`, `node`, `skills`. If a future install.sh adds a new top-level baked
runtime dir you must keep, add it to the `! -name` exclusions. The explicit
`rm -rf` list above is belt-and-suspenders for the common files.

Verification (no Docker push yet — build locally and inspect):
```bash
cd ~/projects/hermes-cloudflare-v6
docker build --no-cache -f Dockerfile -t hermes-vanilla-check .
```
Expected: build succeeds (no `test -x` failure). Then inspect the layout:
```bash
docker run --rm --entrypoint /bin/bash hermes-vanilla-check -c \
  'ls -la /usr/local/lib/hermes-agent && echo "---HOME---" && ls -la /home/hermes/.hermes && echo "---WRAPPER---" && head -5 /usr/local/bin/hermes'
```
Expected:
- `/usr/local/lib/hermes-agent` contains `venv/`, `hermes` (entrypoint), repo files.
- `/home/hermes/.hermes` contains `bin/`, `node/`, `skills/` (and the empty data
  dirs are gone) — NO `config.yaml`, NO `.env`, NO `SOUL.md`.
- `/usr/local/bin/hermes` head shows the `#!/usr/bin/env bash` shim exec'ing
  `/usr/local/lib/hermes-agent/venv/bin/python`.

Also confirm the launcher runs as the hermes user with the right HERMES_HOME:
```bash
docker run --rm --entrypoint /bin/bash hermes-vanilla-check -c \
  'su hermes -c "HERMES_HOME=/home/hermes/.hermes /usr/local/bin/hermes --version"'
```
Expected: a Hermes version line (not `command not found`).

Commit:
```bash
git add Dockerfile
git commit -m "docker: vanilla root FHS install; snapshot tree is /home/hermes/.hermes"
```

### Task 2 — Update `start-hermes.sh` PATH (remove /opt references)

File: `~/projects/hermes-cloudflare-v6/start-hermes.sh`

Only one line changes. Everything else (restore gate, bootstrap loader, sshd,
cloudflared, dashboard-token watcher, SIGTERM trap, `exec hermes serve`) stays
byte-for-byte identical. The `HERMES_HOME` export (line 29) is already
`/home/hermes/.hermes` — no change.

Replace line 30:

OLD:
```bash
export PATH="/home/hermes/.local/bin:/opt/hermes-install/node/bin:/usr/local/bin:$PATH"
```
NEW:
```bash
export PATH="/usr/local/bin:/home/hermes/.hermes/node/bin:$PATH"
```
Why: the vanilla launcher is `/usr/local/bin/hermes` (a self-contained shim that
execs `/usr/local/lib/hermes-agent/venv/bin/python`); the managed Node, if the
base image's Node is too old, is now `$HERMES_HOME/node/bin`. `/home/hermes/.local/bin`
is gone (the wrapper moved to `/usr/local/bin`).

Verification:
```bash
cd ~/projects/hermes-cloudflare-v6
grep -n 'hermes-install\|/opt/uv\|\.local/bin' start-hermes.sh
```
Expected output: NOTHING (no matches).
```bash
bash -n start-hermes.sh && echo SYNTAX_OK
```
Expected: `SYNTAX_OK`.

Commit:
```bash
git add start-hermes.sh
git commit -m "boot: drop /opt split from PATH; launcher is /usr/local/bin/hermes"
```

### Task 3 — Point the Worker persistence at `/home/hermes/.hermes`

File: `~/projects/hermes-cloudflare-v6/src/persistence.ts`

3a. Line 27 — the snapshot dir:
OLD:
```ts
const BACKUP_DIR = "/home/hermes";
```
NEW:
```ts
const BACKUP_DIR = "/home/hermes/.hermes";
```

3b. Lines 32–42 — the corruption sentinel. The old sentinel
(`/home/hermes/.local/bin/hermes`) no longer exists in a vanilla install. Replace
the `SENTINEL_FILE` constant AND its comment block. The new sentinel is the
bundled-skills manifest: baked into the image inside the tree (install.sh's
`copy_config_templates` runs `skills_sync.py` at build time), carried by every
backup (old `/home/hermes`-backed ones too, because the old runtime synced
bundled skills into the same absolute path `.hermes/skills/`), and a truncated
restore archive leaves it missing or 0-byte.

OLD (the comment block + constant, lines 32–42):
```ts
/**
 * Corruption sentinel: a healthy /home/hermes always has a non-empty hermes
 * launcher wrapper at /home/hermes/.local/bin/hermes (baked into the image,
 * pointing at /opt/hermes-install/venv). It is inside the snapshot tree, so
 * every backup carries it; a partial unsquashfs extraction — seen when a
 * restore's archive transfer is truncated — leaves it as a 0-byte regular
 * file. Checked before every snapshot (never archive a corrupt tree: that
 * turns one bad restore into a permanently bad newest-backup) and after every
 * restore (fail loudly).
 */
const SENTINEL_FILE = "/home/hermes/.local/bin/hermes";
```
NEW:
```ts
/**
 * Corruption sentinel: a healthy snapshot tree always has a non-empty bundled
 * skills manifest at /home/hermes/.hermes/skills/.bundled_manifest (baked into
 * the image by install.sh's skills_sync.py). It is inside the snapshot tree, so
 * every backup carries it (old /home/hermes-backed ones too, because the old
 * runtime synced bundled skills into the same absolute path); a partial
 * unsquashfs extraction — seen when a restore's archive transfer is truncated —
 * leaves it missing or 0-byte. Checked before every snapshot (never archive a
 * corrupt tree: that turns one bad restore into a permanently bad
 * newest-backup) and after every restore (fail loudly).
 */
const SENTINEL_FILE = "/home/hermes/.hermes/skills/.bundled_manifest";
```

No other change: `assertTreeHealthy` uses `test -s ${SENTINEL_FILE}` (a
non-empty-file check — correct for the manifest), `restoreLatest`'s
`umount ${BACKUP_DIR}` is a no-op on the localBucket path (keep it), and
`createSnapshot`'s `chmod -R a+rX ${BACKUP_DIR}` just targets the smaller dir
now. `src/providers.ts` already hardcodes `/home/hermes/.hermes/config.yaml` and
`/home/hermes/.hermes/.env` — NO change there.

Verification:
```bash
cd ~/projects/hermes-cloudflare-v6
grep -n 'hermes-install\|/opt/uv\|/home/hermes/.local/bin' src/persistence.ts
```
Expected: NOTHING.
```bash
npx tsc --noEmit -p tsconfig.json && echo TYPECHECK_OK
```
Expected: `TYPECHECK_OK` (no errors).

Commit:
```bash
git add src/persistence.ts
git commit -m "persistence: snapshot /home/hermes/.hermes; sentinel = skills/.bundled_manifest"
```

### Task 4 — Fix the image-verification commands in the build scripts

Files: `scripts/build-and-push.sh` and `scripts/build-and-push.ps1`

Both run a version probe against the old wrapper path. They must probe the
vanilla launcher instead. The `su hermes -c "..."` wrapper stays (it proves the
shim works as a non-root user against a world-readable venv).

4a. `scripts/build-and-push.sh`, the `VERSION_OUT` assignment (lines 34–35):
OLD (the inner single-quoted command):
```bash
  'su hermes -c "HERMES_HOME=/home/hermes/.hermes /home/hermes/.local/bin/hermes --version" 2>&1')""
```
NEW:
```bash
  'su hermes -c "HERMES_HOME=/home/hermes/.hermes /usr/local/bin/hermes --version" 2>&1')"
```
Only the path inside the quotes changes (`.local/bin` → `/usr/local/bin`).

4b. `scripts/build-and-push.ps1`, same single-line substitution inside its
`$VERSION_OUT` block:
OLD:
```powershell
'su hermes -c "HERMES_HOME=/home/hermes/.hermes /home/hermes/.local/bin/hermes --version" 2>&1'
```
NEW:
```powershell
'su hermes -c "HERMES_HOME=/home/hermes/.hermes /usr/local/bin/hermes --version" 2>&1'
```

Verification:
```bash
cd ~/projects/hermes-cloudflare-v6
grep -rn '/home/hermes/.local/bin/hermes' scripts/
```
Expected: NOTHING.
```bash
bash -n scripts/build-and-push.sh && echo SYNTAX_OK
```
Expected: `SYNTAX_OK`. (The .ps1 can't be syntax-checked from WSL2; the change
is a single string literal — visual diff check.)

Commit:
```bash
git add scripts/build-and-push.sh scripts/build-and-push.ps1
git commit -m "build: probe vanilla launcher /usr/local/bin/hermes"
```

### Task 5 — Doc sync (README + ONBOARDING, both copies)

The split is documented in a few places that would otherwise mislead future
operators. Update each; do not rewrite the docs wholesale.

5a. `README.md` — three edits:
- Line 19: replace "State lives in the container at `/home/hermes` (runtime data
  only — the install lives at `/opt/hermes-install`, outside the snapshot
  tree)" with "State lives in the container at `/home/hermes/.hermes`
  (HERMES_HOME — runtime data plus the baked runtime bits; the install is a
  vanilla root FHS layout under `/usr/local`, outside the snapshot tree)".
- Line 44: replace the whole "Install (code, venv, Node bundle, uv CPython)
  lands in `/opt/hermes-install`; `/home/hermes/.hermes` ships empty and only
  the tiny `hermes` wrapper lives in the snapshot tree" bullet with "Vanilla
  root FHS install: code + venv at `/usr/local/lib/hermes-agent`, launcher at
  `/usr/local/bin/hermes`, uv CPython at `/usr/local/share/uv`.
  `/home/hermes/.hermes` ships without build-time user state (config.yaml/.env/
  SOUL.md are wiped at build time); it carries only the baked runtime bits
  (`bin/uv`, `node/`, `skills/`) plus whatever the user's restore brings back".
- Line 87: replace "The separation of install path (`/opt/hermes-install`) from
  mutable state (`/home/hermes`)" with "The vanilla FHS install
  (`/usr/local`) kept outside the snapshot tree
  (`/home/hermes/.hermes`)".

5b. `plans/README.md` — it is a copy of README; apply the same three edits.

5c. `ONBOARDING.md` and `plans/ONBOARDING.md`:
```bash
grep -n 'hermes-install\|/opt/uv' ONBOARDING.md plans/ONBOARDING.md
```
If any hits, apply the same wording as 5a. If no hits (expected), no edit.

Verification:
```bash
grep -rn 'hermes-install\|/opt/uv' README.md ONBOARDING.md plans/README.md plans/ONBOARDING.md
```
Expected: NOTHING.

Commit:
```bash
git add README.md ONBOARDING.md plans/README.md plans/ONBOARDING.md
git commit -m "docs: describe vanilla FHS layout, remove /opt split references"
```

### Task 6 — Build, push, deploy

Docker Desktop must be running on the Windows host (ask the user if the daemon
is down — do NOT attempt WSL2 Docker workarounds). From WSL2 the plain
`docker` command works (native integration).

```bash
cd ~/projects/hermes-cloudflare-v6
bash scripts/build-and-push.sh --deploy
```
What happens, in order:
1. `docker build --no-cache` — fresh install layer (the `--no-cache` is
   mandatory: a cached install layer ships the OLD agent).
2. The version probe runs `/usr/local/bin/hermes --version` as the hermes user
   and greps for "Up to date". If it fails, the script REFUSES to push —
   investigate the build log before re-running.
3. `npx wrangler containers push` (retries up to 3x on chunked-upload failure).
4. `npx wrangler deploy` activates the new image digest.

Expected: ends with "==> Deploy complete." and the image size printed. Image
size should be roughly the same as before (the code + venv + browser deps were
already baked into the image under `/opt`; only the location moved to
`/usr/local`). The SNAPSHOT, however, shrinks dramatically (see V3).

Commit (if `--deploy` surfaced anything needing a fix, fix + re-run first;
otherwise no new commit — the code commits from Tasks 1–5 already cover this):
```bash
git status   # expect clean
```

## Tests / validation

There is no unit-test harness in this repo (the Worker is a thin Hono router;
the persistence logic is exercised only against a live container + R2).
Validation is therefore a staged end-to-end round-trip, run AFTER Task 6:

### V1 — Fresh user cold boot (no prior backup)
```bash
# pick a userId that has no R2 backup yet, e.g. from the Zero Trust WARP client
cloudflared access curl "https://hermes-agent.hermes-test.app/api/client-init" -s -X POST
cloudflared access curl "https://hermes-agent.hermes-test.app/api/wake" -s -X POST
```
Expected `/api/wake` JSON: `"restored": false` (fresh), no `restoreError`.
Then poll startup status:
```bash
cloudflared access curl "https://hermes-agent.hermes-test.app/api/debug/exec?userId=<you>&cmd=cat%20/home/hermes/.hermes/.startup-status" -s
```
Expected: a status string ending at `hermes serve` startup (NOT stuck on
"Waiting for restore marker" for >2 min).
Confirm the agent actually works end-to-end: open the Desktop App / tunnel
(`hermes-<you>.hermes-test.app`) and confirm the agent answers.
Confirm the layout live:
```bash
cloudflared access curl "https://hermes-agent.hermes-test.app/api/debug/exec?userId=<you>&cmd=ls%20-la%20/home/hermes/.hermes%20%26%26%20which%20hermes" -s
```
Expected: `.hermes` has `config.yaml` (written by serve startup), `bin/`,
`node/`, `skills/`, sessions dir, etc.; `which hermes` → `/usr/local/bin/hermes`.

### V2 — Snapshot round-trip (the money test)
Create a marker, snapshot it, stop, wake, verify the marker survived.
```bash
# 1. plant a marker in the live tree
cloudflared access curl "https://hermes-agent.hermes-test.app/api/debug/exec?userId=<you>&cmd=echo%20vanilla-roundtrip-$(date +%s)%20>%20/home/hermes/.hermes/roundtrip.txt" -s
# 2. force a snapshot of /home/hermes/.hermes to R2
cloudflared access curl "https://hermes-agent.hermes-test.app/api/admin/snapshot?userId=<you>" -s -X POST
#    expected: {"ok":true,"handle":{"id":"<uuid>","dir":"/home/hermes/.hermes",...}}
#    NOTE dir MUST be "/home/hermes/.hermes" — if it says "/home/hermes" the
#    deployed Worker is still running the old code (stale deploy).
# 3. graceful stop (SIGTERM + final backup)
cloudflared access curl "https://hermes-agent.hermes-test.app/api/admin/stop?userId=<you>" -s -X POST
#    expected: {"status":"stopped"}
# 4. wake again — triggers restoreLatest
cloudflared access curl "https://hermes-agent.hermes-test.app/api/wake" -s -X POST
#    expected: {"restored": true}
# 5. verify the marker survived the stop→restore
cloudflared access curl "https://hermes-agent.hermes-test.app/api/debug/exec?userId=<you>&cmd=cat%20/home/hermes/.hermes/roundtrip.txt%20%26%26%20ls%20-la%20/usr/local/lib/hermes-agent/venv/bin/python" -s
```
Expected: the marker text is present (restore worked) AND the venv python is
present (install survived the restore's `unsquashfs -f -d` force-overwrite —
proves the /usr/local code is untouched by restoring onto it).
Also confirm the sentinel is healthy (restore would have failed loudly if not):
```bash
cloudflared access curl "https://hermes-agent.hermes-test.app/api/debug/exec?userId=<you>&cmd=test%20-s%20/home/hermes/.hermes/skills/.bundled_manifest%20%26%26%20echo%20SENTINEL_OK" -s
```
Expected: `SENTINEL_OK`.

### V3 — Snapshot size sanity (the win)
```bash
# read the per-user backup index the Worker maintains (verified command)
wrangler r2 object get hermes-agent-state/users/<you>/backups-index.json
# and fetch the newest archive's metadata (created by Task 3's snapshot)
wrangler r2 object get hermes-agent-state/backups/<newest-id>/meta.json
```
Expected: `meta.json` shows `"dir": "/home/hermes/.hermes"` and a `sizeBytes`
that is the size of just `.hermes` state (tens of MB) rather than the whole
home. (Old backups remain in the bucket until the user's lifecycle rules age
them out — expected; compare `sizeBytes` of the newest id against an older one
from the index.)

### V4 — Old-backup compatibility (only if the user has pre-existing backups)
For a userId that has an OLD `dir: "/home/hermes"` handle in R2:
```bash
cloudflared access curl "https://hermes-agent.hermes-test.app/api/wake" -s -X POST
```
Expected: `"restored": true` and the user's pre-change config.yaml/sessions are
back (they land at `/home/hermes/.hermes/*` because the old backup's tree had
them at the same absolute path). This is the no-migration guarantee from
"Current context / assumptions" item 6. Do NOT delete the old handle — let the
next stop/wake roll it over.

## Risks, tradeoffs, and open questions

1. **Restore-over-install (main risk).** Restoring now force-overwrites
   `/home/hermes/.hermes` onto the baked tree. Mitigation: V2 proves the
   `/usr/local` install survives (it's outside the restore dir), and the
   sentinel (`test -s .../skills/.bundled_manifest`) fails loudly on a partial
   extraction before a bad tree is ever re-snapshotted. Residual: if a future
   install.sh puts a REQUIRED runtime file at a top-level `.hermes/` path that a
   stale restore's archive lacks, the restore would leave the baked copy intact
   (unsquashfs `-f` overwrites present files but does NOT delete files absent
   from the archive) — so worst case is a stale runtime file, not a broken one.
2. **Baked runtime bits in the snapshot.** `bin/uv`, `node/`, `skills/` ship in
   every backup now (~tens–hundreds of MB). Tradeoff accepted: a fresh user gets
   a working tree on first boot with zero restore, and a restore re-materializes
   them. This is the "as close to vanilla as we can" ask; it is slightly less
   lean than the old split. If backup size becomes a problem later, the fix is a
   one-line `createBackup` `exclude` (if the SDK adds it) or moving `node/`+`bin/`
   back out — do NOT do that now (YAGNI; user wants vanilla).
3. **`--no-cache` rebuild is slow (~10+ min) and pulls fresh Hermes.** If
   Hermes releases a breaking change between now and deploy, the build or the
   `Up to date` probe will surface it. That's the script working as designed;
   pin the install if you ever need determinism (out of scope here).
4. **Sentinel depends on bundled skills being synced at build.** If a future
   Hermes ships with `--no-skills` by default or renames `.bundled_manifest`,
   V1/V2's `SENTINEL_OK` check will catch it immediately. Low risk.
5. **Old R2 handles keep `dir: "/home/hermes"`** until each user stops/wakes
   once. No action needed; they stay restorable (same absolute data path). Do
   not "helpfully" rewrite them in R2 — the SDK validates handle `id` as a UUID
   and the dir round-trips correctly as-is.
6. **`instance_type: standard-2` is unchanged.** A vanilla install has the same
   footprint as the old one (code was always in the image). No capacity change
   expected.
7. **Open question (ask user before Task 6):** do you want to keep the SSH
   debug server and `cloudflared` tunnel exactly as-is? This plan keeps both
   untouched (they're orthogonal to the folder split). If "as vanilla as
   possible" also means dropping SSH, say so and I'll add a task to remove the
   sshd layer + `authorized_keys` from `wrangler.jsonc` (default deny: keep them).
8. **`wrangler.jsonc`, `src/index.ts`, `src/providers.ts`, `src/env.ts`,
   `src/sandbox.ts`: NO changes.** The Worker restore-gate, cron registry,
   provider injection, stop/destroy final snapshots, and R2 key layout are all
   layout-agnostic. If you find a need to touch them during implementation,
   stop and reconsider — it signals the Dockerfile layout drifted from this plan.

## Execution order (summary)

1. Task 1 (Dockerfile) → local `docker build` + inspect + version probe.
2. Task 2 (start-hermes.sh PATH).
3. Task 3 (persistence.ts BACKUP_DIR + sentinel) → `tsc --noEmit`.
4. Task 4 (build scripts version probe).
5. Task 5 (docs).
6. Task 6 (build-and-push --deploy).
7. Validation V1→V4 in order. V2 (round-trip) is the gate: if the marker or
   the venv python is missing after restore, STOP and investigate before
   declaring done.

Each task commits independently; you can roll back to any prior layout with
`git revert` since no data migration is required.


