/**
 * Inference providers, delivered through config templates: what makes a user's first launch able to
 * answer without any setup.
 *
 * Validates a template's `providers` list and turns it into config.yaml `custom_providers` entries,
 * the .env values they read, and an ordered list of candidates. The container selects the first
 * candidate whose credential is present (af_state.py), because a listed provider isn't a selected one:
 * Hermes uses `model.provider`, and without it reports that no provider is connected.
 *
 * Credentials never go in the template:
 *
 * - `api_token`: the shared credential is the Worker secret CLOUDFLARE_AI_API_TOKEN. Requests are tagged
 *   with the gateway and the user through cf-aig-* headers.
 * - `user_env`: the value comes from .env: an admin prefill, the user's own value, or the template's
 *   `env` with "$NAME" reading a Worker secret.
 */

export interface ProviderModelInfo {
  context_length?: number;
  max_length?: number;
}

export interface GatewayProviderEntry {
  /** What `model.provider` names: lowercase letters, digits and dashes. */
  name: string;
  mode: "api_token" | "user_env";
  base_url: string;
  /** .env variable holding the credential. Entries must not collide. */
  key_env: string;
  /** api_token mode: gateway slug for the cf-aig-gateway-id header. */
  gateway_id?: string;
  /** Worker secret to use when no key is sealed for this user or role. api_token default: CLOUDFLARE_AI_API_TOKEN. */
  credential?: string;
  /** chat_completions (default), responses, anthropic, bedrock_converse or auto. */
  api_mode?: string;
  discover_models?: boolean;
  extra_headers?: Record<string, string>;
  models: Record<string, ProviderModelInfo>;
  /** Model to select. Defaults to the first of `models`. */
  model?: string;
}

/** A provider the container may select, once `key_env` has a value in .env. */
export interface ProviderCandidate {
  provider: string;
  model: string;
  key_env: string;
}

export type ModelTier = "low" | "medium" | "high";
export type ModelTiers = Record<string, ModelTier>;
/**
 * Our score for each model, shown as the first character of its name in Hermes's picker. Low is U+2212, the
 * minus sign, because Hermes's name formatting removes a leading hyphen.
 */
export const TIER_MARKS: Record<ModelTier, string> = { low: "\u2212", medium: "|", high: "+" };

/** The name a tiered model has in the picker. A Hermes model alias maps it back to the real ID. */
export function modelLabel(id: string, tier: ModelTier): string {
  return `${TIER_MARKS[tier]} ${id.split("/").pop()}`;
}

const API_MODES = new Set(["chat_completions", "responses", "anthropic", "bedrock_converse", "auto"]);
const ENV_VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** Hermes routes these names to its built-in provider, whatever the entry says. */
const BUILTIN_PROVIDER_NAMES = new Set([
  "ai-gateway", "anthropic", "bedrock", "custom", "deepseek", "gemini", "lmstudio", "minimax", "nous",
  "openai", "openai-codex", "openrouter", "xai",
]);
const CREDENTIAL_HEADER_RE = /authorization|api[-_]?key|token|secret|password/i;
/** A header that carries a credential has to read it from .env: config.yaml is backed up to R2. */
const ENV_REFERENCE_RE = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/;

