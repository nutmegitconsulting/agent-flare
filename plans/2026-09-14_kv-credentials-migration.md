# Credentials Out of R2 — KV Migration Plan

> **Status:** COMPLETE (2026-09-14). Tasks 1–3 implemented; Task 3.5 seeded (KV byte-identical to R2 source, temp files cleaned); Task 4 deployed (version `344c7033-5aa3-49cd-8bbe-eff7c35c61ed`) and verified end-to-end (`status` → provisioned:true; `client-init` → existing:true, same hostname, session token matches KV; `wrangler tail` clean, no KV errors); Task 5 deleted both R2 credential objects (verified "key does not exist") with Worker still serving from KV.

**Goal:** Remove all usable credentials (tunnel token, dashboard session token, gateway JWT) from the `hermes-agent-state` R2 bucket so third-party R2 backups never carry them; store them in a dedicated Workers KV namespace instead.

**Architecture:** New KV namespace `CREDENTIALS_KV` holds three credential classes under per-user keys. `src/credentials.ts` is the single access module (get/put per credential type). The Worker endpoints (`client-init`, `status`, `wake`, `admin/gateway-jwt`) read/write KV instead of R2. R2 remains authoritative for snapshots/backups and non-secret config only.

**Threat model:** The R2 bucket is replicated to third-party backup storage. Assume it leaks. KV is a separate storage product, not in that replication path. Post-migration, a leaked backup contains squashfs archives + metadata only — no usable credentials.

---

## Key Layout

KV (`CREDENTIALS_KV`) — credentials only:

| Key | Value | Was (R2) |
|---|---|---|
| `cred:tunnel:<userId>` | `{"hostname":"hermes-<id>.hermes-test.app","token":"<tunnel run token>"}` | `users/<id>/cloudflared/creds.json` |
| `cred:session:<userId>` | `{"token":"<64-hex dashboard session token>"}` | `users/<id>/session-token.json` |
| `cred:gwjwt:<userId>` | `{"jwt":"...","storedAt":"ISO"}` | NOT in R2 — delivered by client `POST /api/admin/gateway-jwt` on each setup run (self-heals; no seed needed) |

R2 (`BACKUP_BUCKET`) — stays as-is, minus the three credential keys:

| Key | Role |
|---|---|
| `users/<id>/providers.json` | provider config — no secrets, stays in R2 |
| `users/<id>/backup-handle.json` | restore target — NOT a secret, and restore-correctness needs R2's strong consistency |
| `users/<id>/backups-index.json` | observability/prune working set — coupled to blobs, stays |
| `backups/<id>/*` | squashfs archives — the payload itself |

## Consistency Rationale (why KV is acceptable here)

KV is eventually consistent (~60s worst case). Acceptable because every credential is **write-once-at-provision, read-on-wake** — there is no read-after-write inside one request path. If a client wakes seconds after first provision, it may see "not provisioned" once; the existing client retry covers it. `backup-handle.json` deliberately does NOT move: it is written seconds before stop and read on wake, where a stale KV copy could restore the previous backup (silent data loss of the final delta). That correctness requirement is why R2 keeps it.

---

## Tasks

### Task 1: Create KV namespace + binding

- Create: `wrangler.jsonc` `kv_namespaces` block
- Create: `src/env.ts` `CREDENTIALS_KV: KVNamespace` in `Env`

```bash
npx wrangler kv namespace create CREDENTIALS_KV
# returns id — wire it:
```

```jsonc
// wrangler.jsonc
"kv_namespaces": [
  { "binding": "CREDENTIALS_KV", "id": "REDACTED-KV-ID" }
],
```

```ts
// src/env.ts
import type { R2Bucket, KVNamespace, DurableObjectNamespace, Ai } from "@cloudflare/workers-types";
export interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  BACKUP_BUCKET: R2Bucket;
  /** Credentials store (V9): tunnel token, dashboard session token, gateway
   *  JWT. Kept OUT of the R2 backup bucket so third-party R2 backups never
   *  carry usable credentials. Write-once/read-many fits KV's eventual
   *  consistency (~60s propagation). */
  CREDENTIALS_KV: KVNamespace;
  AI: Ai;
  ACCESS_AUD_TAG: string;
  CF_ACCOUNT_ID: string;
  CF_ZONE_ID: string;
  CF_API_TOKEN: string;
  SNAPSHOT_INTERVAL_MINUTES: string;
  CLOUDFLARE_AI_API_TOKEN?: string;
}
```

