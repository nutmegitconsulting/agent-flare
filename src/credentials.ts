/**
 * Provider keys an admin sets. Write-only for the admin: nothing here returns a value to a browser, the
 * admin API or a log. At boot a key is written to that user's .env, as provider credentials always are.
 *
 * Order: the user's own > the role's > the Worker secret the provider names. Sealed values live in KV with
 * the MASTER_KEY design. Each carries its last-changed time as KV metadata, readable without decrypting.
 */
import type { Env } from "./env";
import type { GatewayProviderEntry } from "./providers";
import { seal, unseal } from "./secrets";
import { templateSecrets } from "./templates";

export const DEFAULT_CREDENTIAL = "CLOUDFLARE_AI_API_TOKEN";

export type KeyScope = { kind: "user"; email: string } | { kind: "role"; role: string };
export interface KeyStatus {
  source: "user" | "role" | "worker-secret" | "none";
  changedAt: string | null;
}

export const keyKvKey = (scope: KeyScope, provider: string) =>
  scope.kind === "user"
    ? `sealed:provider-key:user:${scope.email.toLowerCase()}:${provider}`
    : `sealed:provider-key:role:${scope.role}:${provider}`;

export async function setProviderKey(env: Env, scope: KeyScope, provider: string, value: string): Promise<void> {
  const key = keyKvKey(scope, provider);
  await env.CREDENTIALS_KV.put(key, await seal(env.MASTER_KEY, key, value), {
    metadata: { changedAt: new Date().toISOString() },
  });
}

export async function clearProviderKey(env: Env, scope: KeyScope, provider: string): Promise<void> {
  await env.CREDENTIALS_KV.delete(keyKvKey(scope, provider));
}

/** The Worker secret a provider names. Listed names only, and never MASTER_KEY. */
function workerSecret(env: Env, entry: GatewayProviderEntry): string {
  const name = entry.credential ?? (entry.mode === "api_token" ? DEFAULT_CREDENTIAL : "");
  if (!name || name === "MASTER_KEY") return "";
  if (name === DEFAULT_CREDENTIAL) return env.CLOUDFLARE_AI_API_TOKEN ?? "";
  const value = templateSecrets(env)[name];
  return typeof value === "string" ? value : "";
}

async function sealedStatus(env: Env, scope: KeyScope, provider: string): Promise<string | null | undefined> {
  const { value, metadata } = await env.CREDENTIALS_KV.getWithMetadata<{ changedAt?: string }>(keyKvKey(scope, provider));
  return value === null ? undefined : (metadata?.changedAt ?? null);
}

export async function keyStatus(
  env: Env, email: string | null, role: string | null, entry: GatewayProviderEntry,
): Promise<KeyStatus> {
  if (email) {
    const changedAt = await sealedStatus(env, { kind: "user", email }, entry.name);
    if (changedAt !== undefined) return { source: "user", changedAt };
  }
  if (role) {
    const changedAt = await sealedStatus(env, { kind: "role", role }, entry.name);
    if (changedAt !== undefined) return { source: "role", changedAt };
  }
  return { source: workerSecret(env, entry) ? "worker-secret" : "none", changedAt: null };
}

/** For hydration only: the result goes to the user's .env. */
export async function resolveProviderKey(
  env: Env, email: string, role: string | null, entry: GatewayProviderEntry,
): Promise<string> {
  const scopes: KeyScope[] = [{ kind: "user", email }, ...(role ? [{ kind: "role", role } as KeyScope] : [])];
  for (const scope of scopes) {
    const key = keyKvKey(scope, entry.name);
    const sealed = await env.CREDENTIALS_KV.get(key);
    if (sealed) return unseal(env.MASTER_KEY, key, sealed);
  }
  return workerSecret(env, entry);
}

/**
 * Environment variables an admin sets by name, with no role or provider involved: for everyone ("base")
 * or for one user. Sealed like provider keys, and likewise never returned to a browser. At boot they are
 * written to the user's .env. Order: base < the role's values < the user's own.
 */
export type EnvScope = { kind: "base" } | { kind: "user"; email: string };
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const envPrefix = (scope: EnvScope) =>
  scope.kind === "base" ? "sealed:env:base:" : `sealed:env:user:${scope.email.toLowerCase()}:`;

export async function setEnvValue(env: Env, scope: EnvScope, name: string, value: string): Promise<void> {
  const key = envPrefix(scope) + name;
  await env.CREDENTIALS_KV.put(key, await seal(env.MASTER_KEY, key, value), {
    metadata: { changedAt: new Date().toISOString() },
  });
}

export async function clearEnvValue(env: Env, scope: EnvScope, name: string): Promise<void> {
  await env.CREDENTIALS_KV.delete(envPrefix(scope) + name);
}

/** Names and last-changed times in a scope. No values. */
export async function envStatuses(env: Env, scope: EnvScope): Promise<Record<string, string | null>> {
  const prefix = envPrefix(scope);
  const found: Record<string, string | null> = {};
  let cursor: string | undefined;
  do {
    const page = await env.CREDENTIALS_KV.list<{ changedAt?: string }>({ prefix, cursor });
    for (const key of page.keys) found[key.name.slice(prefix.length)] = key.metadata?.changedAt ?? null;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return Object.fromEntries(Object.entries(found).sort(([a], [b]) => a.localeCompare(b)));
}

async function envValues(env: Env, scope: EnvScope): Promise<Record<string, string>> {
  const prefix = envPrefix(scope);
  const pairs = await Promise.all(Object.keys(await envStatuses(env, scope)).map(async (name) => {
    const sealed = await env.CREDENTIALS_KV.get(prefix + name);
    return sealed ? ([name, await unseal(env.MASTER_KEY, prefix + name, sealed)] as const) : null;
  }));
  return Object.fromEntries(pairs.filter((pair): pair is readonly [string, string] => pair !== null));
}

/** For hydration only: the results go to the user's .env. */
export async function resolveEnv(env: Env, email: string): Promise<{ base: Record<string, string>; user: Record<string, string> }> {
  const [base, user] = await Promise.all([envValues(env, { kind: "base" }), envValues(env, { kind: "user", email })]);
  return { base, user };
}

/**
 * Everything key-shaped that only applies at boot, as statuses: what the fingerprint compares to tell
 * whether a running container is behind. The shape is the provider statuses alone while no variable is
 * set by name, so adding this changed nobody's fingerprint.
 */
export async function bootKeyStatuses(
  env: Env, email: string, role: string | null, entries: GatewayProviderEntry[],
): Promise<Record<string, unknown>> {
  const [providers, base, user] = await Promise.all([
    keyStatuses(env, email, role, entries), envStatuses(env, { kind: "base" }), envStatuses(env, { kind: "user", email }),
  ]);
  return {
    ...providers,
    ...(Object.keys(base).length ? { "env:base": base } : {}),
    ...(Object.keys(user).length ? { "env:user": user } : {}),
  };
}

/** Status for every provider, for showing and for telling whether a key changed since boot. */
export async function keyStatuses(
  env: Env, email: string, role: string | null, entries: GatewayProviderEntry[],
): Promise<Record<string, KeyStatus>> {
  const pairs = await Promise.all(entries.map(async (e) => [e.name, await keyStatus(env, email, role, e)] as const));
  return Object.fromEntries(pairs);
}