export function validateProviders(
  data: unknown,
): { ok: true; entries: GatewayProviderEntry[] } | { ok: false; error: string } {
  if (!Array.isArray(data)) return { ok: false, error: "must be an array of provider entries" };
  const entries: GatewayProviderEntry[] = [];
  const seenKeyEnv = new Set<string>();
  for (let i = 0; i < data.length; i++) {
    const e = data[i] as Partial<GatewayProviderEntry>;
    const at = `entry[${i}]`;
    if (typeof e !== "object" || e === null) return { ok: false, error: `${at} must be an object` };
    if (typeof e.name !== "string" || !NAME_RE.test(e.name)) {
      return { ok: false, error: `${at}.name must be lowercase letters, digits and dashes` };
    }
    if (BUILTIN_PROVIDER_NAMES.has(e.name)) {
      return { ok: false, error: `${at}.name "${e.name}" is a Hermes built-in provider; choose another` };
    }
    if (e.mode !== "api_token" && e.mode !== "user_env") {
      return { ok: false, error: `${at}.mode must be "api_token" or "user_env"` };
    }
    if (typeof e.base_url !== "string" || !/^https:\/\//.test(e.base_url)) {
      return { ok: false, error: `${at}.base_url must be an https:// URL` };
    }
    if (typeof e.key_env !== "string" || !ENV_VAR_RE.test(e.key_env)) {
      return { ok: false, error: `${at}.key_env must be a valid env var name` };
    }
    if (seenKeyEnv.has(e.key_env)) return { ok: false, error: `${at}.key_env "${e.key_env}" is already used` };
    seenKeyEnv.add(e.key_env);
    if (e.mode === "api_token" && (typeof e.gateway_id !== "string" || !e.gateway_id.trim())) {
      return { ok: false, error: `${at}.gateway_id is required for mode=api_token` };
    }
    if (e.credential !== undefined && (typeof e.credential !== "string" || !ENV_VAR_RE.test(e.credential) || e.credential === "MASTER_KEY")) {
      return { ok: false, error: `${at}.credential must name a Worker secret other than MASTER_KEY` };
    }
    if (e.api_mode !== undefined && !API_MODES.has(e.api_mode)) {
      return { ok: false, error: `${at}.api_mode must be one of: ${[...API_MODES].join(", ")}` };
    }
    if (e.discover_models !== undefined && typeof e.discover_models !== "boolean") {
      return { ok: false, error: `${at}.discover_models must be a boolean` };
    }
    if (e.extra_headers !== undefined &&
        (typeof e.extra_headers !== "object" || e.extra_headers === null || Array.isArray(e.extra_headers))) {
      return { ok: false, error: `${at}.extra_headers must be an object` };
    }
    for (const [header, value] of Object.entries(e.extra_headers ?? {})) {
      if (typeof value !== "string") return { ok: false, error: `${at}.extra_headers.${header} must be a string` };
      if (CREDENTIAL_HEADER_RE.test(header) && !ENV_REFERENCE_RE.test(value)) {
        return { ok: false, error: `${at}.extra_headers.${header} looks like a credential; use "\${ENV_VAR}"` };
      }
    }
    if (typeof e.models !== "object" || e.models === null || Array.isArray(e.models) ||
        Object.keys(e.models).length === 0) {
      return { ok: false, error: `${at}.models must be a non-empty object` };
    }
    if (e.model !== undefined && !(e.model in e.models) && e.discover_models !== true) {
      return { ok: false, error: `${at}.model "${e.model}" is not in models` };
    }
    entries.push({
      name: e.name,
      mode: e.mode,
      base_url: e.base_url,
      key_env: e.key_env,
      ...(e.gateway_id ? { gateway_id: e.gateway_id.trim() } : {}),
      ...(e.credential ? { credential: e.credential } : {}),
      ...(e.api_mode ? { api_mode: e.api_mode } : {}),
      ...(e.discover_models !== undefined ? { discover_models: e.discover_models } : {}),
      ...(e.extra_headers ? { extra_headers: e.extra_headers } : {}),
      models: e.models,
      ...(e.model ? { model: e.model } : {}),
    });
  }
  return { ok: true, entries };
}

export interface RenderedProviders {
  customProviders: Record<string, unknown>[];
  env: Record<string, string>;
  /** config.yaml `model_aliases`: label -> the real model. */
  modelAliases: Record<string, { model: string; provider: string; base_url: string }>;
  candidates: ProviderCandidate[];
  warnings: string[];
}

/**
 * `user` tags api_token requests with the caller's identity (cf-aig-metadata), so AI Gateway
 * analytics and logs stay per user even though the credential is shared.
 * `keys` holds the resolved credential per provider name (see credentials.ts). They reach .env only.
 */
export function renderProviders(
  entries: GatewayProviderEntry[], keys: Record<string, string>, user: string, tiers: ModelTiers = {},
): RenderedProviders {
  const customProviders: Record<string, unknown>[] = [];
  const env: Record<string, string> = {};
  const warnings: string[] = [];
  const modelAliases: RenderedProviders["modelAliases"] = {};
  const candidates: ProviderCandidate[] = [];
  for (const e of entries) {
    if (e.mode === "api_token") {
      if (!keys[e.name]) {
        warnings.push(`provider "${e.name}": no key is set, and Worker secret ${e.credential ?? "CLOUDFLARE_AI_API_TOKEN"} is not set; skipped`);
        continue;
      }
      env[e.key_env] = keys[e.name];
    } else if (keys[e.name]) {
      env[e.key_env] = keys[e.name];
    }
    const headers: Record<string, string> = { ...e.extra_headers };
    if (e.mode === "api_token" && e.gateway_id) {
      headers["cf-aig-gateway-id"] = e.gateway_id;
      headers["cf-aig-metadata"] = JSON.stringify({ user });
    }
    const models: Record<string, ProviderModelInfo> = {};
    for (const [id, info] of Object.entries(e.models)) {
      const tier = tiers[id];
      const label = tier && TIER_MARKS[tier] ? modelLabel(id, tier) : id;
      models[label in modelAliases ? id : label] = info;
      if (label !== id && !(label in modelAliases)) modelAliases[label] = { model: id, provider: e.name, base_url: e.base_url };
    }
    customProviders.push({
      name: e.name,
      base_url: e.base_url,
      key_env: e.key_env,
      ...(e.model ? { model: e.model } : {}),
      api_mode: e.api_mode ?? "chat_completions",
      discover_models: e.discover_models === true,
      ...(Object.keys(headers).length ? { extra_headers: headers } : {}),
      models,
    });
    candidates.push({ provider: e.name, model: e.model ?? Object.keys(e.models)[0], key_env: e.key_env });
  }
  return { customProviders, env, modelAliases, candidates, warnings };
}
