import { describe, expect, it } from "vitest";
import {
  bootKeyStatuses, clearEnvValue, clearProviderKey, envStatuses, keyStatus, resolveEnv, resolveProviderKey, setEnvValue,
  setProviderKey,
} from "../../src/credentials";
import { applyOverride, configFingerprint, resolveEffective, withGateway } from "../../src/effective";
import type { Env } from "../../src/env";
import type { GatewayProviderEntry } from "../../src/providers";

function fakeBucket(objects: Record<string, string>) {
  return {
    get: async (key: string) => key in objects ? {
      json: async () => JSON.parse(objects[key]),
      arrayBuffer: async () => new TextEncoder().encode(objects[key]).buffer,
    } : null,
  } as unknown as R2Bucket;
}

function fakeKv() {
  const store = new Map<string, { value: string; metadata: unknown }>();
  return {
    store,
    kv: {
      get: async (k: string) => store.get(k)?.value ?? null,
      getWithMetadata: async (k: string) => ({ value: store.get(k)?.value ?? null, metadata: store.get(k)?.metadata ?? null }),
      put: async (k: string, value: string, o?: { metadata?: unknown }) => void store.set(k, { value, metadata: o?.metadata }),
      delete: async (k: string) => void store.delete(k),
      list: async ({ prefix }: { prefix: string }) => ({
        keys: [...store].filter(([k]) => k.startsWith(prefix)).map(([name, v]) => ({ name, metadata: v.metadata })),
        list_complete: true,
      }),
    } as unknown as KVNamespace,
  };
}

const provider = (over: Partial<GatewayProviderEntry> = {}): GatewayProviderEntry => ({
  name: "gw", mode: "api_token", base_url: "https://gateway.ai.cloudflare.com/v1/acct/default/compat",
  key_env: "GW_KEY", gateway_id: "default", model: "a", models: { a: { context_length: 10 }, b: {} }, ...over,
});

const template = (model: string) => JSON.stringify({ providers: [{ ...provider(), model, models: { [model]: {} } }] });

describe("precedence", () => {
  const objects = {
    "config/assignments.json": JSON.stringify({ default: "base", users: { "eng@x.com": "engineers" }, domains: { "corp.com": "corp" } }),
    "templates/base/template.json": template("base-model"),
    "templates/corp/template.json": template("corp-model"),
    "templates/engineers/template.json": template("eng-model"),
    "templates/special/template.json": template("special-model"),
    "config/overrides/over@x.com.json": JSON.stringify({ role: "special" }),
    "config/overrides/eng@x.com.json": JSON.stringify({ role: "special", default_model: "special-model" }),
  };
  const bucket = fakeBucket(objects);
  it("goes override, then role, then assignments", async () => {
    expect(await resolveEffective(bucket, "over@x.com", [], {})).toMatchObject({ role: "special", source: "override" });
    expect(await resolveEffective(bucket, "ENG@x.com", [], {})).toMatchObject({ role: "special", source: "override" });
    const role = await resolveEffective(fakeBucket({ ...objects, "config/overrides/eng@x.com.json": "{}" }), "eng@x.com", [], {});
    expect(role).toMatchObject({ role: "engineers", source: "role" });
    expect(await resolveEffective(bucket, "a@corp.com", [], {})).toMatchObject({ role: "corp", source: "assignment" });
    expect(await resolveEffective(bucket, "a@other.com", [], {})).toMatchObject({ role: "base", source: "assignment" });
    expect(await resolveEffective(fakeBucket({}), "a@other.com", [], {})).toMatchObject({ role: null, source: "none" });
  });
});

describe("overrides", () => {
  it("change the gateway in both the header and the URL", () => {
    const [p] = applyOverride([provider()], { gateway_id: "eng" });
    expect(p.gateway_id).toBe("eng");
    expect(p.base_url).toBe("https://gateway.ai.cloudflare.com/v1/acct/eng/compat");
    expect(withGateway("https://other.example/v1", "eng")).toBe("https://other.example/v1");
  });
  it("replace the model list, keeping what's known about a model", () => {
    const [p] = applyOverride([provider()], { models: ["a", "c"] });
    expect(p.models).toEqual({ a: { context_length: 10 }, c: {} });
    expect(p.model).toBe("a");
    expect(applyOverride([provider()], { models: ["c"] })[0].model).toBeUndefined();
    expect(applyOverride([provider()], { default_model: "b" })[0].model).toBe("b");
    expect(applyOverride([provider()], { default_model: "not-listed" })[0].model).toBe("a");
  });
  it("leave entries alone when there are none", () => {
    expect(applyOverride([provider()], null)).toEqual([provider()]);
  });
});

