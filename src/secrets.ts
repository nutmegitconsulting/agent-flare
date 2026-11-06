/**
 * Per-user secrets. One Worker holds at most 128 secrets and vars combined, so a secret per
 * user doesn't scale. Instead a single MASTER_KEY lives in Worker Secrets, and everything
 * per-user is either derived from it or stored in KV encrypted with a key derived from it.
 *
 * KV layout (values are "v1.<iv>.<ciphertext>", base64url, AES-256-GCM):
 *   sealed:files:<sub>     the user's secret files from their container (.env, auth.json, ...).
 *                          The user's Durable Object keeps a copy for strongly consistent reads.
 *   sealed:prefill:<email> values an admin set before the user's first login
 *
 * The KV key is bound into the ciphertext as additional data, so a value copied to another
 * user's key won't decrypt.
 */

const encoder = new TextEncoder();

function toB64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

async function hkdfBits(masterKey: string, info: string, bits: number): Promise<Uint8Array> {
  if (!masterKey || masterKey.length < 32) throw new Error("MASTER_KEY must be set (32+ characters)");
  const base = await crypto.subtle.importKey("raw", encoder.encode(masterKey), "HKDF", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode("agent-flare-v1"), info: encoder.encode(info) },
    base, bits);
  return new Uint8Array(derived);
}

/** A stable per-user secret that is never stored anywhere. */
export async function deriveUserSecret(masterKey: string, purpose: string, sub: string): Promise<string> {
  return toB64Url(await hkdfBits(masterKey, `${purpose}:${sub}`, 256));
}

async function aesKey(masterKey: string, kvKey: string): Promise<CryptoKey> {
  const raw = await hkdfBits(masterKey, `seal:${kvKey}`, 256);
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(masterKey: string, kvKey: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(masterKey, kvKey);
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(kvKey) }, key, encoder.encode(plaintext));
  return `v1.${toB64Url(iv)}.${toB64Url(new Uint8Array(cipher))}`;
}

export async function unseal(masterKey: string, kvKey: string, sealed: string): Promise<string> {
  const [version, iv, cipher] = sealed.split(".");
  if (version !== "v1" || !iv || !cipher) throw new Error(`unrecognized sealed value at ${kvKey}`);
  const key = await aesKey(masterKey, kvKey);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64Url(iv), additionalData: encoder.encode(kvKey) }, key, fromB64Url(cipher));
  return new TextDecoder().decode(plain);
}

export async function putSealed(kv: KVNamespace, masterKey: string, kvKey: string, value: unknown): Promise<void> {
  await kv.put(kvKey, await seal(masterKey, kvKey, JSON.stringify(value)));
}

export async function getSealed<T>(kv: KVNamespace, masterKey: string, kvKey: string): Promise<T | null> {
  const raw = await kv.get(kvKey);
  return raw ? (JSON.parse(await unseal(masterKey, kvKey, raw)) as T) : null;
}

export const sealedFilesKey = (sub: string) => `sealed:files:${sub}`;
export const prefillKey = (email: string) => `sealed:prefill:${email.toLowerCase()}`;
