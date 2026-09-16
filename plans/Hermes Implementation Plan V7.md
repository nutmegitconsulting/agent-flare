# Hermes V7 — SDK-Native Squashfs Persistence Plan

Status: DRAFT for review (new session executes this)
Date: 2026-09-04
Reference project: github.com/carimura/hermes-flare (squashfs/persistence pattern ONLY)

## 1. Problem (verified 2026-09-04)

Manual squashfs path (Option A+B as deployed today) cannot work reliably:

1. **Two process trees.** The Dockerfile `CMD` child (`start-hermes.sh`) runs under
   the `/sandbox` ENTRYPOINT. `setEnvVars` only ever reaches the SDK defaultSession
   tree. No creation-time per-user env API exists. (Full model:
   ~/.hermes/skills/devops/cloudflare-sandbox-ai-agents/references/env-var-injection-cmd-vs-defaultsession.md)
2. **Restore is a race.** Worker `writeFile`s the snapshot blob to `/tmp/restore.sqfs`;
   the boot script polls 120s. Observed failure: boot at 17:53:38, poll window closed
   17:55:39 with no file ("Starting fresh") while the wake's push landed after the
   window / in a path wiped on instance rollover. `/tmp` is the wrong home.
3. **Silent data staleness.** The "Starting fresh" fallback is a lie: the image has
   333 files baked into `/home/hermes/.hermes` (install.sh ran with HERMES_HOME set
   at build time — config.yaml mtime 2026-09-03 22:05:42 = build layer time). A
   failed restore looks like a healthy boot on default config. This masks the bug
   and will corrupt user expectations once real snapshots exist.
4. **Upload path never worked.** The in-container mksquashfs loop read
   UPLOAD_TOKEN/CF_ACCESS_JWT from env the CMD can't see → no hourly snapshots ever
   landed since Aug 21 (only R2 object: backups/<user-id>/... Aug 21 final).
5. **Snapshot size.** We snapshot a home that contains the full Hermes install
   (2.7GB layer) → multi-GB snapshots, slow boot restores.

## 2. Target architecture (what we take from hermes-flare)

Replace hand-rolled mksquashfs/curl/writeFile with the **SDK-native backup API**:

- `sandbox.createBackup({ dir: "/home/hermes", ttl, localBucket: true })`
  — container-side mksquashfs, uploaded by the SDK directly to R2 through the
  bound `BACKUP_BUCKET` binding (no presigned URL, no R2 token, no account ID,
  no curl, no secrets in container). Objects land at
  `backups/<id>/data.sqsh` + `backups/<id>/meta.json`. Returns a serializable
  `DirectoryBackup` handle `{id, dir, localBucket}` — store it in R2.
- `sandbox.restoreBackup(handle)`
  — Worker-side call; container mounts the archive as a squashfs
  copy-on-write overlay on the dir. **No token, no HTTP, no file push, no race.**
- Snapshot cadence: **Worker cron** (triggers.crons in wrangler.jsonc) calling
  `snapshotIfDue()` (throttled by last-backup age). Final snapshot on stop:
  Worker calls `createBackup` inside `/api/admin/stop` before `sandbox.stop()`.
