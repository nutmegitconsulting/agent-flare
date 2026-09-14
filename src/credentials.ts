/**
 * Credentials store (V9) — KV-backed, OUT of the backup R2 bucket.
 *
 * Rationale: the R2 bucket (BACKUP_BUCKET) is replicated to third-party
 * backup storage. Anything stored there must be assumed to leak eventually.
 * Usable credentials therefore live in a dedicated KV namespace
 * (CREDENTIALS_KV), which is never included in the backup path.
 *
 * Migrated keys (values unchanged from their R2 json):
 *   cred:tunnel:<userId>     { hostname, token }        (was cloudflared/creds.json)
 *   cred:session:<userId>    { token }                  (was session-token.json)
 *   cred:gwjwt:<userId>      { jwt, storedAt }          (was gateway-jwt.json)
 *
 * Consistency note: KV is eventually consistent (~60s worst case). This is
 * acceptable because every one of these values is write-once-at-provision
 * and read on wake — there is no read-after-write flow inside a single
 * request path. If a provisioned user wakes within seconds of first
 * provision, the wake may see "not provisioned" once; the client retry
 * covers it. R2 stays authoritative for snapshots/backups only.
 */

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

// ---------------------------------------------------------------------------
// Tunnel credentials (was cloudflared/creds.json)
// ---------------------------------------------------------------------------

export async function getTunnelCreds(
  kv: KVNamespace,
  userId: string
): Promise<TunnelCreds | null> {
  const raw = await kv.get(key("tunnel", userId));
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Partial<TunnelCreds>;
    if (data.hostname && data.token) return { hostname: data.hostname, token: data.token };
    return null;
  } catch {
    return null;
  }
}

export async function putTunnelCreds(
  kv: KVNamespace,
  userId: string,
  creds: TunnelCreds
): Promise<void> {
  await kv.put(key("tunnel", userId), JSON.stringify(creds));
}

// ---------------------------------------------------------------------------
// Dashboard session token (was session-token.json)
// ---------------------------------------------------------------------------

export async function getSessionToken(
  kv: KVNamespace,
  userId: string
): Promise<string | null> {
  const raw = await kv.get(key("session", userId));
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as { token?: string };
    return data.token ?? null;
  } catch {
    return null;
  }
}

export async function putSessionToken(
  kv: KVNamespace,
  userId: string,
  token: string
): Promise<void> {
  await kv.put(key("session", userId), JSON.stringify({ token }));
}

// ---------------------------------------------------------------------------
// Gateway JWT (was gateway-jwt.json)
// ---------------------------------------------------------------------------

export async function getGatewayJwt(
  kv: KVNamespace,
  userId: string
): Promise<GatewayJwtCreds | null> {
  const raw = await kv.get(key("gwjwt", userId));
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Partial<GatewayJwtCreds>;
    return data.jwt ? { jwt: data.jwt, storedAt: data.storedAt ?? "" } : null;
  } catch {
    return null;
  }
}

export async function putGatewayJwt(
  kv: KVNamespace,
  userId: string,
  jwt: string
): Promise<void> {
  await kv.put(key("gwjwt", userId), JSON.stringify({ jwt, storedAt: new Date().toISOString() }));
}