Verify: `grep -n kv_namespaces wrangler.jsonc && grep -n CREDENTIALS_KV src/env.ts`

### Task 2: `src/credentials.ts` — single access module

- Create: `src/credentials.ts`

Three credential classes, one module. All values stored as JSON strings; parse defensively (corrupt value → `null`, never throw into a wake path).

```ts
const KV_PREFIX = {
  tunnel: "cred:tunnel:",
  session: "cred:session:",
  gwjwt: "cred:gwjwt:",
} as const;

export type TunnelCreds = { hostname: string; token: string };
export type SessionCreds = { token: string };
export type GatewayJwtCreds = { jwt: string; storedAt: string };

function key(kind: keyof typeof KV_PREFIX, userId: string): string {
  return KV_PREFIX[kind] + userId;
}

export async function getTunnelCreds(kv: KVNamespace, userId: string): Promise<TunnelCreds | null> {
  const raw = await kv.get(key("tunnel", userId));
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Partial<TunnelCreds>;
    if (data.hostname && data.token) return { hostname: data.hostname, token: data.token };
    return null;
  } catch { return null; }
}

export async function putTunnelCreds(kv: KVNamespace, userId: string, creds: TunnelCreds): Promise<void> {
  await kv.put(key("tunnel", userId), JSON.stringify(creds));
}

export async function getSessionToken(kv: KVNamespace, userId: string): Promise<string | null> {
  const raw = await kv.get(key("session", userId));
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as { token?: string };
    return data.token ?? null;
  } catch { return null; }
}

export async function putSessionToken(kv: KVNamespace, userId: string, token: string): Promise<void> {
  await kv.put(key("session", userId), JSON.stringify({ token }));
}

export async function getGatewayJwt(kv: KVNamespace, userId: string): Promise<GatewayJwtCreds | null> {
  const raw = await kv.get(key("gwjwt", userId));
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Partial<GatewayJwtCreds>;
    return data.jwt ? { jwt: data.jwt, storedAt: data.storedAt ?? "" } : null;
  } catch { return null; }
}

export async function putGatewayJwt(kv: KVNamespace, userId: string, jwt: string): Promise<void> {
  await kv.put(key("gwjwt", userId), JSON.stringify({ jwt, storedAt: new Date().toISOString() }));
}
```

Verify: `npx tsc -p tsconfig.json --noEmit` — clean.

### Task 3: Rewire gateway-JWT in `src/providers.ts` + `src/index.ts`

- Modify: `src/providers.ts` — `storeGatewayJwt`/`loadGatewayJwt` signatures flip from `R2Bucket` to `KVNamespace`, delegating to `credentials.ts`; `providers.json` (no secrets) stays in R2 via a `providersKey()` helper; drop `JWT_KEY_SUFFIX` and `keysFor()`.
- Modify: `src/index.ts` — `storeGatewayJwt(c.env.CREDENTIALS_KV, userId, body.jwt)`; `loadProviders(sandbox, c.env.CREDENTIALS_KV, c.env.BACKUP_BUCKET, userId, ...)` (KV first, R2 second — KV for the JWT, R2 for provider config).

Verify: `grep -n "gateway-jwt.json" src/providers.ts src/index.ts` — nothing. `npx tsc -p tsconfig.json --noEmit` — clean.

### Task 3.5: Seed KV from R2 (pre-deploy, one-time copy)

Deploying the new code with an empty KV namespace makes the Worker treat every existing user as never-provisioned: `client-init` would create a new tunnel + hostname (orphaning the live one) and mint a new session token (killing the current dashboard session). This task copies the two self-healing-unsafe credentials from R2 into KV under the new keys so the migration is invisible to existing users. Run BEFORE `wrangler deploy` (Task 4).

Per user (only `user` today — repeat as other users exist):

