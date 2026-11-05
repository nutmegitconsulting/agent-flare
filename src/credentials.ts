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

/** Status for every provider, for showing and for telling whether a key changed since boot. */
export async function keyStatuses(
  env: Env, email: string, role: string | null, entries: GatewayProviderEntry[],
): Promise<Record<string, KeyStatus>> {
  const pairs = await Promise.all(entries.map(async (e) => [e.name, await keyStatus(env, email, role, e)] as const));
  return Object.fromEntries(pairs);
}
