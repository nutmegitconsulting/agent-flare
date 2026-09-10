import type { Sandbox } from "@cloudflare/sandbox";

/**
 * Per-user AI Gateway custom providers (V8).
 *
 * Renders the worker-owned `custom_providers:` section of the container's
 * $HERMES_HOME/config.yaml + the matching key_env entries in .env, from
 * per-user R2 data. Two auth modes per provider entry:
 *
 * - `jwt`: the user's Cloudflare Access JWT is the credential. The gateway
 *   has a custom domain + Access enabled; the Access edge verifies the JWT
 *   sent as `Authorization: Bearer *** (exactly what hermes' openai client
 *   does with a key_env value) and attaches cf.user_id itself (derived from
 *   the JWT sub claim — never client-supplied). No custom headers needed.
 * - `api_token`: the account-scoped REST endpoint
 *   (api.cloudflare.com/client/v4/accounts/<ID>/ai/v1). The credential is a
 *   CF API token with Workers AI:Read — stored as the WORKER secret
 *   CLOUDFLARE_AI_API_TOKEN (account-level, least privilege, shared across
 *   users) and routed per user via the cf-aig-gateway-id header.
 *
 * R2 layout (BACKUP_BUCKET):
 *   users/<userId>/providers.json   worker-managed config (no secrets inside)
 *   users/<userId>/gateway-jwt.json session credential for the jwt-mode entry
 *                                    (short-lived by nature — client re-sends
 *                                    it on setup; no refresh machinery)
 */

export interface ProviderModelInfo {
  context_length?: number;
  max_length?: number;
}

export interface GatewayProviderEntry {
  /** Display name — must match the model prefix `@<name>/`. */
  name: string;
  /** `jwt` (custom domain, Access) or `api_token` (account-scoped endpoint). */
  mode: "jwt" | "api_token";
  /** jwt mode: `https://<gateway-custom-domain>/openai/v1`.
   *  api_token mode: `https://api.cloudflare.com/client/v4/accounts/<ID>/ai/v1`. */
  base_url: string;
  /** .env variable name holding the credential. Entries must not collide. */
  key_env: string;
  /** api_token mode only: gateway slug for the cf-aig-gateway-id header. */
  gateway_id?: string;
  /** Wire protocol. Default `chat_completions`. Valid: chat_completions,
   *  responses, anthropic, bedrock_converse, auto. */
  api_mode?: string;
  /** Pass model discovery through to hermes. Default `false`. */
  discover_models?: boolean;
  /** Extra HTTP headers (jwt mode: none expected; api_token mode: the
   *  cf-aig-gateway-id header is added automatically from gateway_id). */
  extra_headers?: Record<string, string>;
  /** Model id -> context/max length. */
  models: Record<string, ProviderModelInfo>;
  /** Per-entry default model — rendered as `model:` inside the entry (the
   *  field hermes' _VALID_CUSTOM_PROVIDER_FIELDS actually accepts). The
   *  first entry's value also seeds the top-level `model:` if the
   *  container's config has none. */
  model?: string;
}

const PROVIDERS_KEY_SUFFIX = "providers.json";
const JWT_KEY_SUFFIX = "gateway-jwt.json";
const CONFIG_YAML = "/home/hermes/.hermes/config.yaml";
const ENV_FILE = "/home/hermes/.hermes/.env";
const BANNER = "# >>> hermes-cloudflare worker-managed custom_providers (do not edit)";
const BANNER_END = "# <<< end worker-managed custom_providers";

