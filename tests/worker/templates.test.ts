import { describe, expect, it } from "vitest";
import { renderProviders, validateProviders } from "../../src/providers";
import { fetchAccessGroups, loadTemplate, pickTemplate, resolveEnv, templateSecrets } from "../../src/templates";

function fakeBucket(objects: Record<string, string>) {
  return {
    get: async (key: string) => key in objects ? {
      json: async () => JSON.parse(objects[key]),
      arrayBuffer: async () => new TextEncoder().encode(objects[key]).buffer,
    } : null,
  } as unknown as R2Bucket;
}

describe("pickTemplate", () => {
  const assignments = {
    default: "base",
    users: { "Boss@Example.com": "exec" },
    groups: { engineers: "eng" },
    domains: { "contractor.com": "limited" },
  };
  it("prefers exact email, then group, then domain, then default", () => {
    expect(pickTemplate(assignments, "boss@example.com", ["engineers"])).toBe("exec");
    expect(pickTemplate(assignments, "a@example.com", ["engineers"])).toBe("eng");
    expect(pickTemplate(assignments, "a@contractor.com")).toBe("limited");
    expect(pickTemplate(assignments, "a@example.com")).toBe("base");
  });
  it("returns null with no assignments or no match", () => {
    expect(pickTemplate(null, "a@b.com")).toBeNull();
    expect(pickTemplate({ users: {} }, "a@b.com")).toBeNull();
  });
});

describe("resolveEnv", () => {
  it("reads $NAME from Worker secrets, and reports unset ones without leaking", () => {
    const warnings: string[] = [];
    const out = resolveEnv({ A: "plain", B: "$SHARED", C: "$MISSING" }, { SHARED: "s3cret" }, warnings);
    expect(out).toEqual({ A: "plain", B: "s3cret" });
    expect(warnings).toEqual(["env C: Worker secret MISSING is not set or not in TEMPLATE_SECRETS; skipped"]);
  });
  it("rejects values that could inject extra .env lines", () => {
    const warnings: string[] = [];
    expect(resolveEnv({ A: "x\nEVIL=1", "B C": "y" }, {}, warnings)).toEqual({});
    expect(warnings).toHaveLength(2);
  });
});

describe("templateSecrets", () => {
  it("exposes only listed secrets, and never MASTER_KEY", () => {
    const env = { TEMPLATE_SECRETS: "A, MASTER_KEY", A: "a", B: "b", MASTER_KEY: "m" };
    expect(templateSecrets(env)).toEqual({ A: "a" });
    expect(templateSecrets({})).toEqual({});
  });
});

describe("loadTemplate", () => {
  it("loads files and refuses unsafe paths", async () => {
    const bucket = fakeBucket({
      "templates/t/template.json": JSON.stringify({
        files: ["SOUL.md", "../../etc/passwd", "/abs", "missing.md"],
        config_defaults: { model: "a" }, config_managed: { x: 1 },
      }),
      "templates/t/files/SOUL.md": "hello",
    });
    const template = await loadTemplate(bucket, "t", {});
    expect(template?.files.map((f) => f.path)).toEqual(["SOUL.md"]);
    expect(atob(template!.files[0].content)).toBe("hello");
    expect(template?.warnings).toHaveLength(3);
  });
  it("refuses a template name that could escape its prefix", async () => {
    await expect(loadTemplate(fakeBucket({}), "../users", {})).rejects.toThrow("invalid template name");
  });
  it("returns null when absent", async () => {
    expect(await loadTemplate(fakeBucket({}), "nope", {})).toBeNull();
  });
});

describe("fetchAccessGroups", () => {
  it("reads group names, and treats any failure as none", async () => {
    const ok = (async () => new Response(JSON.stringify({ groups: [{ name: "eng" }, {}] }))) as unknown as typeof fetch;
    expect(await fetchAccessGroups("https://t", "jwt", ok)).toEqual(["eng"]);
    const bad = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
    expect(await fetchAccessGroups("https://t", "jwt", bad)).toEqual([]);
  });
});

describe("providers", () => {
  const entry = {
    name: "gw", mode: "api_token", base_url: "https://x/v1", key_env: "GW_KEY",
    gateway_id: "g1", model: "m1", models: { m1: { context_length: 10 } },
  };
  it("validates", () => {
    expect(validateProviders([entry]).ok).toBe(true);
    expect(validateProviders([{ ...entry, base_url: "http://x" }]).ok).toBe(false);
    expect(validateProviders([entry, entry]).ok).toBe(false);
    expect(validateProviders([{ ...entry, gateway_id: undefined }]).ok).toBe(false);
  });
  it("renders the credential only into env, never config", () => {
    const parsed = validateProviders([entry]);
    if (!parsed.ok) throw new Error(parsed.error);
    const rendered = renderProviders(parsed.entries, "tok", "a@b.com");
    expect(rendered.env).toEqual({ GW_KEY: "tok" });
    expect(JSON.stringify(rendered.customProviders)).not.toContain("tok");
    expect(rendered.customProviders[0].extra_headers).toEqual({
      "cf-aig-gateway-id": "g1", "cf-aig-metadata": JSON.stringify({ user: "a@b.com" }),
    });
    expect(rendered.defaultModel).toBe("m1");
  });
  it("skips api_token entries when the Worker secret is unset", () => {
    const parsed = validateProviders([entry]);
    if (!parsed.ok) throw new Error(parsed.error);
    const rendered = renderProviders(parsed.entries, "", "a@b.com");
    expect(rendered.customProviders).toEqual([]);
    expect(rendered.warnings).toHaveLength(1);
  });
});
