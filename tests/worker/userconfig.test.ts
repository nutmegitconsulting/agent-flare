import { describe, expect, it } from "vitest";
import { accountConfigFor, checkConfigText, checkLoadable, saveBaseConfig, syncAccountConfig, inlineSecrets, loadRoleConfig, loadUserConfig, MAX_CONFIG_BYTES, saveRoleConfig, saveUserConfig } from "../../src/userconfig";

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

describe("accountConfigFor", () => {
  const restored = "custom_providers:\n- name: mine\n  key_env: MY_KEY\n";
  const roleDoc = "custom_providers:\n- name: role-gateway\n";

  it("seeds an account from the config.yaml its backup restored, not from the role", async () => {
    const { bucket, objects } = fakeBucket();
    await saveRoleConfig(bucket, "dev-team", roleDoc);
    expect(await accountConfigFor(bucket, "sub-1", async () => restored, "dev-team")).toEqual({ text: restored });
    expect(objects.get("config/users/sub-1/config.yaml")).toBe(restored);
  });

  it("seeds from a restored config.yaml that an admin upload would refuse", async () => {
    const { bucket, objects } = fakeBucket();
    await saveRoleConfig(bucket, "dev-team", roleDoc);
    const withKey = "custom_providers:\n- name: mine\n  api_key: sk-pasted\n";
    expect(await accountConfigFor(bucket, "sub-1", async () => withKey, "dev-team")).toEqual({ text: withKey });
    expect(objects.get("config/users/sub-1/config.yaml")).toBe(withKey);
  });

  it("leaves a restored config.yaml that can't load in place, and never puts the role's over it", async () => {
    const { bucket, objects } = fakeBucket();
    await saveRoleConfig(bucket, "dev-team", roleDoc);
    const result = await accountConfigFor(bucket, "sub-1", async () => "a: [unclosed\n", "dev-team");
    expect(result.text).toBeNull();
    expect(result.warning).toContain("not valid YAML");
    expect(objects.has("config/users/sub-1/config.yaml")).toBe(false);
  });

  it("seeds a user who came back with no config.yaml from the role", async () => {
    const { bucket, objects } = fakeBucket();
    await saveRoleConfig(bucket, "dev-team", roleDoc);
    expect(await accountConfigFor(bucket, "sub-1", async () => null, "dev-team")).toEqual({ text: roleDoc });
    expect(objects.get("config/users/sub-1/config.yaml")).toBe(roleDoc);
    expect(await accountConfigFor(bucket, "sub-2", async () => null, null)).toEqual({ text: null });
  });

  it("seeds a new user from the base document when the role has none, or there is no role", async () => {
    const { bucket, objects } = fakeBucket();
    const base = "custom_providers:\n- name: everyone\n";
    await saveBaseConfig(bucket, base);
    await saveRoleConfig(bucket, "dev-team", roleDoc);
    expect(await accountConfigFor(bucket, "in-role", async () => null, "dev-team")).toEqual({ text: roleDoc });
    expect(await accountConfigFor(bucket, "other-role", async () => null, "no-document")).toEqual({ text: base });
    expect(await accountConfigFor(bucket, "no-role", async () => null, null)).toEqual({ text: base });
    expect(objects.get("config/users/no-role/config.yaml")).toBe(base);
    // Never over a restored file.
    expect(await accountConfigFor(bucket, "restored", async () => restored, null)).toEqual({ text: restored });
  });

  it("uses the account's stored document once there is one, without reading the container", async () => {
    const { bucket } = fakeBucket();
    await saveUserConfig(bucket, "sub-1", "model: stored\n");
    const read = async () => { throw new Error("the container's file was read"); };
    expect(await accountConfigFor(bucket, "sub-1", read, "dev-team")).toEqual({ text: "model: stored\n" });
  });

  it("uses the restored file over a stored document the last snapshot couldn't update", async () => {
    const { bucket, objects } = fakeBucket();
    await saveUserConfig(bucket, "sub-1", "model: behind\n");
    expect(await accountConfigFor(bucket, "sub-1", async () => restored, "dev-team", true)).toEqual({ text: restored });
    expect(objects.get("config/users/sub-1/config.yaml")).toBe(restored);
    // One that can't load stays in the container, and R2's older document isn't written over it.
    const broken = await accountConfigFor(bucket, "sub-1", async () => "a: 1\na: 2\n", "dev-team", true);
    expect(broken.text).toBeNull();
    expect(broken.warning).toBeDefined();
    expect(objects.get("config/users/sub-1/config.yaml")).toBe(restored);
    expect(await accountConfigFor(bucket, "sub-1", async () => null, "dev-team", true)).toEqual({ text: restored });
  });
});

describe("syncAccountConfig", () => {
  const key = "config/users/sub-1/config.yaml";

  it("the container's file wins at a snapshot, even one an admin upload would refuse", async () => {
    const { bucket, objects } = fakeBucket();
    await saveUserConfig(bucket, "sub-1", "model:\n  default: old\n");
    const edited = "model:\n  default: new\ncustom_providers:\n- name: mine\n  api_key: sk-pasted\n";
    expect(checkConfigText(edited).ok).toBe(false);
    expect(await syncAccountConfig(bucket, "sub-1", edited)).toBe("saved");
    expect(objects.get(key)).toBe(edited);
    const big = "notes: " + "a".repeat(MAX_CONFIG_BYTES) + "\n";
    expect(await syncAccountConfig(bucket, "sub-1", big)).toBe("saved");
    expect(objects.get(key)).toBe(big);
  });

  it("holds back only a file that couldn't load at the next boot", async () => {
    const { bucket, objects } = fakeBucket();
    await saveUserConfig(bucket, "sub-1", "model: kept\n");
    for (const broken of ["a: [unclosed\n", "- a\n- b\n", "a: 1\na: 2\n", ""]) {
      expect(await syncAccountConfig(bucket, "sub-1", broken)).toHaveProperty("refused");
      expect(checkLoadable(broken).ok).toBe(false);
    }
    expect(objects.get(key)).toBe("model: kept\n");
  });

  it("does nothing when the container has no file or the same file", async () => {
    const { bucket, objects } = fakeBucket();
    expect(await syncAccountConfig(bucket, "sub-1", null)).toBe("unchanged");
    await saveUserConfig(bucket, "sub-1", "model: same\n");
    expect(await syncAccountConfig(bucket, "sub-1", "model: same\n")).toBe("unchanged");
    expect(objects.size).toBe(1);
  });
});
