# Hermes Implementation Plan V9 — Re-implement the hermes-flare install/profile split

Status: proposed (plan mode — nothing edited until approved)
Author: implementer-facing; every path, command, and expected output stated. Do not improvise.

## Goal

Undo the V8 "vanilla" snapshot bloat by restoring the **hermes-flare separation**:
Hermes install (code + venv + managed uv + Node) lives at `/opt/hermes-install`
(OUTSIDE the snapshot tree); `/home/hermes` is again the snapshot root and carries
ONLY mutable user state (`.hermes/`), the tiny `hermes` wrapper, and dotfiles.
Snapshots shrink back to V7 sizes (tens of MB: sessions, config, skills, caches —
no uv, no Node, no venv).

Explicitly NOT the goal: excluding `skills/` or caches from the snapshot (they are
user state; the SDK has no exclude option — accepted cost in every layout so far).

## Why V8 bloats (measured)

- Vanilla root install bakes managed `uv`+`uvx` into `$HERMES_HOME/bin/` (~70 MB raw
  on a live install) and, when the base Node is old, `$HERMES_HOME/node/` — both INSIDE
  the snapshot tree, so every backup carries them.
- `skills/` (~30 MB raw) is carried by every layout (runtime-synced bundled skills);
  it is not the regression.
- The V8 image put uv's CPython at `/usr/local/python/` and uv tools under
  `/root/.local/share/uv/tools` — outside the tree, correctly. The regression is
  `bin/` (+ potential `node/`), roughly doubling-to-tripling the snapshot.
- `BACKUP_DIR=/home/hermes/.hermes` (V8) only trims dotfiles; it does not remove the
  binaries, because install.sh puts them under `$HERMES_HOME` unconditionally.

## Mechanism (hermes-flare / V6, re-validated against live install.sh 2026-09-15)

`install.sh` still supports `--hermes-home PATH`. Run the install as the **hermes**
user with `--hermes-home /opt/hermes-install`:
- Code + venv → `/opt/hermes-install/hermes-agent/` (repo + venv)
- Managed Node (if needed) → `/opt/hermes-install/node/`
- Managed uv (ALWAYS, unconditional) → `/opt/hermes-install/bin/uv` — i.e.
  `$HERMES_HOME/bin/uv` with HERMES_HOME overridden, which lands OUTSIDE `/home/hermes`
- uv CPython → `/opt/uv/{python,bin}` via `UV_PYTHON_INSTALL_DIR`/`UV_PYTHON_BIN_DIR`
- The `hermes` launcher wrapper → `/home/hermes/.local/bin/hermes` (tiny; INSIDE the
  snapshot tree → doubles as the corruption sentinel, as in V7)
- `$HERMES_HOME` at runtime stays `/home/hermes/.hermes` (config.yaml, .env, SOUL.md,
  sessions, skills/, caches) — the ONLY mutable state.

Note: `--hermes-home` overrides the layout resolver; this IS the flare split, not
vanilla. That is exactly what we are re-implementing.

## Compatibility / no-migration

