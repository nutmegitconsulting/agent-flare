/**
 * AI Gateway custom providers, delivered through config templates.
 *
 * Validates a template's `providers` list and turns it into config.yaml `custom_providers`
 * entries plus the .env values they read. Credentials never go in the template:
 *
 * - `api_token`: the account-scoped endpoint. Credential is the Worker secret
 *   CLOUDFLARE_AI_API_TOKEN (Workers AI:Read), routed per gateway by the cf-aig-gateway-id header.
 * - `user_env`: the value comes from the user, as an admin prefill or the user's own .env.
 *   Nothing is injected; the entry just names the variable.
 */

export interface ProviderModelInfo {
  context_length?: number;
  max_length?: number;
}

export interface GatewayProviderEntry {
  /** Display name. Must match the model prefix `@<name>/`. */
  name: string;
  mode: "api_token" | "user_env";
  base_url: string;
  /** .env variable holding the credential. Entries must not collide. */
  key_env: string;
  /** api_token mode: gateway slug for the cf-aig-gateway-id header. */
  gateway_id?: string;
  /** chat_completions (default), responses, anthropic, bedrock_converse or auto. */
  api_mode?: string;
  discover_models?: boolean;
  extra_headers?: Record<string, string>;
  models: Record<string, ProviderModelInfo>;
  /** Per-entry default model. */
  model?: string;
}

const API_MODES = new Set(["chat_completions", "responses", "anthropic", "bedrock_converse", "auto"]);
const ENV_VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
    if (typeof e.name !== "string" || !e.name.trim()) return { ok: false, error: `${at}.name is required` };
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
    if (typeof e.models !== "object" || e.models === null || Array.isArray(e.models) ||
        Object.keys(e.models).length === 0) {
      return { ok: false, error: `${at}.models must be a non-empty object` };
    }
    entries.push({
      name: e.name.trim(),
      mode: e.mode,
      base_url: e.base_url,
      key_env: e.key_env,
      ...(e.gateway_id ? { gateway_id: e.gateway_id.trim() } : {}),
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
  defaultModel: string | null;
  warnings: string[];
}

/**
 * `user` tags api_token requests with the caller's identity (cf-aig-metadata), so AI Gateway
 * analytics and logs stay per user even though the credential is shared.
 */
export function renderProviders(entries: GatewayProviderEntry[], aiApiToken: string, user: string): RenderedProviders {
  const customProviders: Record<string, unknown>[] = [];
  const env: Record<string, string> = {};
  const warnings: string[] = [];
  let defaultModel: string | null = null;
  for (const e of entries) {
    if (e.mode === "api_token") {
      if (!aiApiToken) {
        warnings.push(`provider "${e.name}": Worker secret CLOUDFLARE_AI_API_TOKEN is not set; skipped`);
        continue;
      }
      env[e.key_env] = aiApiToken;
    }
    const headers: Record<string, string> = { ...e.extra_headers };
    if (e.mode === "api_token" && e.gateway_id) {
      headers["cf-aig-gateway-id"] = e.gateway_id;
      headers["cf-aig-metadata"] = JSON.stringify({ user });
    }
    customProviders.push({
      name: e.name,
      base_url: e.base_url,
      key_env: e.key_env,
      ...(e.model ? { model: e.model } : {}),
      api_mode: e.api_mode ?? "chat_completions",
      discover_models: e.discover_models === true,
      ...(Object.keys(headers).length ? { extra_headers: headers } : {}),
      models: e.models,
    });
    if (e.model && !defaultModel) defaultModel = e.model;
  }
  return { customProviders, env, defaultModel, warnings };
}