function keysFor(userId: string) {
  return {
    providers: `users/${userId}/${PROVIDERS_KEY_SUFFIX}`,
    jwt: `users/${userId}/${JWT_KEY_SUFFIX}`,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const MODES = new Set(["jwt", "api_token"]);
const API_MODES = new Set(["chat_completions", "responses", "anthropic", "bedrock_converse", "auto"]);
const ENV_VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function validateProviders(data: unknown): { ok: true; entries: GatewayProviderEntry[] } | { ok: false; error: string } {
  if (!Array.isArray(data)) return { ok: false, error: "body must be a JSON array of provider entries" };
  if (data.length === 0) return { ok: false, error: "provider list must not be empty" };
  const entries: GatewayProviderEntry[] = [];
  const seenKeyEnv = new Set<string>();
  for (let i = 0; i < data.length; i++) {
    const e = data[i] as Partial<GatewayProviderEntry>;
    const at = (n: number) => `entry[${n}]`;
    if (typeof e !== "object" || e === null) return { ok: false, error: `${at(i)} must be an object` };
    if (typeof e.name !== "string" || !e.name.trim()) return { ok: false, error: `${at(i)}.name is required (string)` };
    if (e.mode !== "jwt" && e.mode !== "api_token") return { ok: false, error: `${at(i)}.mode must be "jwt" or "api_token"` };
    if (typeof e.base_url !== "string" || !/^https:\/\//.test(e.base_url)) return { ok: false, error: `${at(i)}.base_url must be an https:// URL` };
    if (typeof e.key_env !== "string" || !ENV_VAR_RE.test(e.key_env)) return { ok: false, error: `${at(i)}.key_env must be a valid env var name` };
    if (seenKeyEnv.has(e.key_env)) return { ok: false, error: `${at(i)}.key_env "${e.key_env}" is used by more than one entry` };
    seenKeyEnv.add(e.key_env);
    if (e.mode === "api_token" && (typeof e.gateway_id !== "string" || !e.gateway_id.trim())) {
      return { ok: false, error: `${at(i)}.gateway_id is required for mode=api_token` };
    }
    if (e.api_mode !== undefined && (typeof e.api_mode !== "string" || !API_MODES.has(e.api_mode))) {
      return { ok: false, error: `${at(i)}.api_mode must be one of: ${[...API_MODES].join(", ")}` };
    }
    if (e.discover_models !== undefined && typeof e.discover_models !== "boolean") {
      return { ok: false, error: `${at(i)}.discover_models must be a boolean` };
    }
    if (e.extra_headers !== undefined && (typeof e.extra_headers !== "object" || e.extra_headers === null || Array.isArray(e.extra_headers))) {
      return { ok: false, error: `${at(i)}.extra_headers must be a string->string object` };
    }
    if (typeof e.models !== "object" || e.models === null || Array.isArray(e.models) || Object.keys(e.models).length === 0) {
      return { ok: false, error: `${at(i)}.models must be a non-empty object` };
    }
    entries.push({
      name: e.name.trim(),
      mode: e.mode as "jwt" | "api_token",
      base_url: e.base_url,
      key_env: e.key_env,
      ...(e.gateway_id ? { gateway_id: e.gateway_id.trim() } : {}),
      ...(e.api_mode ? { api_mode: e.api_mode } : {}),
      ...(e.discover_models !== undefined ? { discover_models: e.discover_models } : {}),
      ...(e.extra_headers ? { extra_headers: e.extra_headers as Record<string, string> } : {}),
      models: e.models as Record<string, ProviderModelInfo>,
      ...(e.model ? { model: e.model } : {}),
    });
  }
  return { ok: true, entries };
}

// ---------------------------------------------------------------------------
// R2 storage (no secrets ever stored here — only config + the session JWT)
// ---------------------------------------------------------------------------

export async function loadProviders(bucket: R2Bucket, userId: string): Promise<GatewayProviderEntry[] | null> {
  const obj = await bucket.get(keysFor(userId).providers);
  if (!obj) return null;
  const parsed = validateProviders(await obj.json().catch(() => null));
  if (!parsed.ok) return null; // corrupt/legacy file — treat as absent, log at call site
  return parsed.entries;
}

export async function saveProviders(bucket: R2Bucket, userId: string, entries: GatewayProviderEntry[]): Promise<void> {
  await bucket.put(keysFor(userId).providers, JSON.stringify(entries, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
}

export async function storeGatewayJwt(bucket: R2Bucket, userId: string, jwt: string): Promise<void> {
  await bucket.put(keysFor(userId).jwt, JSON.stringify({ jwt, updatedAt: new Date().toISOString() }), {
    httpMetadata: { contentType: "application/json" },
  });
}

export async function loadGatewayJwt(bucket: R2Bucket, userId: string): Promise<string | null> {
  const obj = await bucket.get(keysFor(userId).jwt);
  if (!obj) return null;
  try {
    const data = await obj.json() as { jwt?: string };
    return data.jwt || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// YAML rendering
// ---------------------------------------------------------------------------

function yamlScalar(v: unknown): string {
  const s = String(v);
  if (/^[A-Za-z0-9._@/-]+$/.test(s) && !/^\d+$/.test(s)) return s;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Render the worker-managed custom_providers block (2-space base indent). */
export function renderCustomProviders(entries: GatewayProviderEntry[], env: { aiApiToken: string; gatewayJwt: string | null }): {
  yaml: string;
  envLines: Record<string, string>;
  defaultModel: string | null;
  errors: string[];
} {
  const lines: string[] = [BANNER, "custom_providers:"];
  const envLines: Record<string, string> = {};
  const errors: string[] = [];
  let defaultModel: string | null = null;
  for (const e of entries) {
    let credential: string;
    switch (e.mode) {
      case "jwt":
        credential = env.gatewayJwt || "";
        break;
      case "api_token":
        credential = env.aiApiToken;
        break;
    }
    if (!credential) {
      errors.push(
        e.mode === "jwt"
          ? `provider "${e.name}" (jwt): no Access JWT on file — set it with POST /api/admin/gateway-jwt; entry skipped`
          : `provider "${e.name}" (api_token): worker secret CLOUDFLARE_AI_API_TOKEN not set; entry skipped`,
      );
      continue;
    }
    envLines[e.key_env] = credential;
    lines.push(`  - name: ${yamlScalar(e.name)}`);
    lines.push(`    base_url: ${yamlScalar(e.base_url)}`);
    lines.push(`    key_env: ${yamlScalar(e.key_env)}`);
    if (e.model) lines.push(`    model: ${yamlScalar(e.model)}`);
    lines.push(`    api_mode: ${yamlScalar(e.api_mode || "chat_completions")}`);
    lines.push(`    discover_models: ${e.discover_models === true ? "true" : "false"}`);
    const headers: Record<string, string> = { ...e.extra_headers };
    if (e.mode === "api_token" && e.gateway_id) headers["cf-aig-gateway-id"] = e.gateway_id;
    if (Object.keys(headers).length) {
      lines.push(`    extra_headers:`);
      for (const [k, v] of Object.entries(headers)) lines.push(`      ${yamlScalar(k)}: ${yamlScalar(v)}`);
    }
    lines.push(`    models:`);
    for (const [modelId, info] of Object.entries(e.models)) {
      const fields: string[] = [];
      if (typeof info?.context_length === "number") fields.push(`context_length: ${info.context_length}`);
      if (typeof info?.max_length === "number") fields.push(`max_length: ${info.max_length}`);
      if (fields.length === 0) continue;
      lines.push(`      ${yamlScalar(modelId)}:`);
      for (const f of fields) lines.push(`        ${f}`);
    }
    if (e.model && !defaultModel) defaultModel = e.model;
  }
  lines.push(BANNER_END);
  return { yaml: lines.join("\n"), envLines, defaultModel, errors };
}

/**
 * Replace (or append) the bannered custom_providers section. Everything
 * outside the banner is preserved byte-for-byte.
 */
export function mergeCustomProvidersSection(configYaml: string, newSection: string): string {
  const lines = configYaml.split("\n");
  const start = lines.indexOf(BANNER);
  const end = lines.indexOf(BANNER_END);
  if (start !== -1 && end !== -1 && end >= start) {
    const next = [...lines.slice(0, start), newSection, ...lines.slice(end + 1)];
    return next.join("\n");
  }
  const base = configYaml.replace(/\n*$/, "");
  return `${base ? base + "\n" : ""}\n${newSection}\n`;
}

// ---------------------------------------------------------------------------
// Injection into the container
// ---------------------------------------------------------------------------

export interface InjectResult {
  providersIngested: number;
  providersWritten: number;
  errors: string[];
}

/**
 * Merge providers into the container's config.yaml + .env.
 *
 * Called from /api/wake AFTER restoreLatest and BEFORE the /tmp/restore-done
 * marker, so `hermes serve` never starts without its provider section.
 * A failure here must not fail the wake — the caller try/catches and
 * surfaces `providersError` in the response (container boots without the
 * custom providers, same as today).
 */
export async function injectProviders(sandbox: Sandbox, bucket: R2Bucket, userId: string, aiApiToken: string): Promise<InjectResult> {
  const stored = await loadProviders(bucket, userId);
  if (!stored) return { providersIngested: 0, providersWritten: 0, errors: [] };

  const gatewayJwt = await loadGatewayJwt(bucket, userId);
  const { yaml, envLines, defaultModel, errors } = renderCustomProviders(stored, { aiApiToken, gatewayJwt });

  if (Object.keys(envLines).length === 0) {
    // Nothing injectable (e.g. jwt configured but no JWT delivered yet).
    return { providersIngested: stored.length, providersWritten: 0, errors };
  }

  // 1. config.yaml — read, merge the bannered section, write back (SDK
  //    writeFile, same primitive as the restore-done marker).
  let config: string;
  try {
    const res = await sandbox.exec(`cat ${CONFIG_YAML} 2>/dev/null || true`);
    config = res.stdout || "";
  } catch (e: any) {
    throw new Error(`read ${CONFIG_YAML} failed: ${e?.message || e}`);
  }
  let merged = mergeCustomProvidersSection(config, yaml);
  if (defaultModel) {
    // Seed the TOP-LEVEL model (column 0) from the first entry's `model`
    // when the config has none — per-entry `    model:` lines are indented,
    // so the column-0 anchor is what distinguishes the two. A snapshot's
    // own top-level model always wins (never overridden).
    if (!/^model\s*:/m.test(merged)) {
      merged = `model: ${yamlScalar(defaultModel)}\n` + merged;
    }
  }
  await sandbox.writeFile(CONFIG_YAML, merged);

  // 2. .env — upsert each key_env with python3 (present in the image; avoids
  //    shell-quoting edge cases). Create the file if hermes hasn't run yet;
  //    the CMD's dashboard-token watcher appends to this same file, so
  //    upserts are idempotent.
  const py = `
import re
path = ${JSON.stringify(ENV_FILE)}
updates = ${JSON.stringify(envLines)}
try:
    with open(path) as f:
        lines = f.read().splitlines()
except FileNotFoundError:
    lines = []
# Drop any existing line for a key we are setting, then append the fresh
# value — unconditional, so a replaced key never vanishes.
out = [line for line in lines if not re.match(r"^(?:" + "|".join(re.escape(k) for k in updates) + r")=" , line)]
out.extend(k + "=" + v for k, v in updates.items())
with open(path, "w") as f:
    f.write("\\n".join(out) + "\\n")
print("OK", len(updates))
`;
  const e = await sandbox.exec(
    `mkdir -p /home/hermes/.hermes && python3 -c '${py.replace(/'/g, "'\\''")}' 2>&1 && ` +
      `chown hermes:hermes ${ENV_FILE} 2>/dev/null; chmod 600 ${ENV_FILE}; true`,
  );
  if (!/^OK \d+/m.test(e.stdout || "")) {
    throw new Error(`.env upsert failed: ${(e.stderr || e.stdout || "").trim()}`);
  }

  console.log(`[providers:${userId}] wrote ${Object.keys(envLines).length}/${stored.length} provider(s) into config.yaml + .env`);
  return { providersIngested: stored.length, providersWritten: Object.keys(envLines).length, errors };
}
