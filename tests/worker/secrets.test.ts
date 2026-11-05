import { describe, expect, it } from "vitest";
import { deriveUserSecret, seal, unseal } from "../../src/secrets";

const MASTER = "m".repeat(40);

describe("sealing", () => {
  it("round trips", async () => {
    const sealed = await seal(MASTER, "sealed:files:a", "secret value");
    expect(sealed).not.toContain("secret value");
    expect(await unseal(MASTER, "sealed:files:a", sealed)).toBe("secret value");
  });
  it("won't open under another user's key", async () => {
    const sealed = await seal(MASTER, "sealed:files:a", "secret");
    await expect(unseal(MASTER, "sealed:files:b", sealed)).rejects.toThrow();
  });
  it("won't open with another master key", async () => {
    const sealed = await seal(MASTER, "k", "secret");
    await expect(unseal("x".repeat(40), "k", sealed)).rejects.toThrow();
  });
  it("detects tampering", async () => {
    const sealed = await seal(MASTER, "k", "secret");
    const flipped = sealed.slice(0, -2) + (sealed.endsWith("AA") ? "BB" : "AA");
    await expect(unseal(MASTER, "k", flipped)).rejects.toThrow();
  });
  it("refuses a weak or missing master key", async () => {
    await expect(seal("short", "k", "v")).rejects.toThrow("MASTER_KEY");
  });
});

describe("deriveUserSecret", () => {
  it("is stable, per user and per purpose", async () => {
    const a = await deriveUserSecret(MASTER, "webapp-browser", "a");
    expect(await deriveUserSecret(MASTER, "webapp-browser", "a")).toBe(a);
    expect(await deriveUserSecret(MASTER, "webapp-browser", "b")).not.toBe(a);
    expect(await deriveUserSecret(MASTER, "webapp-auth", "a")).not.toBe(a);
  });
  it("matches the 43-character format the Hermes webapp requires", async () => {
    expect(await deriveUserSecret(MASTER, "webapp-browser", "a")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