- Restore hook: **before `hermes serve` first reads state.** We keep the CMD
  boot (unlike hermes-flare's startProcess), so `start-hermes.sh` polls for a
  `/tmp/restore-done` marker file that the Worker writes after
  `restoreBackup` succeeds (or immediately when no backup exists). Bounded
  window (120s). Marker in /tmp is fine — it only needs to outlive ONE boot,
  written by the same wake that created this container.

Verified present in our installed `@cloudflare/sandbox` 0.12.7:
`createBackup`, `restoreBackup`, `BackupOptions {dir, name, ttl, localBucket,
compression, excludes, multipart}`, `DirectoryBackup`, `RestoreBackupResult`.
R2 binding name `BACKUP_BUCKET` already matches the SDK convention.

## 3. What does NOT change

- `hermes serve` as the foreground service (NOT hermes gateway — hermes-flare
  uses gateway; we do not).
- Dockerfile `CMD [start-hermes.sh]` boot model (no startProcess migration).
- cloudflared tunnel for Desktop App access; Access JWT auth model;
  workers.dev disabled; custom domain hermes-agent.hermes-test.app.
- Bootstrap file (`/run/hermes-bootstrap.json`) — still needed, but SHRUNK to
  what the CMD genuinely needs: `cloudflaredToken`, `dashboardSessionToken`.
  (uploadToken/accessJwt/upload URL drop out — no container-side uploads at all.)
- SSH debug access, status file, logging layout.
- The two-process-tree rule: the CMD child NEVER reads setEnvVars values.
  Anything per-user reaching the CMD goes via bootstrap file.


## 4. Implementation steps

### Step 1 — Worker: persistence module (src/persistence.ts, new file)

Port hermes-flare's pattern, multi-tenant:

- `const BACKUP_DIR = "/home/hermes"` (snapshot the whole home; install moves
  out in Step 3 so the tree is small).
- Keys, namespaced per user (we are multi-tenant, hermes-flare is single-agent):
  - `users/<userId>/backup-handle.json` (newest handle)
  - `users/<userId>/backups-index.json` (array of `{id, dir, createdAt}` for pruning)
  - SDK-owned blobs: `backups/<id>/data.sqsh` + `backups/<id>/meta.json`
    (globally unique by id — no prefix, same as hermes-flare).
- `createSnapshot(sandbox, bucket, userId, retentionDays)`:
  - `await sandbox.createBackup({ dir: BACKUP_DIR, ttl: (retentionDays+1)*86400, localBucket: true })`
  - append to index, prune entries older than retentionDays (delete
    `backups/<id>/data.sqsh` + `meta.json`), put new handle.
  - ttl must exceed retention (SDK refuses restore past ttl; 3-day default
    burned hermes-flare — set explicit).
- `restoreLatest(sandbox, bucket, userId): Promise<boolean>`:
  - get handle; if none → false (fresh start).
  - `await sandbox.restoreBackup(handle)`; on BACKUP_EXPIRED/NOT_FOUND →
    clear handle, return false.
  - hermes-flare's corruption-sentinel check: after restore, `exec`
    `test -s <sentinel>` where sentinel is a file that must be non-empty in a
    healthy tree. OUR sentinel (after Step 3): `/home/hermes/.hermes/bin/...`
    or simpler — pick in implementation: a small always-present user file is
    not guaranteed; use `test -s /home/hermes/.hermes/skills/.bundled_manifest`
    (bundled, always restored) — DECIDE AT IMPL, log loudly on failure.
  - hermes-flare does `umount <dir>` before re-restore (stale overlay) — keep.
- `snapshotIfDue(sandbox, bucket, userId, maxAgeMs, retentionDays)`:
  HEAD the handle key; if newer than maxAgeMs → false; else createSnapshot.

Config vars (wrangler vars, non-secret, with code defaults):
  `SNAPSHOT_INTERVAL_MINUTES` (default 60 — hourly per current in-container loop),
  `BACKUP_RETENTION_DAYS` (default 7 to match "keep 24 hourly" spirit;
  DECIDE AT IMPL: hourly for 7d = 168 objects × ~100MB = 16GB R2.
  Consider INTERVAL 240min / RETENTION 7 → ~28 objects. ASK USER.)

### Step 2 — Worker: wake + cron + stop rewiring (src/index.ts)

- `/api/wake`:
  - DELETE: findLatestSnapshot push block, `/tmp/restore-none` write,
    `/internal/download-snapshot` usage (endpoint can stay temporarily for
    manual pulls, or delete in Step 6).
  - ADD after `getSandbox`:
    1. `const restored = await restoreLatest(sandbox, env.BACKUP_BUCKET, userId)`
       — wrapped so a restore failure does NOT fail the wake (log + report
       `restoreError` in the JSON response, mirroring hermes-flare).
    2. `await sandbox.writeFile("/tmp/restore-done", "restored:" + restored)`
       — unblocks the boot poll.
    3. bootstrap write — now only `{ userId, cloudflaredToken,
       dashboardSessionToken }`.
  - Response gains `restored: boolean`, `restoreError?: string`.
- `scheduled()` (new, crons `*/5 * * * *` in wrangler.jsonc):
  - For each known active user (see Step 5 for the user list) →
    `getSandbox(...)` is NOT enough — cron must not start cold containers.
    Use `getState()` first; only snapshot if `state === "running"`.
    (DECIDE AT IMPL: hermes-flare's single-agent cron just wakes the agent
    container every 5 min; ours must iterate. Simplest correct: keep a
    small R2/KV registry `active-users.json` written on wake, destroyed on
    stop/destroy; cron reads it and skips sleeping users. Sleep = no live
    data change, so skipping is safe.)
  - `snapshotIfDue(...)` per running user, try/caught per user.
- `/api/admin/stop`: before `sandbox.stop()` → best-effort
  `createSnapshot` (final backup), then stop. On destroy: same, best-effort,
  short timeout — destroy must not hang.
- `/api/admin/upload-snapshot-from-container` + `/internal/upload-snapshot`
  + the in-container upload loop: DELETE in Step 6 (superseded).

### Step 3 — Dockerfile: install outside the snapshot tree

Root cause of the baked-state mystery AND the size problem.

- `install.sh` gets a `--hermes-home` flag (hermes-flare uses
  `--hermes-home /opt/hermes-install`) — VERIFY flag exists in current
  install.sh (DECIDE AT IMPL: fetch install.sh, grep the flag; if absent,
  alternative: install normally then move tree, or env override).
- New layout:
  - `ENV HERMES_HOME=/home/hermes/.hermes` (unchanged, runtime data)
  - install to `/opt/hermes-install` (code + venv + node bundle, ~1.5-2GB)
  - `ENV PATH=/home/hermes/.local/bin:/opt/hermes-install/node/bin:$PATH`
    (mirror hermes-flare; symlinks in ~/.local/bin point at absolute paths)
  - `RUN mkdir -p /home/hermes/.hermes && chown -R hermes:hermes ...`
    — ship an EMPTY (or near-empty) data dir: fixes the silent-staleness trap.
  - Strip build caches: `rm -rf /home/hermes/.cache /home/hermes/.npm`
    (uv wheels — hermes-flare hit hundreds of MB).
- Keep: squashfs-tools, openssh-server, cloudflared download, USER root final
  (SDK mksquashfs needs root), CMD unchanged.
- Rebuild via Docker Desktop (WSL: `docker` works directly — do NOT route
  through /mnt/c), tag `hermes-cloudflare-v6-hermessandbox:worker`,
  hash-verify start-hermes.sh inside the image before deploy.

### Step 4 — start-hermes.sh: strip persistence, keep CMD + serve

- DELETE: the entire mksquashfs hourly loop, the SIGTERM snapshot block,
  the 120s /tmp/restore.sqfs poll + unsquashfs block, load_bootstrap's
  upload fields.
- RESTORE GATE (the one new coordination point):
  ```
  # poll for /tmp/restore-done (Worker writes it after restoreBackup,
  # or immediately when no backup exists). 120s cap.
  ```
  Order-independence preserved: wake may arrive after spawn; poll covers it.
  If the marker never comes (wake never happens — e.g. container started by
  cron keep-alive without wake), the cap still releases and serve starts on
  whatever is on disk.
- KEEP: install_tools, sshd, dashboard-token watcher (bootstrap: now only
  cloudflaredToken + dashboardSessionToken), cloudflared pidfile watcher,
  `jobs -p | xargs -r kill` in _term (now just kills watchers/sshd),
  `exec hermes serve`.
- SIGTERM trap: keep only the cleanup (no snapshot — Worker handles final).
- `chmod -R a+rX "$HERMES_HOME"` before serve (mksquashfs readability).

### Step 5 — Data migration (the Aug 21 snapshot)

Old R2 layout: `backups/<user-id>/final.sqfs` (Aug 21),
`backups/<user-id>/hourly/*.sqfs` (old curl layout).
New SDK layout expects `backups/<id>/data.sqsh` + `backups/<id>/meta.json`
and a handle `{id, dir, localBucket}`.

- ONE-OFF script (Node, local, uses wrangler R2 API or a tiny throwaway
  Worker script):
  1. `wrangler r2 object get hermes-agent-state/hermes-agent-state/backups/<user-id>/final.sqfs`
     (or via binding in a one-shot `wrangler deploy` script) → /tmp/final.sqfs
  2. validate: `file` shows Squashfs.
  3. put as `backups/migrate-user-aug21/data.sqsh`
  4. `unsquashfs -l` it; write `meta.json` matching the SDK's shape —
     **DECIDE AT IMPL: read the meta.json schema from the 0.12.7 dist
     (constants like BACKUP_METADATA_OBJECT_NAME; dump a fresh
     createBackup's meta.json first — cheapest ground truth: create a
     throwaway backup of a small dir in a dev sandbox, fetch its meta.json,
     mirror the fields) with dir=/home/hermes.**
  5. put handle `{"id":"migrate-user-aug21","dir":"/home/hermes","localBucket":true}`
     at `users/<user-id>/backup-handle.json` + index entry with createdAt=Aug 21.
- RISK: if the SDK validates meta.json strictly (checksum of the archive?),
  the hand-rolled meta may fail restoreBackup. Fallback: unsquashfs the Aug 21
  archive locally, push its CONTENTS into the running container via
  sandbox.writeFile per-file (tedious) — or accept losing the Aug 21 state
  (user decision; it predates current user expectations by 2 weeks).
  Prefer: test meta.json shape against a real createBackup output FIRST.

### Step 6 — Decommission manual-path remnants

- DELETE: `/internal/download-snapshot` + `findLatestSnapshot` helper
  (keep only if Step 5's manual pull uses it — then delete post-migration),
  `/internal/upload-snapshot`, `/api/admin/upload-snapshot-from-container`,
  `UPLOAD_TOKEN` worker secret references (env.ts), bootstrap upload fields.
- Keep `/api/wake` shape (clients already call it) — response fields
  `snapshotPushed` removed, `restored` added.

### Step 7 — wrangler.jsonc

- Add `"triggers": { "crons": ["*/5 * * * *"] }`.
- Add vars: SNAPSHOT_INTERVAL_MINUTES, BACKUP_RETENTION_DAYS (or secret?
  non-secret → vars; DECIDE AT IMPL).
- No new bindings (BACKUP_BUCKET exists; SDK reads it from DO env itself).

### Step 8 — Build, deploy, verify (gate each before the next)

1. `npx tsc --noEmit` clean; `bash -n start-hermes.sh` clean.
2. Local: `docker build` → tag → hash-verify scripts in image
   (`docker run --rm --entrypoint sha256sum ...`).
3. Deploy Worker + image. Confirm image digest in deploy output matches
   local image digest.
4. CRITICAL PRE-FLIGHT: create a throwaway sandbox (test userId, e.g.
   `migration-test`), let it boot, call a debug endpoint to force ONE
   `createBackup`, then `wrangler r2 object get` its
   `backups/<id>/meta.json` → this is the ground-truth schema for Step 5.
   Also validates the full createBackup→R2 path end-to-end before we trust
   it with real data. Destroy the test sandbox.
5. Migrate Aug 21 handle (Step 5) with the confirmed meta schema.
6. Cold-boot test: destroy the user container → wake → response shows
   `restored: true` → SSH in → `/home/hermes/.hermes` contains Aug 21
   config.yaml (mtime Aug 21, NOT Sep 3 build-time) → serve responds.
7. Cron test: wait for a `*/5` tick with container running → new
   `backups/<id>/data.sqsh` appears in R2, handle updated.
8. Stop test: `/api/admin/stop` → final backup exists (newest by uploaded).
9. Regression: tunnel comes up (cloudflared pidfile), dashboard .env token
   lands within 5s, status file progression normal.
10. Update the cloudflare-sandbox-ai-agents skill: mark manual squashfs path
    DEPRECATED, point to SDK-native (this plan's file path).

## 5. Risks / open decisions (resolve at session start)

1. **meta.json schema for the migrated Aug 21 snapshot** — ground-truth via
   throwaway backup (Step 8.4) before migrating. Fallback: lose Aug 21.
2. **Snapshot cadence × retention × size** — home now ~50-150MB
   (post-Step-3). Interval/retention combo needs user sign-off (R2 cost).
3. **Cron user registry** — new small piece of state (R2 json). Keep it
   minimal; alternative is waking all known users every 5 min (expensive).
4. **Restore overlay semantics** — restoreBackup mounts CoW overlay; after
   restore the dir is a FUSE mount. Verify `hermes serve` (SQLite WAL!)
   tolerates a squashfs-overlay FS. hermes-flare runs the same thing with
   gateway, but we run `hermes serve` + WAL sqlite — if WAL misbehaves on
   overlay, config.yaml's `database.journal_mode: "delete"` fallback exists;
   DECIDE AT IMPL: test write+checkpoint on restored overlay in cold-boot test.
5. **install.sh `--hermes-home` flag** — verify against current install.sh.
6. **Restore failure policy** — follow hermes-flare: never block serve start
   on restore failure; surface restoreError in wake response.

## 6. Reference pointers

- hermes-flare clone: /tmp/hermes-flare (re-clone if gone:
  github.com/carimura/hermes-flare) — src/persistence.ts, src/index.ts
  (ensureGateway/scheduled), Dockerfile, wrangler.jsonc, start-hermes.sh.
- SDK source of truth: node_modules/@cloudflare/sandbox/dist/
  (createBackup/restoreBackup impl, BACKUP_* constants, meta.json writer).
- Process-tree model (still applies to CMD + bootstrap):
  ~/.hermes/skills/devops/cloudflare-sandbox-ai-agents/references/env-var-injection-cmd-vs-defaultsession.md
- Previous sessions: 20260903_180724_6e38f7 (squashfs/snapshot history),
  20260904_085827_2bf639 (Option A+B design + env investigation).
- Known upstream bug (context only; our localBucket path may be affected if
  using interceptHttps — we are NOT using it): sandbox-sdk issue #619
  ("restoreBackup fails ... This doesn't look like a squashfs image").

