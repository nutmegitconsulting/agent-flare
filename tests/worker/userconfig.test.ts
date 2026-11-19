import { describe, expect, it } from "vitest";
import { checkConfigText, inlineSecrets, loadRoleConfig, loadUserConfig, MAX_CONFIG_BYTES, saveRoleConfig, saveUserConfig } from "../../src/userconfig";

function fakeBucket() {
  const objects = new Map<string, string>();
  const bucket = {
    get: async (key: string) => objects.has(key) ? { text: async () => objects.get(key)! } : null,
    put: async (key: string, value: string) => void objects.set(key, value),
  } as unknown as R2Bucket;
  return { bucket, objects };
}

describe("checkConfigText", () => {
  it("accepts a mapping, including the _config_version Hermes writes", () => {
    const text = "model:\n  default: m\n_config_version: 52\n";
    expect(checkConfigText(text)).toEqual({ ok: true, text });
  });

  it("refuses what can't be a config file", () => {
    expect(checkConfigText("").ok).toBe(false);
    expect(checkConfigText("- a\n- b\n")).toMatchObject({ ok: false, error: "config.yaml must be a mapping of keys at the top level" });
    expect(checkConfigText("a: [unclosed\n")).toMatchObject({ ok: false });
    expect(checkConfigText("a: 1\na: 2\n").ok).toBe(false);
    expect(checkConfigText("x: " + "a".repeat(MAX_CONFIG_BYTES)).ok).toBe(false);
  });

  it("refuses a literal credential and names where it belongs", () => {
    const result = checkConfigText("custom_providers:\n- name: gw\n  api_key: sk-live-123\n");
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? "" : result.error).toContain(".env");
    expect(result.ok ? "" : result.error).toContain("custom_providers[0].api_key");
  });

  it("allows environment references and empty keys", () => {
    expect(checkConfigText("p:\n  api_key: ${GW_KEY}\n  password: ''\n").ok).toBe(true);
    expect(checkConfigText("p:\n  key_env: GW_KEY\n").ok).toBe(true);
  });
});

describe("inlineSecrets", () => {
  it("walks nested mappings and lists, ignoring numbers and names that only look alike", () => {
    expect(inlineSecrets({ a: { token: "t" }, b: [{ Secret: "s" }], c: { token: 4096 }, max_tokens: "x" }))
      .toEqual(["a.token", "b[0].Secret"]);
  });
});

describe("storage", () => {
  it("keeps each account's document and each role's apart", async () => {
    const { bucket, objects } = fakeBucket();
    await saveUserConfig(bucket, "sub-1", "model: a\n");
    await saveRoleConfig(bucket, "staff", "model: b\n");
    expect(await loadUserConfig(bucket, "sub-1")).toBe("model: a\n");
    expect(await loadUserConfig(bucket, "sub-2")).toBeNull();
    expect(await loadRoleConfig(bucket, "staff")).toBe("model: b\n");
    expect([...objects.keys()].sort()).toEqual(["config/users/sub-1/config.yaml", "templates/staff/config.yaml"]);
  });
});
