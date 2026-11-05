/**
 * What a user's configuration is right now. One answer, used by hydration and the admin screens, so they
 * can't disagree.
 *
 * A role is a template; assigning a role is an entry in assignments.users. Precedence:
 *   per-user override (config/overrides/<email>.json) > role > group, domain and default assignments.
 *
 * Non-secret only. R2 holds no key values; those are sealed in KV (see credentials.ts).
 */
import type { GatewayProviderEntry, ModelTiers } from "./providers";
import { loadAssignments, loadTemplate, pickTemplate, type ResolvedTemplate } from "./templates";

export interface UserOverride {
  /** Role to use instead of what assignments say. */
  role?: string;
  /** Gateway for this user's api_token providers. */
  gateway_id?: string;
  /** Replaces the role's list of models shown in the picker. */
  models?: string[];
  /** Model selected for this user, until they choose another. */
  default_model?: string;
}

export type RoleSource = "override" | "role" | "assignment" | "none";

export interface Effective {
  role: string | null;
  source: RoleSource;
  override: UserOverride | null;
  template: ResolvedTemplate | null;
  providers: GatewayProviderEntry[];
}

export const overrideKey = (email: string) => `config/overrides/${email.toLowerCase()}.json`;

export async function loadOverride(bucket: R2Bucket, email: string): Promise<UserOverride | null> {
  const object = await bucket.get(overrideKey(email));
  return object ? ((await object.json()) as UserOverride) : null;
}

/** A gateway ID also sits in the path of an AI Gateway URL, and the two must match. */
export function withGateway(baseUrl: string, gateway: string): string {
  return baseUrl.replace(/^(https:\/\/gateway\.ai\.cloudflare\.com\/v1\/[^/]+\/)[^/]+/, `$1${gateway}`);
}

export function applyOverride(entries: GatewayProviderEntry[], override: UserOverride | null): GatewayProviderEntry[] {
  if (!override) return entries;
  return entries.map((entry) => {
    const next = { ...entry };
    if (override.gateway_id && entry.mode === "api_token") {
      next.gateway_id = override.gateway_id;
      next.base_url = withGateway(entry.base_url, override.gateway_id);
    }
    if (override.models?.length) {
      next.models = Object.fromEntries(override.models.map((id) => [id, entry.models[id] ?? {}]));
      if (next.model && !override.models.includes(next.model)) next.model = undefined;
    }
    if (override.default_model && override.default_model in next.models) next.model = override.default_model;
    return next;
  });
}

export async function resolveEffective(
  bucket: R2Bucket, email: string, groups: string[], secrets: Record<string, unknown>,
): Promise<Effective> {
  const override = await loadOverride(bucket, email);
  const assignments = await loadAssignments(bucket);
  let role: string | null;
  let source: RoleSource;
  if (override?.role) {
    role = override.role;
    source = "override";
  } else {
    role = pickTemplate(assignments, email, groups);
    const direct = Object.keys(assignments?.users ?? {}).some((u) => u.toLowerCase() === email.toLowerCase());
    source = !role ? "none" : direct ? "role" : "assignment";
  }
  const template = role ? await loadTemplate(bucket, role, secrets) : null;
  return { role, source, override, template, providers: applyOverride(template?.providers ?? [], override) };
}

/** Changes when something that only applies at boot changes. Holds no secret values. */
export async function configFingerprint(effective: Effective, keys: unknown = null, tiers: ModelTiers = {}): Promise<string> {
  const t = effective.template;
  const shown = effective.providers.flatMap((p) => Object.keys(p.models)).sort().map((id) => [id, tiers[id] ?? null]);
  const text = JSON.stringify({
    keys,
    tiers: shown,
    role: effective.role,
    providers: effective.providers,
    managed: t?.configManaged ?? null,
    defaults: t?.configDefaults ?? null,
    env: Object.keys(t?.env ?? {}).sort(),
    files: (t?.files ?? []).map((f) => f.path).sort(),
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