describe("environment variables set by name", () => {
  const env = () => {
    const { kv, store } = fakeKv();
    return { env: { CREDENTIALS_KV: kv, MASTER_KEY: "m".repeat(40) } as Env, store };
  };
  it("need no role: one for everyone reaches every account, and a user's own is theirs alone", async () => {
    const { env: e } = env();
    await setEnvValue(e, { kind: "base" }, "TEAM_GATEWAY_API_KEY", "shared");
    await setEnvValue(e, { kind: "user", email: "A@x.com" }, "TEAM_GATEWAY_API_KEY", "mine");
    await setEnvValue(e, { kind: "user", email: "a@x.com" }, "OTHER", "o");
    expect(await resolveEnv(e, "a@x.com")).toEqual({ base: { TEAM_GATEWAY_API_KEY: "shared" }, user: { OTHER: "o", TEAM_GATEWAY_API_KEY: "mine" } });
    expect(await resolveEnv(e, "b@x.com")).toEqual({ base: { TEAM_GATEWAY_API_KEY: "shared" }, user: {} });
    await clearEnvValue(e, { kind: "user", email: "a@x.com" }, "TEAM_GATEWAY_API_KEY");
    expect((await resolveEnv(e, "a@x.com")).user).toEqual({ OTHER: "o" });
  });
  it("are sealed in KV, and the listing holds names and times only", async () => {
    const { env: e, store } = env();
    await setEnvValue(e, { kind: "base" }, "TEAM_GATEWAY_API_KEY", "plain-env-value");
    expect(JSON.stringify([...store])).not.toContain("plain-env-value");
    const statuses = await envStatuses(e, { kind: "base" });
    expect(Object.keys(statuses)).toEqual(["TEAM_GATEWAY_API_KEY"]);
    expect(statuses.TEAM_GATEWAY_API_KEY).toMatch(/^20/);
  });
  it("change the boot fingerprint only once one is set", async () => {
    const { env: e } = env();
    const before = await bootKeyStatuses(e, "a@x.com", null, []);
    expect(before).toEqual({});
    await setEnvValue(e, { kind: "base" }, "K", "v");
    const eff = await resolveEffective(fakeBucket({}), "a@x.com", [], {});
    expect(await configFingerprint(eff, await bootKeyStatuses(e, "a@x.com", null, []))).not.toBe(await configFingerprint(eff, before));
  });
});

describe("provider keys", () => {
  const env = (extra: Partial<Env> = {}) => {
    const { kv, store } = fakeKv();
    return { env: { CREDENTIALS_KV: kv, MASTER_KEY: "m".repeat(40), ...extra } as Env, store };
  };
  it("go user, then role, then Worker secret", async () => {
    const { env: e } = env({ CLOUDFLARE_AI_API_TOKEN: "from-secret" });
    expect(await resolveProviderKey(e, "a@x.com", "eng", provider())).toBe("from-secret");
    expect((await keyStatus(e, "a@x.com", "eng", provider())).source).toBe("worker-secret");
    await setProviderKey(e, { kind: "role", role: "eng" }, "gw", "from-role");
    expect(await resolveProviderKey(e, "a@x.com", "eng", provider())).toBe("from-role");
    expect((await keyStatus(e, "a@x.com", "eng", provider())).source).toBe("role");
    await setProviderKey(e, { kind: "user", email: "A@x.com" }, "gw", "from-user");
    expect(await resolveProviderKey(e, "a@x.com", "eng", provider())).toBe("from-user");
    const status = await keyStatus(e, "a@x.com", "eng", provider());
    expect(status.source).toBe("user");
    expect(status.changedAt).toMatch(/^20/);
    await clearProviderKey(e, { kind: "user", email: "a@x.com" }, "gw");
    expect(await resolveProviderKey(e, "a@x.com", "eng", provider())).toBe("from-role");
  });
  it("are sealed in KV, and status holds no value", async () => {
    const { env: e, store } = env();
    await setProviderKey(e, { kind: "user", email: "a@x.com" }, "gw", "plain-key-value");
    expect(JSON.stringify([...store.entries()])).not.toContain("plain-key-value");
    expect(JSON.stringify(await keyStatus(e, "a@x.com", null, provider()))).not.toContain("plain-key-value");
  });
  it("can't be read across users", async () => {
    const { env: e } = env();
    await setProviderKey(e, { kind: "user", email: "a@x.com" }, "gw", "alices");
    expect(await resolveProviderKey(e, "b@x.com", null, provider())).toBe("");
  });
  it("never come from MASTER_KEY, or from a secret not listed", async () => {
    const { env: e } = env({ OTHER: "v" } as Partial<Env>);
    expect(await resolveProviderKey(e, "a@x.com", null, provider({ credential: "MASTER_KEY" }))).toBe("");
    expect(await resolveProviderKey(e, "a@x.com", null, provider({ credential: "OTHER" }))).toBe("");
    const listed = env({ OTHER: "v", TEMPLATE_SECRETS: "OTHER" } as Partial<Env>).env;
    expect(await resolveProviderKey(listed, "a@x.com", null, provider({ credential: "OTHER" }))).toBe("v");
  });
  it("aren't borrowed by a user_env provider from a default secret", async () => {
    const { env: e } = env({ CLOUDFLARE_AI_API_TOKEN: "shared" });
    expect(await resolveProviderKey(e, "a@x.com", null, provider({ mode: "user_env" }))).toBe("");
  });
});

describe("pending state", () => {
  const effective = (over = {}) => ({ role: "r", source: "role" as const, override: null, template: null, providers: [provider()], ...over });
  it("notices a role, model or key change, and only those", async () => {
    const base = await configFingerprint(effective(), { gw: { source: "worker-secret", changedAt: null } });
    expect(await configFingerprint(effective(), { gw: { source: "worker-secret", changedAt: null } })).toBe(base);
    expect(await configFingerprint(effective({ role: "other" }), { gw: { source: "worker-secret", changedAt: null } })).not.toBe(base);
    expect(await configFingerprint(effective({ providers: [provider({ model: "b" })] }), { gw: { source: "worker-secret", changedAt: null } })).not.toBe(base);
    expect(await configFingerprint(effective(), { gw: { source: "user", changedAt: "2026-11-05" } })).not.toBe(base);
  });
});