```bash
# 1. Pull the two R2 credential objects to temp files (value = the JSON body itself)
npx wrangler r2 object get hermes-agent-state/users/user/cloudflared/creds.json   --remote -f /tmp/kvseed-creds.json
npx wrangler r2 object get hermes-agent-state/users/user/session-token.json       --remote -f /tmp/kvseed-session.json

# 2. Verify the shape before pushing (creds.json = {hostname,token}, session-token.json = {token})
python3 -c "import json;print(json.load(open('/tmp/kvseed-creds.json')).keys())"
python3 -c "import json;print(json.load(open('/tmp/kvseed-session.json')).keys())"

# 3. Push verbatim to KV under the new key layout (JSON bytes identical to R2)
npx wrangler kv key put cred:tunnel:user  --path /tmp/kvseed-creds.json   --binding CREDENTIALS_KV
npx wrangler kv key put cred:session:user --path /tmp/kvseed-session.json --binding CREDENTIALS_KV

# 4. Clean up — temp files held live credentials
rm -f /tmp/kvseed-creds.json /tmp/kvseed-session.json
```

Notes:
- `cred:gwjwt:user` is NOT seeded — the gateway JWT never lived in R2; the client re-POSTs it on every setup run (self-heals).
- `--path` reads the value from the file, so no secret touches argv/shell history.
- KV is eventually consistent: seed → deploy → verify (Task 4) has >60s of margin; if the first verify shows `existing:false` anyway, wait a minute and re-run rather than re-seeding.

Verify: `npx wrangler kv key get cred:tunnel:user --binding CREDENTIALS_KV` and `cred:session:user` both return the same JSON as the R2 source objects.

### Task 4: Deploy

```bash
npx wrangler deploy
```

Verify deploy succeeded, then end-to-end against production:

```bash
# existing client scripts — tunnel must still resolve
scripts/hermes-client.ps1   # or the equivalent init/status/wake calls
```

Expected: `existing: true` with the same hostname and session token as pre-migration (the pre-seeded KV values). `wrangler tail` during the calls — no KV errors.

### Task 5: Delete R2 credential objects (post-deploy only)

Deploy first, verify the Worker serves from KV, THEN delete — this ordering keeps rollback trivial (pre-deploy: R2 still authoritative; post-deploy: KV authoritative, R2 copies are vestigial).

```bash
npx wrangler r2 object delete hermes-agent-state/users/user/cloudflared/creds.json --remote
npx wrangler r2 object delete hermes-agent-state/users/user/session-token.json --remote
```

Verify: `npx wrangler r2 object get hermes-agent-state/users/user/cloudflared/creds.json --remote` — "key does not exist". Same for session-token. Repeat per-user as other users exist.

## Rollback

Pre-deploy: nothing to do — production still runs the old code on R2. Post-deploy: `npx wr rollback` (previous version still reads R2, and R2 objects were only deleted in Task 5 — if Task 5 has run, re-seed R2 from KV values first, which the KV keys still hold). The KV namespace is never deleted.

## Explicitly NOT moving (with reasons)

| Key | Reason |
|---|---|
| `backup-handle.json` | Restore-correctness: written seconds before stop, read on wake; KV staleness could restore the previous backup (silent data loss). Also not a secret. |
| `backups-index.json` | Prune/reconcile working set coupled to the R2 blobs; staleness during reconcile deletes real backups or leaves orphans. Not a secret. |
| `providers.json` | No secrets inside; moving it buys nothing for exfil safety, costs ~60s provider-update propagation. Neutral. |
| `active-users.json` | Global non-secret registry; harmless staleness. Could move for tidiness; not worth it. |
| `backups/*` | The payload; KV's 25 MiB value cap rules it out structurally. |

## Out of Scope

- Providers.json move (above) — revisit only if the third-party backup gains a new consumer that must not see provider config.
- `active-users.json` move — revisit if R2 object count ever matters.
- Server-side provisioning changes — the client PS1 flow is unchanged; credentials never touch the client.
- Future move to Secrets Store: NOT a drop-in. A Secrets Store binding is one named secret per Worker (`secrets_store_secrets: [{binding, store_id, secret_name}]`), not a namespace — the per-user `cred:*:<userId>` key layout won't port 1:1. At that point `credentials.ts` changes shape (one secret per user, or a single JSON map), so plan that as a rework, not a binding swap.
