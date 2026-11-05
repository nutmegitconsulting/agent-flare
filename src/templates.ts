/**
 * Config templates: named sets of Hermes config files assigned to users, so a user's first
 * launch is already filled in.
 *
 * R2 layout (BACKUP_BUCKET), uploaded with scripts/templates.mjs:
 *   config/assignments.json             who gets which template
 *   templates/<name>/template.json      defaults, managed keys, env, providers, file list
 *   templates/<name>/files/<path>       files copied into HERMES_HOME
 *
 * template.json:
 *   files              relative paths, copied on first launch unless the file already exists
 *   mode               optional map of path -> POSIX mode
 *   config_defaults    config.yaml values set on first launch; the user can change them later
 *   config_managed     config.yaml values reapplied on every boot; these always win
 *   env                .env values reapplied on every boot. "$NAME" reads Worker secret NAME, which
 *                      must be listed in the TEMPLATE_SECRETS var.
 *   providers          AI Gateway custom providers (see providers.ts)
 *
 * No secret values belong in R2. Use "$NAME" for shared ones and prefill for per-user ones.
 */
import { validateProviders, type GatewayProviderEntry } from "./providers";

export interface Assignments {
  /** Template for anyone not matched below. Omit for no template. */
  default?: string;
  /** Exact email -> template. Checked first. */
  users?: Record<string, string>;
  /** Access group name -> template. First match wins; needs an identity lookup. */
  groups?: Record<string, string>;
  /** Email domain -> template. */
  domains?: Record<string, string>;
}

export interface TemplateDefinition {
  files?: string[];
  mode?: Record<string, number>;
  config_defaults?: Record<string, unknown>;
  config_managed?: Record<string, unknown>;
  env?: Record<string, string>;
  providers?: unknown;
}

export interface ResolvedTemplate {
  name: string;
  files: { path: string; content: string; mode?: number }[];
  configDefaults: Record<string, unknown>;
  configManaged: Record<string, unknown>;
  env: Record<string, string>;
  providers: GatewayProviderEntry[];
  warnings: string[];
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function pickTemplate(
  assignments: Assignments | null, email: string, groups: string[] = [],
): string | null {
  if (!assignments) return null;
  const lower = email.toLowerCase();
  for (const [user, template] of Object.entries(assignments.users ?? {})) {
    if (user.toLowerCase() === lower) return template;
  }
  for (const group of groups) {
    const template = assignments.groups?.[group];
    if (template) return template;
  }
  const domain = lower.split("@")[1];
  for (const [candidate, template] of Object.entries(assignments.domains ?? {})) {
    if (candidate.toLowerCase() === domain) return template;
  }
  return assignments.default ?? null;
}

/**
 * The user's Access groups, when assignments use them. Access only exposes these through the
 * identity endpoint. Best effort: a failed lookup falls through to the domain and default rules.
 */
export async function fetchAccessGroups(
  issuer: string, jwt: string, fetcher: typeof fetch = fetch,
): Promise<string[]> {
  try {
    const response = await fetcher(`${issuer}/cdn-cgi/access/get-identity`, {
      headers: { cookie: `CF_Authorization=${jwt}` },
    });
    if (!response.ok) return [];
    const identity = (await response.json()) as { groups?: { name?: string }[] };
    return (identity.groups ?? []).map((g) => g.name ?? "").filter(Boolean);
  } catch {
    return [];
  }
}

function isSafePath(path: string): boolean {
  return !!path && !path.startsWith("/") && !path.split("/").includes("..") && !path.includes("\0");
}

/**
 * The secrets templates may reference. An allowlist because R2 is documented as secret-free, so write
 * access to it must not be a way to read MASTER_KEY into a container.
 */
export function templateSecrets(env: { TEMPLATE_SECRETS?: string }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of (env.TEMPLATE_SECRETS ?? "").split(",").map((n) => n.trim()).filter(Boolean)) {
    if (name !== "MASTER_KEY") out[name] = (env as Record<string, unknown>)[name];
  }
  return out;
}

/** Replace "$NAME" with the Worker secret NAME. Unset or unlisted secrets are dropped and reported. */
export function resolveEnv(
  env: Record<string, string>, secrets: Record<string, unknown>, warnings: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || /[\r\n]/.test(value)) {
      warnings.push(`env ${key}: invalid name or value; skipped`);
      continue;
    }
    if (value.startsWith("$")) {
      const secret = secrets[value.slice(1)];
      if (typeof secret !== "string" || !secret) {
        warnings.push(`env ${key}: Worker secret ${value.slice(1)} is not set or not in TEMPLATE_SECRETS; skipped`);
        continue;
      }
      out[key] = secret;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function toB64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export async function loadAssignments(bucket: R2Bucket): Promise<Assignments | null> {
  const object = await bucket.get("config/assignments.json");
  if (!object) return null;
  return (await object.json()) as Assignments;
}

export async function loadTemplate(
  bucket: R2Bucket, name: string, secrets: Record<string, unknown>,
): Promise<ResolvedTemplate | null> {
  if (!NAME_RE.test(name)) throw new Error(`invalid template name ${JSON.stringify(name)}`);
  const object = await bucket.get(`templates/${name}/template.json`);
  if (!object) return null;
  const definition = (await object.json()) as TemplateDefinition;
  const warnings: string[] = [];

  const files: ResolvedTemplate["files"] = [];
  for (const path of definition.files ?? []) {
    if (!isSafePath(path)) {
      warnings.push(`file ${path}: unsafe path; skipped`);
      continue;
    }
    const file = await bucket.get(`templates/${name}/files/${path}`);
    if (!file) {
      warnings.push(`file ${path}: not in R2; skipped`);
      continue;
    }
    files.push({
      path,
      content: toB64(new Uint8Array(await file.arrayBuffer())),
      ...(definition.mode?.[path] !== undefined ? { mode: definition.mode[path] } : {}),
    });
  }

  let providers: GatewayProviderEntry[] = [];
  if (definition.providers !== undefined) {
    const parsed = validateProviders(definition.providers);
    if (parsed.ok) providers = parsed.entries;
    else warnings.push(`providers: ${parsed.error}`);
  }

  return {
    name,
    files,
    configDefaults: definition.config_defaults ?? {},
    configManaged: definition.config_managed ?? {},
    env: resolveEnv(definition.env ?? {}, secrets, warnings),
    providers,
    warnings,
  };
}
