/**
 * Cloudflare Access JWT verification.
 *
 * Every request carries Cf-Access-Jwt-Assertion. The identity in it decides whose
 * container the request reaches, so the signature is checked, not just the claims.
 * Nothing else is trusted: no opaque-token fallback, no identity headers.
 */

export interface AccessIdentity {
  /** Stable Access user ID. Sandbox key. Never derived from the email address. */
  sub: string;
  email: string;
  name?: string;
  issuer: string;
}

export interface AccessConfig {
  teamDomain: string;
  audience: string;
  /** Test seam: the JWKS as JSON instead of fetching it. See ALLOW_TEST_JWKS in env.ts. */
  jwksJson?: string;
  fetcher?: typeof fetch;
  now?: () => number;
}

export class AccessError extends Error {}

interface Jwk extends JsonWebKey {
  kid?: string;
}

const JWKS_TTL_MS = 5 * 60_000;
const CLOCK_SKEW_SECONDS = 60;
const jwksCache = new Map<string, { keys: Jwk[]; fetchedAt: number }>();

function decodePart<T>(part: string): T {
  const padded = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

function signatureBytes(part: string): Uint8Array {
  const padded = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

async function loadKeys(config: AccessConfig, issuer: string, refresh: boolean): Promise<Jwk[]> {
  if (config.jwksJson) return (JSON.parse(config.jwksJson) as { keys: Jwk[] }).keys;
  const now = (config.now ?? Date.now)();
  const cached = jwksCache.get(issuer);
  if (!refresh && cached && now - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;
  const response = await (config.fetcher ?? fetch)(`${issuer}/cdn-cgi/access/certs`);
  if (!response.ok) throw new AccessError(`could not fetch Access signing keys (${response.status})`);
  const { keys } = (await response.json()) as { keys: Jwk[] };
  jwksCache.set(issuer, { keys, fetchedAt: now });
  return keys;
}

/** Throws AccessError unless the token is a valid Access token for this application. */
export async function verifyAccessJwt(token: string, config: AccessConfig): Promise<AccessIdentity> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new AccessError("malformed token");
  if (!config.teamDomain || !config.audience) {
    throw new AccessError("ACCESS_TEAM_DOMAIN and ACCESS_AUD_TAG must be configured");
  }
  const issuer = `https://${config.teamDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;

  let header: { alg?: string; kid?: string };
  let claims: {
    iss?: string; aud?: string | string[]; sub?: string; email?: string; name?: string;
    exp?: number; nbf?: number;
  };
  try {
    header = decodePart(parts[0]);
    claims = decodePart(parts[1]);
  } catch {
    throw new AccessError("malformed token");
  }

  // Pinned, so a token can't choose its own algorithm.
  if (header.alg !== "RS256") throw new AccessError("unsupported signing algorithm");

  let keys = await loadKeys(config, issuer, false);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await loadKeys(config, issuer, true); // Access rotated its keys.
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new AccessError("unknown signing key");

  const key = await crypto.subtle.importKey(
    "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, signatureBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!valid) throw new AccessError("invalid signature");

  // Claims are only meaningful once the signature holds.
  if (claims.iss !== issuer) throw new AccessError("wrong issuer");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(config.audience)) throw new AccessError("wrong audience");
  const now = Math.floor((config.now ?? Date.now)() / 1000);
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SECONDS < now) throw new AccessError("expired");
  if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_SECONDS > now) throw new AccessError("not yet valid");
  // Service tokens have an empty sub. They have no user, so they get no container.
  if (!claims.sub || !claims.email) throw new AccessError("token has no user identity");

  return { sub: claims.sub, email: claims.email.toLowerCase(), name: claims.name, issuer };
}

/** For tests. */
export function clearJwksCache(): void {
  jwksCache.clear();
}