- Old V7 handles (`dir: "/home/hermes"`) restore as-is (original layout).
- V8-era handles (`dir: "/home/hermes/.hermes"`) also stay restorable: their archive
  root lands at `/home/hermes/.hermes` — the same absolute path the new runtime reads
  (`unsquashfs -f -d /home/hermes` extracts the archive's `.hermes/` subtree there).
- After the next stop/wake the handle rolls to `dir: "/home/hermes"`.
- Sentinel: `/home/hermes/.local/bin/hermes` exists in V7 backups (baked wrapper),
  in new snapshots (baked wrapper again) — and in V8-era backups? NO: vanilla backups
  rooted at `.hermes` do NOT contain `.local/bin/hermes`. Restoring a V8-era handle
  under the new runtime leaves the sentinel missing → `restoreLatest` fails loudly
  (assertTreeHealthy) even though data restored. Mitigation (chosen): accept the loud
  failure for V8-era handles; re-wake once — restoreLatest deletes the handle only on
  EXPIRED/NOT_FOUND, so instead: if this bites in validation, delete
  `users/<userId>/backup-handle.json` once (one `wrangler r2 object delete`), then
  wake fresh. Expected in practice: the user's live handle rolls to a V9 snapshot on
  the first stop/wake before this ever matters.

## Step-by-step tasks

### Task 1 — Dockerfile: restore the flare install (replace entire file)

Copy-paste this complete file:

```dockerfile
# =============================================================================
# Hermes Agent on Cloudflare Sandbox (V9 — hermes-flare install/profile split)
# =============================================================================
# Base: cloudflare/sandbox:0.12.7-python (matches @cloudflare/sandbox version).
#
# LAYOUT (install vs. user-state separated so snapshots stay small):
#   /opt/hermes-install           code + venv + Node bundle + managed uv (~1.5-2 GB)
#   /opt/uv                       uv-managed CPython
#   /home/hermes/.hermes          runtime user data (HERMES_HOME; ships EMPTY)
#   /home/hermes/.local/bin/hermes  tiny `hermes` wrapper (points at /opt) = SENTINEL
#
# The SDK snapshots BACKUP_DIR=/home/hermes — small (~50-150 MB) and carries no
# install artifacts. The container ends as root so the SDK can run mksquashfs.
# =============================================================================

FROM docker.io/cloudflare/sandbox:0.12.7-python

USER root

# --- System tools ---
# build-essential is required by install.sh's node-pty native build.
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

# --- hermes user (install + runtime data owner) ---
RUN useradd --create-home --shell /bin/bash --uid 1000 hermes

# Runtime data dir. SHIPS EMPTY — snapshot tree must not carry build-time state
# (a baked config.yaml makes a failed restore look like a healthy boot).
ENV HERMES_HOME=/home/hermes/.hermes
ENV UV_NO_CONFIG=1

# Install to /opt/hermes-install (OUTSIDE the snapshot tree) as the hermes user:
# install.sh resolves INSTALL_DIR=$HERMES_HOME/hermes-agent, the Node bundle lands
# at $HERMES_HOME/node, managed uv at $HERMES_HOME/bin/uv, and the `hermes` wrapper
# in $HOME/.local/bin — so everything heavy lives under /opt and only the tiny
# wrapper sits in /home/hermes. UV_PYTHON_INSTALL_DIR/BIN_DIR keep uv's CPython in
# /opt too.
RUN mkdir -p /opt/hermes-install /opt/uv /home/hermes/.hermes \
    && chown -R hermes:hermes /opt/hermes-install /opt/uv /home/hermes

USER hermes
WORKDIR /home/hermes
ENV HOME=/home/hermes
RUN UV_PYTHON_INSTALL_DIR=/opt/uv/python \
    UV_PYTHON_BIN_DIR=/opt/uv/bin \
    curl -fsSL https://hermes-agent.nousresearch.com/install.sh \
      | bash -s -- --skip-setup --non-interactive --hermes-home /opt/hermes-install \
    && test -x /opt/hermes-install/bin/uv \
    && ls -la /opt/hermes-install/hermes-agent \
    # Strip install-time caches — uv wheels/npm cache land in $HOME and are
    # hundreds of MB we don't need at runtime.
    && rm -rf /home/hermes/.cache /home/hermes/.npm \
    && chown -R hermes:hermes /opt/uv /home/hermes

# `hermes` CLI lives in ~/.local/bin; managed Node (if any) in /opt/hermes-install/node/bin.
ENV PATH=/home/hermes/.local/bin:/opt/hermes-install/node/bin:/usr/local/bin:$PATH

# Snapshot-friendly perms: createBackup's mksquashfs needs everything readable.
RUN chmod -R a+rX /home/hermes

# Container runs as root at runtime so the Sandbox SDK can run mksquashfs.
USER root

# --- Startup ---
COPY --chown=root:root start-hermes.sh /usr/local/bin/start-hermes.sh
RUN chmod +x /usr/local/bin/start-hermes.sh

# sandbox binary is ENTRYPOINT; CMD is spawned as child.
CMD ["/usr/local/bin/start-hermes.sh"]
```

Verification (build locally, inspect — no push yet):
```bash
cd ~/projects/hermes-cloudflare-v6
docker build --no-cache -f Dockerfile -t hermes-flare-check .
```
Expected: build succeeds (no `test -x` failure). Then:
```bash
docker run --rm --entrypoint /bin/bash hermes-flare-check -c \
  'ls -la /opt/hermes-install/hermes-agent | head -5; echo ---; ls /opt/hermes-install/bin/; echo ---; ls -la /home/hermes/; echo ---; ls -la /home/hermes/.hermes; echo ---WRAPPER---; head -3 /home/hermes/.local/bin/hermes'
```
Expected:
- `/opt/hermes-install/bin/` contains `uv` (+ `uvx`).
- `/home/hermes/` has `.hermes/` (EMPTY) and `.local/bin/hermes` wrapper; NO config.yaml/.env/SOUL.md.
- Wrapper head execs `/opt/hermes-install/...` python.
```bash
docker run --rm --entrypoint /bin/bash hermes-flare-check -c \
  'su hermes -c "HERMES_HOME=/home/hermes/.hermes /home/hermes/.local/bin/hermes --version" 2>&1'
```
Expected: Hermes version line.

Commit:
```bash
git add Dockerfile
git commit -m "docker: restore hermes-flare split - install /opt/hermes-install, snapshot /home/hermes"
```

### Task 2 — start-hermes.sh PATH (one line)

File: `start-hermes.sh`. Replace line 30:

OLD:
```bash
export PATH="/usr/local/bin:/home/hermes/.hermes/node/bin:$PATH"
```
NEW:
```bash
export PATH="/home/hermes/.local/bin:/opt/hermes-install/node/bin:/usr/local/bin:$PATH"
```
(`HERMES_HOME` export on line 29 is already `/home/hermes/.hermes` — no change.)

Verification:
```bash
bash -n start-hermes.sh && echo SYNTAX_OK
grep -n 'PATH=' start-hermes.sh   # expect the NEW line
```

Commit:
```bash
git add start-hermes.sh
git commit -m "boot: PATH via ~/.local/bin wrapper + /opt node (flare split)"
```

### Task 3 — persistence.ts: BACKUP_DIR + sentinel back to flare values

File: `src/persistence.ts`. Two edits:

3a.
OLD: `const BACKUP_DIR = "/home/hermes/.hermes";`
NEW: `const BACKUP_DIR = "/home/hermes";`

3b. Replace the V8 sentinel block with the flare sentinel:
OLD (current):
```ts
const SENTINEL_FILE = "/home/hermes/.hermes/skills/.bundled_manifest";
```
NEW (restore the V7 comment + constant):
```ts
const SENTINEL_FILE = "/home/hermes/.local/bin/hermes";
```
And restore the matching comment above it:
```
 * Corruption sentinel: a healthy /home/hermes always has a non-empty hermes
 * launcher wrapper at /home/hermes/.local/bin/hermes (baked into the image,
 * pointing at /opt/hermes-install/venv). It is inside the snapshot tree, so
 * every backup carries it; a partial unsquashfs extraction leaves it as a
 * 0-byte regular file. Checked before every snapshot and after every restore.
```
(`assertTreeHealthy`'s `test -s`, the `umount` no-op, and the `chmod a+rX` are
unchanged — they reference the constants.)

Verification:
```bash
grep -n 'BACKUP_DIR = \|SENTINEL_FILE = ' src/persistence.ts
npx tsc --noEmit -p tsconfig.json && echo TYPECHECK_OK
```
Expected: `/home/hermes` and `/home/hermes/.local/bin/hermes`; `TYPECHECK_OK`.

Commit:
```bash
git add src/persistence.ts
git commit -m "persistence: snapshot /home/hermes; sentinel = .local/bin/hermes wrapper"
```

### Task 4 — build scripts: probe the flare wrapper

Both files keep the informational probe (NO freshness gate — removed in 8126344;
--no-cache is the freshness guarantee; do NOT resurrect the "Up to date" gate).

`scripts/build-and-push.sh`:
OLD: `'su hermes -c "HERMES_HOME=/home/hermes/.hermes /usr/local/bin/hermes --version" 2>&1'`
NEW: `'su hermes -c "HERMES_HOME=/home/hermes/.hermes /home/hermes/.local/bin/hermes --version" 2>&1'`

`scripts/build-and-push.ps1`: same substitution.

Verification:
```bash
bash -n scripts/build-and-push.sh && echo SYNTAX_OK
grep -rn 'usr/local/bin/hermes' scripts/ || echo CLEAN
```

Commit:
```bash
git add scripts/build-and-push.sh scripts/build-and-push.ps1
git commit -m "build: probe flare wrapper ~/.local/bin/hermes"
```

### Task 5 — Docs (README.md + plans/README.md, same edits both)

- "State lives in the container at ..." → "State lives in the container at
  `/home/hermes/.hermes` (HERMES_HOME); the snapshot tree is `/home/hermes`, which
  also carries the tiny `hermes` wrapper. The install (code, venv, Node, uv) lives
  at `/opt/hermes-install` (+ `/opt/uv`), outside the snapshot tree."
- "Integrity: ... checks a sentinel file" → `(/home/hermes/.local/bin/hermes)`.
- "Restore: ... extracts the newest handle into" → `/home/hermes`.
- Container-image bullet → "Install (code, venv, Node bundle, uv CPython) lands in
  `/opt/hermes-install` + `/opt/uv`; `/home/hermes/.hermes` ships empty and only the
  tiny `hermes` wrapper lives in the snapshot tree."
- hermes-flare attribution bullet → "The separation of install path
  (`/opt/hermes-install`) from mutable state (`/home/hermes`)".

Verification:
```bash
grep -rn 'usr/local/lib/hermes-agent\|/usr/local/share/uv\|/usr/local/python' README.md plans/README.md || echo CLEAN
```

Commit:
```bash
git add README.md plans/README.md
git commit -m "docs: flare split layout (V9)"
```

### Task 6 — Build, push, deploy

Docker Desktop running on the Windows host (ask; no WSL workarounds). Then:
```bash
cd ~/projects/hermes-cloudflare-v6
bash scripts/build-and-push.sh --deploy
```
Expected: `==> Push complete.` (transient "blob unknown to registry" retries are
normal) then `==> Deploy complete.` Image size ≈ V7-era image.

## Validation (V1–V3; run after deploy)

V1 — wake + boot (user runs Windows commands; agent verifies from R2/logs):
- `/api/wake` → `"restored": true` (old V7 or V8 handle) or `false` (fresh).
- `.startup-status` reaches "Starting hermes serve..." — NOT stuck on restore marker.
- `ls -la /home/hermes/.hermes` shows config.yaml appear after serve boot (serve
  writes it — its absence BEFORE first boot is expected, not a restore failure).

V2 — round-trip (the money test):
```powershell
# Windows: plant marker, force snapshot, destroy, wake, verify
cloudflared access curl "https://hermes-agent.hermes-test.app/api/debug/exec?userId=<user-id>&cmd=echo%20v9-roundtrip%20%3E%20/home/hermes/.hermes/roundtrip.txt" -s
cloudflared access curl "https://hermes-agent.hermes-test.app/api/admin/snapshot?userId=<user-id>" -s -X POST
#   expect handle dir == "/home/hermes"  (V9 proof; ".hermes" = stale deploy)
cloudflared access curl "https://hermes-agent.hermes-test.app/api/admin/destroy?userId=<user-id>" -s -X POST
cloudflared access curl "https://hermes-agent.hermes-test.app/api/wake" -s -X POST
#   expect "restored": true
cloudflared access curl "https://hermes-agent.hermes-test.app/api/debug/exec?userId=<user-id>&cmd=cat%20/home/hermes/.hermes/roundtrip.txt%3B%20test%20-s%20/home/hermes/.local/bin/hermes%20%26%26%20echo%20SENTINEL_OK%3B%20test%20-x%20/opt/hermes-install/hermes-agent/venv/bin/python%20%26%26%20echo%20VENV_OK" -s
```
Expected: `v9-roundtrip`, `SENTINEL_OK`, `VENV_OK`.

V3 — size sanity (agent, from R2):
```bash
npx wrangler r2 object get hermes-agent-state/users/<userId>/backup-handle.json --pipe
npx wrangler r2 object get hermes-agent-state/backups/<newest-id>/meta.json --pipe
```
Expected: handle `dir == "/home/hermes"`; newest `sizeBytes` materially smaller than
the V8-era backup (uv/node gone). Compare against an older entry in backups-index.json.

## Risks / tradeoffs

1. **V8-era handles + new sentinel**: a `.hermes`-rooted archive lacks
   `.local/bin/hermes` → post-restore health check fails loudly. One-time handle
   delete fixes it (see Compatibility). Low real-world exposure (one stop/wake
   rolls handles to V9).
2. **Restore no longer re-materializes uv/Node**: they are baked in the image; a
   broken install requires a rebuild (as in V7). Accepted — this is the point.
3. **`--no-cache` rebuild ~10+ min**, pulls fresh Hermes (same as V8 process).
4. **Snapshot still carries skills/ (~30 MB) + caches** — user state; excluded from
   this plan by design (SDK has no exclude option).
5. **config.yaml absent until first serve boot** — expected; do not mistake for
   restore failure (V1 note).
6. **NO changes**: wrangler.jsonc, src/index.ts, src/providers.ts, src/env.ts,
   src/sandbox.ts. If implementation feels a need to touch them, stop — the layout
   drifted from this plan.

## Execution order

Task 1 → local build + inspect + version probe → Task 2 → Task 3 (tsc) → Task 4 →
Task 5 → Task 6 (build/push/deploy) → V1 → V2 (gate: marker + sentinel + venv
after restore) → V3.
