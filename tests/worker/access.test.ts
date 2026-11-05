import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearJwksCache, verifyAccessJwt } from "../../src/access";

const TEAM = "team.cloudflareaccess.com";
const AUD = "test-aud";
const ISS = `https://${TEAM}`;
const b64 = (data: string | Uint8Array) =>
  Buffer.from(data as never).toString("base64url");

let keys: CryptoKeyPair;
let jwks: string;

async function sign(claims: object, header: object = { alg: "RS256", kid: "k1" }, key = keys.privateKey) {
  const body = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(claims))}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(body));
  return `${body}.${b64(new Uint8Array(signature))}`;
}

const good = () => ({
  iss: ISS, aud: [AUD], sub: "user-1", email: "Alice@Example.com",
  exp: Math.floor(Date.now() / 1000) + 600,
});
const config = () => ({ teamDomain: TEAM, audience: AUD, jwksJson: jwks });
const generate = () => crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true, ["sign", "verify"]) as Promise<CryptoKeyPair>;

beforeAll(async () => {
  keys = await generate();
  jwks = JSON.stringify({ keys: [{ ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "k1" }] });
});
beforeEach(clearJwksCache);

describe("verifyAccessJwt", () => {
  it("accepts a valid token and keys identity on sub", async () => {
    const identity = await verifyAccessJwt(await sign(good()), config());
    expect(identity).toMatchObject({ sub: "user-1", email: "alice@example.com", issuer: ISS });
  });

  it("rejects a token signed by another key", async () => {
    const other = await generate();
    await expect(verifyAccessJwt(await sign(good(), undefined, other.privateKey), config()))
      .rejects.toThrow("invalid signature");
  });

  it("rejects tampered claims", async () => {
    const [h, , s] = (await sign(good())).split(".");
    const forged = `${h}.${b64(JSON.stringify({ ...good(), sub: "victim" }))}.${s}`;
    await expect(verifyAccessJwt(forged, config())).rejects.toThrow("invalid signature");
  });

  it("rejects alg none and opaque tokens", async () => {
    const none = `${b64(JSON.stringify({ alg: "none", kid: "k1" }))}.${b64(JSON.stringify(good()))}.`;
    await expect(verifyAccessJwt(none, config())).rejects.toThrow("algorithm");
    await expect(verifyAccessJwt("opaque-token", config())).rejects.toThrow("malformed");
  });

  it("rejects wrong issuer, audience, expired and not-yet-valid", async () => {
    await expect(verifyAccessJwt(await sign({ ...good(), iss: "https://evil.cloudflareaccess.com" }), config()))
      .rejects.toThrow("issuer");
    await expect(verifyAccessJwt(await sign({ ...good(), aud: ["other"] }), config())).rejects.toThrow("audience");
    await expect(verifyAccessJwt(await sign({ ...good(), exp: 1000 }), config())).rejects.toThrow("expired");
    const later = Math.floor(Date.now() / 1000) + 3600;
    await expect(verifyAccessJwt(await sign({ ...good(), nbf: later }), config())).rejects.toThrow("not yet");
  });

  it("rejects service tokens, which have no user", async () => {
    await expect(verifyAccessJwt(await sign({ ...good(), sub: "", email: undefined }), config()))
      .rejects.toThrow("no user identity");
  });

  it("refuses to run unconfigured", async () => {
    await expect(verifyAccessJwt(await sign(good()), { teamDomain: "", audience: "" }))
      .rejects.toThrow("configured");
  });

  it("refetches keys once on an unknown kid, for rotation", async () => {
    let fetches = 0;
    const fetcher = (async () => {
      fetches++;
      return new Response(fetches === 1 ? JSON.stringify({ keys: [] }) : jwks);
    }) as unknown as typeof fetch;
    const identity = await verifyAccessJwt(await sign(good()), { teamDomain: TEAM, audience: AUD, fetcher });
    expect(identity.sub).toBe("user-1");
    expect(fetches).toBe(2);
  });

  it("keeps two people with the same email local part apart", async () => {
    const a = await verifyAccessJwt(await sign({ ...good(), sub: "a", email: "sam@one.com" }), config());
    const b = await verifyAccessJwt(await sign({ ...good(), sub: "b", email: "sam@two.com" }), config());
    expect(a.sub).not.toBe(b.sub);
  });
});
